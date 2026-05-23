const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOST = '127.0.0.1';
const PORT = Number(process.env.DX_LIGHT_BRIDGE_PORT || 8787);
const HID_MODULE_PATH = 'C:/Program Files/DX Light/resources/app.asar.unpacked/node_modules/node-hid/prebuilds/HID-win32-x64/node-napi-v3.node';
const APP_NAME = 'DX Light Screen Sync';
const STARTUP_SCRIPT_NAME = 'DX Light Screen Sync Bridge.vbs';
const VID = 0x1a86;
const PID = 0xfe07;
const CONTROL_USAGE_PAGE = 0xff00;
const REPORT_ID = 0;
const MAX_HID_PAYLOAD_BYTES = 64;
const READ_DEVICE_INFO = 0x82;
const SET_SYNC_SCREEN = 0x80;
const AUTO_CONNECT_RETRY_MS = 5000;
const MEDIA_CONTEXT_TIMEOUT_MS = 1200;

let hid;
let device = null;
let deviceInfo = null;
let messageId = 1;

try {
  hid = require(HID_MODULE_PATH);
} catch (error) {
  console.error(`Failed to load node-hid native module: ${error.message}`);
  process.exit(1);
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === 'OPTIONS') {
      if (!isTrustedRequest(request)) {
        sendJson(response, 403, { error: 'DX Light bridge rejected an untrusted browser origin.' });
        return;
      }
      sendNoContent(response);
      return;
    }

    if (!isTrustedRequest(request)) {
      sendJson(response, 403, { error: 'DX Light bridge rejected an untrusted browser origin.' });
      return;
    }

    const url = new URL(request.url || '/', `http://${HOST}:${PORT}`);
    if (request.method === 'GET' && url.pathname === '/status') {
      const target = findControlDevice();
      sendJson(response, 200, {
        bridge: true,
        available: Boolean(target),
        connected: Boolean(device),
        info: deviceInfo,
        device: target ? summarizeDevice(target) : null
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/connect') {
      const info = connect();
      sendJson(response, 200, { connected: true, info });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/disconnect') {
      disconnect();
      sendJson(response, 200, { connected: false });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/frame') {
      const body = await readJson(request);
      const result = writeFrame(body && body.frame);
      sendJson(response, 200, result);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/startup') {
      sendJson(response, 200, getStartupStatus());
      return;
    }

    if (request.method === 'POST' && url.pathname === '/startup') {
      const body = await readJson(request);
      const enabled = Boolean(body && body.enabled);
      setStartupEnabled(enabled);
      sendJson(response, 200, getStartupStatus());
      return;
    }

    if (request.method === 'GET' && url.pathname === '/settings') {
      sendJson(response, 200, { settings: readSettings() });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/settings') {
      const body = await readJson(request);
      const settings = body && body.settings;
      writeSettings(settings);
      sendJson(response, 200, { settings });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/open-browser') {
      openSystemBrowser(`http://${HOST}:${PORT}/`);
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/media-context') {
      sendJson(response, 200, await getMediaContext());
      return;
    }

    if (request.method === 'GET' && serveStaticAsset(url.pathname, response)) {
      return;
    }

    sendJson(response, 404, { error: 'Not found' });
  } catch (error) {
    sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`DX Light HID bridge listening on http://${HOST}:${PORT}`);
  tryAutoConnect();
  const retryTimer = setInterval(() => {
    if (!device) {
      tryAutoConnect();
    }
  }, AUTO_CONNECT_RETRY_MS);
  retryTimer.unref?.();
});

process.on('SIGINT', () => {
  disconnect();
  process.exit(0);
});

process.on('SIGTERM', () => {
  disconnect();
  process.exit(0);
});

function connect() {
  if (device && deviceInfo) {
    return deviceInfo;
  }

  disconnect();
  const target = findControlDevice();
  if (!target) {
    throw new Error('DX Light USB HID control interface was not found.');
  }

  device = new hid.HID(target.path);
  deviceInfo = readDeviceInfo(device);
  return deviceInfo;
}

function tryAutoConnect() {
  const target = findControlDevice();
  if (!target) {
    console.log('No DX Light control HID interface detected yet.');
    return;
  }

  console.log(`Detected ${target.manufacturer || 'ROBOBLOQ'} ${target.product || 'USBHID'} VID_${VID.toString(16)} PID_${PID.toString(16)}`);
  try {
    const info = connect();
    console.log(`Connected DX Light ${info.lampsAmount} LEDs, firmware ${info.version}`);
  } catch (error) {
    console.log(`DX Light auto-connect failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function disconnect() {
  if (device) {
    turnOffDevice();
    try {
      device.close();
    } catch {
      // Device may already be gone; closing is best-effort.
    }
  }
  device = null;
  deviceInfo = null;
}

function writeFrame(frame) {
  if (!frame || !Array.isArray(frame.sections)) {
    throw new Error('Invalid LED frame payload.');
  }
  if (!device) {
    connect();
  }

  const startedAt = performanceNow();
  const write = writeFramePayload(frame);

  return {
    bytesWritten: write.bytesWritten,
    chunks: write.chunks,
    writeMs: performanceNow() - startedAt
  };
}

function writeFramePayload(frame) {
  const payload = createSyncScreenPayload(frame);
  const chunks = chunkPayload(payload, MAX_HID_PAYLOAD_BYTES);

  for (const chunk of chunks) {
    device.write([REPORT_ID, ...chunk]);
  }

  return {
    bytesWritten: payload.length,
    chunks: chunks.length
  };
}

function turnOffDevice() {
  const ledCount = Number(deviceInfo && deviceInfo.lampsAmount);
  if (!device || !Number.isFinite(ledCount) || ledCount <= 0) {
    return;
  }

  try {
    writeFramePayload(createSolidColorFrame(ledCount, { r: 0, g: 0, b: 0 }));
  } catch {
    // Shutdown and USB removal paths are best-effort.
  }
}

function createSolidColorFrame(ledCount, color) {
  const number = Number(ledCount);
  const safeLedCount = Number.isFinite(number) ? Math.max(1, Math.round(number)) : 1;
  return {
    ledCount: safeLedCount,
    sections: [
      {
        start: 1,
        end: safeLedCount,
        color
      }
    ]
  };
}

function readDeviceInfo(openDevice) {
  const packet = createReadDeviceInfoPayload();
  openDevice.write([REPORT_ID, ...packet]);
  const response = openDevice.readTimeout(1000);
  const data = normalizeReport(Buffer.from(response));
  if (data.length < 25 || data[0] !== 0x52 || data[1] !== 0x42 || data[4] !== READ_DEVICE_INFO) {
    throw new Error('DX Light did not return a valid device-info report.');
  }

  return {
    id: data.slice(5, 8).toString('hex'),
    displaySize: data[8],
    lampsAmount: data[11],
    uuid: data.slice(12, 20).toString('hex'),
    version: `${data[21]}.${data[22]}.${data[23]}`
  };
}

function createReadDeviceInfoPayload() {
  const packet = Buffer.alloc(6);
  packet.write('RB', 0, 2, 'utf8');
  packet.writeUInt8(6, 2);
  packet.writeUInt8(nextMessageId(), 3);
  packet.writeUInt8(READ_DEVICE_INFO, 4);
  packet.writeUInt8(checksum(packet), 5);
  return packet;
}

function createSyncScreenPayload(frame) {
  const sections = frame.sections;
  const packet = Buffer.alloc(7 + sections.length * 5);
  packet.writeUInt8(0x53, 0);
  packet.writeUInt8(0x43, 1);
  packet.writeUInt16BE(packet.length, 2);
  packet.writeUInt8(nextMessageId(), 4);
  packet.writeUInt8(SET_SYNC_SCREEN, 5);

  let offset = 6;
  for (const section of sections) {
    packet.writeUInt8(clampByte(section.start), offset);
    packet.writeUInt8(clampByte(section.color && section.color.r), offset + 1);
    packet.writeUInt8(clampByte(section.color && section.color.g), offset + 2);
    packet.writeUInt8(clampByte(section.color && section.color.b), offset + 3);
    packet.writeUInt8(clampByte(section.end), offset + 4);
    offset += 5;
  }

  packet.writeUInt8(checksum(packet), packet.length - 1);
  return packet;
}

function findControlDevice() {
  return hid.devices().find((item) => item.vendorId === VID && item.productId === PID && item.usagePage === CONTROL_USAGE_PAGE);
}

function summarizeDevice(item) {
  return {
    vendorId: item.vendorId,
    productId: item.productId,
    usagePage: item.usagePage,
    interface: item.interface,
    manufacturer: item.manufacturer,
    product: item.product
  };
}

function getStartupStatus() {
  if (process.platform !== 'win32') {
    return { supported: false, enabled: false, path: null };
  }

  const startupPath = getStartupScriptPath();
  return {
    supported: Boolean(startupPath),
    enabled: startupPath ? fs.existsSync(startupPath) : false,
    path: startupPath
  };
}

function setStartupEnabled(enabled) {
  if (process.platform !== 'win32') {
    throw new Error('Windows startup registration is only supported on Windows.');
  }

  const startupPath = getStartupScriptPath();
  if (!startupPath) {
    throw new Error('Windows Startup folder could not be resolved.');
  }

  fs.mkdirSync(path.dirname(startupPath), { recursive: true });

  if (!enabled) {
    if (fs.existsSync(startupPath)) {
      fs.unlinkSync(startupPath);
    }
    return;
  }

  fs.writeFileSync(startupPath, createStartupScript(), 'utf8');
}

function createStartupScript() {
  const command = `"${process.execPath}" "${__filename}"`;
  return [
    `' ${APP_NAME} startup launcher`,
    'Set shell = CreateObject("WScript.Shell")',
    `shell.CurrentDirectory = "${escapeVbsString(path.resolve(__dirname, '..'))}"`,
    `shell.Run "${escapeVbsString(command)}", 0, False`
  ].join('\r\n');
}

function getStartupScriptPath() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  if (!appData) {
    return null;
  }
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', STARTUP_SCRIPT_NAME);
}

function readSettings() {
  const settingsPath = getSettingsPath();
  if (!fs.existsSync(settingsPath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    return null;
  }
}

function writeSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('Invalid settings payload.');
  }

  const settingsPath = getSettingsPath();
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
}

function getSettingsPath() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, APP_NAME, 'settings.json');
}

function serveStaticAsset(requestPath, response) {
  const distRoot = path.resolve(__dirname, '..', 'dist');
  if (!fs.existsSync(distRoot)) {
    return false;
  }

  const safeRelativePath = getSafeRelativeStaticPath(requestPath);
  if (safeRelativePath === null) {
    sendJson(response, 403, { error: 'Invalid static path.' });
    return true;
  }

  const requestedFile = safeRelativePath === '' ? path.join(distRoot, 'index.html') : path.join(distRoot, safeRelativePath);
  const filePath = getStaticFilePath(distRoot, requestedFile);
  if (!filePath) {
    return false;
  }

  response.writeHead(200, {
    'Content-Type': contentTypeFor(filePath),
    'Cache-Control': path.basename(filePath) === 'index.html' ? 'no-store' : 'public, max-age=31536000, immutable'
  });
  fs.createReadStream(filePath).pipe(response);
  return true;
}

function openSystemBrowser(url) {
  if (process.platform === 'win32') {
    const child = spawn('cmd.exe', ['/c', 'start', '', url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.unref();
    return;
  }

  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(opener, [url], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
}

async function getMediaContext() {
  if (process.platform !== 'win32') {
    return {
      protectedLikely: false,
      mediaApp: null,
      source: 'unsupported-platform',
      matches: []
    };
  }

  return readWindowsMediaContext();
}

function readWindowsMediaContext() {
  const script = [
    '$matches = @(',
    '  Get-Process -ErrorAction SilentlyContinue |',
    '  Where-Object { $_.MainWindowTitle -and ($_.MainWindowTitle -match "Netflix|넷플릭스") } |',
    '  Select-Object -First 5 ProcessName,MainWindowTitle',
    ');',
    '$matches | ConvertTo-Json -Compress'
  ].join(' ');

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    const finish = (payload) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish({
        protectedLikely: false,
        mediaApp: null,
        source: 'window-title-timeout',
        matches: []
      });
    }, MEDIA_CONTEXT_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      finish({
        protectedLikely: false,
        mediaApp: null,
        source: 'window-title-error',
        matches: [],
        error: error.message
      });
    });
    child.on('close', () => {
      const matches = parseMediaContextMatches(stdout);
      finish({
        protectedLikely: matches.length > 0,
        mediaApp: matches.length > 0 ? 'netflix' : null,
        source: 'window-title',
        matches,
        error: stderr.trim() || undefined
      });
    });
  });
}

function parseMediaContextMatches(raw) {
  const text = String(raw || '').trim();
  if (!text) {
    return [];
  }

  try {
    const parsed = JSON.parse(text);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items
      .map((item) => ({
        processName: String(item.ProcessName || item.processName || ''),
        title: String(item.MainWindowTitle || item.title || '')
      }))
      .filter((item) => item.title);
  } catch {
    return [];
  }
}

function getSafeRelativeStaticPath(requestPath) {
  let decodedPath = '/';
  try {
    decodedPath = decodeURIComponent(requestPath);
  } catch {
    return null;
  }

  const relativePath = decodedPath.replace(/^\/+/, '');
  if (!relativePath) {
    return '';
  }

  const normalized = path.normalize(relativePath);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
    return null;
  }
  return normalized;
}

function getStaticFilePath(distRoot, requestedFile) {
  const relative = path.relative(distRoot, requestedFile);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }

  if (fs.existsSync(requestedFile) && fs.statSync(requestedFile).isFile()) {
    return requestedFile;
  }

  const indexPath = path.join(distRoot, 'index.html');
  return fs.existsSync(indexPath) ? indexPath : null;
}

function contentTypeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    default:
      return 'application/octet-stream';
  }
}

function isTrustedRequest(request) {
  const origin = request.headers.origin;
  if (!origin) {
    return true;
  }

  try {
    const url = new URL(origin);
    return (url.hostname === '127.0.0.1' || url.hostname === 'localhost') && (url.port === '5173' || url.port === String(PORT));
  } catch {
    return false;
  }
}

function escapeVbsString(value) {
  return String(value).replace(/"/g, '""');
}

function normalizeReport(data) {
  if (data[0] === 0 && data[1] === 0x52 && data[2] === 0x42) {
    return data.slice(1);
  }
  return data;
}

function chunkPayload(payload, maxChunkBytes) {
  const chunks = [];
  for (let offset = 0; offset < payload.length; offset += maxChunkBytes) {
    chunks.push(payload.slice(offset, offset + maxChunkBytes));
  }
  return chunks;
}

function nextMessageId() {
  messageId += 1;
  if (messageId >= 255) {
    messageId = 1;
  }
  return messageId;
}

function checksum(buffer) {
  let total = 0;
  for (const byte of buffer) {
    total += byte;
  }
  return total & 0xff;
}

function clampByte(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 0;
  }
  return Math.max(0, Math.min(255, Math.round(number)));
}

function performanceNow() {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 2_000_000) {
        reject(new Error('Request body is too large.'));
        request.destroy();
      }
    });
    request.on('end', () => {
      if (!raw) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body)
  });
  response.end(body);
}

function sendNoContent(response) {
  response.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  response.end();
}

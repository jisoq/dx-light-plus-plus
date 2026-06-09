const fs = require("node:fs");
const path = require("node:path");
const { spawnSync, spawn } = require("node:child_process");
const asar = require("@electron/asar");

const root = path.resolve(__dirname, "..");
const dxLightDir = path.join(root, "vendor-patched", "DX Light");
const resourcesDir = path.join(dxLightDir, "resources");
const dxLightExe = path.join(dxLightDir, "DX Light.exe");
const activeAsarPath = path.join(resourcesDir, "app.asar");
const tmpDir = path.join(root, ".tmp");
const extractDir = path.join(tmpDir, "app-asar-current");
const patchedAsarPath = path.join(tmpDir, "app.asar.sync-dashboard");
const rendererDir = path.join(extractDir, ".webpack", "renderer", "main_window");
const mainDir = path.join(extractDir, ".webpack", "main");
const indexPath = path.join(mainDir, "index.js");
const workerPath = path.join(mainDir, "611cf1f512da07cc30d9.js");
const preloadPath = path.join(rendererDir, "preload.js");
const htmlPath = path.join(rendererDir, "index.html");
const templateDir = path.join(root, "scripts", "templates");
const dashboardJsPath = path.join(templateDir, "dx-sync-dashboard.js");
const dashboardCssPath = path.join(templateDir, "dx-sync-dashboard.css");
const workerTemplatePath = path.join(templateDir, "screen-capture-worker.edge.cjs");
const coastingHelperTemplatePath = path.join(templateDir, "dx-light-frame-coasting.cjs");
const dxgiSamplerPath = path.join(root, "native", "bin", "DxLightDxgiBorderSampler.exe");
const gdiSamplerPath = path.join(root, "native", "bin", "DxLightBorderSampler.exe");
const deployedNativeDir = path.join(resourcesDir, "dxlight-native");

const samplingRate = numberFromEnv("DX_LIGHT_SAMPLING_RATE", 80, 50, 160);
const captureInterval = numberFromEnv("DX_LIGHT_CAPTURE_INTERVAL", 50, 20, 160);
const command = process.argv[2] || "apply";
const shouldRestart = process.argv.includes("--restart");

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});

async function main() {
  switch (command) {
    case "apply":
      await applyPatch();
      break;
    case "verify":
      await verifyActiveAsar();
      break;
    case "extract":
      extractActiveAsar();
      break;
    case "patch-extracted":
      patchExtractedApp();
      break;
    case "pack":
      await packExtractedApp(patchedAsarPath);
      break;
    case "rollback":
      rollbackLatestBackup();
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

async function applyPatch() {
  assertFile(activeAsarPath);
  assertFile(dashboardJsPath);
  assertFile(dashboardCssPath);
  assertFile(workerTemplatePath);
  assertFile(coastingHelperTemplatePath);
  assertFile(dxgiSamplerPath);

  if (shouldRestart) {
    stopDxLight();
  }

  extractActiveAsar();
  patchExtractedApp();
  await packExtractedApp(patchedAsarPath);
  verifyExtractedApp(extractDir);

  const backupPath = backupActiveAsar("sync-dashboard");
  fs.copyFileSync(patchedAsarPath, activeAsarPath);
  deployNativeSamplers();
  console.log(`Installed ${activeAsarPath}`);
  console.log(`Backup ${backupPath}`);

  await verifyActiveAsar();

  if (shouldRestart) {
    startDxLightHidden();
  }
}

function extractActiveAsar() {
  removeDirectoryInsideTmp(extractDir);
  fs.mkdirSync(tmpDir, { recursive: true });
  asar.uncache(activeAsarPath);
  asar.extractAll(activeAsarPath, extractDir);
  console.log(`Extracted ${activeAsarPath}`);
}

async function packExtractedApp(outputPath) {
  assertFile(indexPath);
  assertFile(workerPath);
  if (fs.existsSync(outputPath)) {
    fs.rmSync(outputPath, { force: true });
  }
  await asar.createPackage(extractDir, outputPath);
  console.log(`Packed ${outputPath}`);
}

function patchExtractedApp() {
  assertFile(indexPath);
  assertFile(workerPath);
  assertFile(preloadPath);
  assertFile(htmlPath);
  assertFile(coastingHelperTemplatePath);

  let mainSource = fs.readFileSync(indexPath, "utf8");
  mainSource = patchMainBundle(mainSource);
  fs.writeFileSync(indexPath, mainSource);

  let preloadSource = fs.readFileSync(preloadPath, "utf8");
  preloadSource = patchPreloadBundle(preloadSource);
  fs.writeFileSync(preloadPath, preloadSource);

  let htmlSource = fs.readFileSync(htmlPath, "utf8");
  htmlSource = patchRendererHtml(htmlSource);
  fs.writeFileSync(htmlPath, htmlSource);

  fs.copyFileSync(dashboardJsPath, path.join(rendererDir, "dx-sync-dashboard.js"));
  fs.copyFileSync(dashboardCssPath, path.join(rendererDir, "dx-sync-dashboard.css"));
  fs.copyFileSync(workerTemplatePath, workerPath);
  fs.copyFileSync(coastingHelperTemplatePath, path.join(mainDir, "dx-light-frame-coasting.cjs"));

  verifyExtractedApp(extractDir);
  console.log(`Patched ${extractDir}`);
  console.log(`Sampling rate default: ${samplingRate}`);
  console.log(`Capture interval default: ${captureInterval}ms`);
}

function patchMainBundle(source) {
  let next = source;
  const hardwarePowerRecoveryPatch = createHardwarePowerRecoveryPatch();

  next = stripResidualNetflixRouting(next);

  next = replaceOnce(next, /u=\d+,p=40/, `u=${samplingRate},p=40`, "screen sampling constant");

  if (!next.includes("DxLightFrameSignature=e=>{const t=[];const r=e=>")) {
    next = replaceOnce(
      next,
      /const DxLightSyncMinInterval=45,DxLightSyncKeepAlive=250,DxLightFrameSignature=e=>\{.*?\},DxLightShouldSendSyncFrame=/,
      'const DxLightSyncMinInterval=45,DxLightSyncKeepAlive=250,DxLightFrameSignature=e=>{const t=[];const r=e=>{if(!e)return;if(ArrayBuffer.isView(e)){const r=Math.max(1,Math.floor(e.length/64));for(let n=0;n<e.length;n+=r)t.push(Number(e[n]||0));return}if(Array.isArray(e)){const r=Math.max(1,Math.floor(e.length/32));for(let n=0;n<e.length;n+=r){const r=e[n];r&&"object"==typeof r?t.push(Number(r.red??r.r??0),Number(r.green??r.g??0),Number(r.blue??r.b??0)):t.push(Number(r||0))}return}if(e&&"object"==typeof e){if(Array.isArray(e.screenColors))return r(e.screenColors);Object.keys(e).sort().forEach((t=>r(e[t])))}};r(e);if(!t.length)return"empty";let n=t.length;for(let e=0;e<t.length;e++)n=(31*n+t[e])|0;return String(n)},DxLightShouldSendSyncFrame=',
      "frame signature helper",
    );
  }

  if (!next.includes("DxLightCaptureSamplingRate")) {
    next = replaceOnce(
      next,
      /(DxLightActiveDisplays=\(\)=>\{const e=O\.getMonitors\(\),t=Q\.get\("devices"\)\|\|\[\],r=new Set\(t\.filter\(\(e=>e&&e\.isSyncScreen&&e\.displayId\)\)\.map\(\(e=>e\.displayId\)\)\);if\(!r\.size\)return e;const n=e\.filter\(\(e=>r\.has\(e\.displayId\)\)\);return n\.length\?n:e\};)/,
      `$1const DxLightCaptureSamplingRate=()=>${samplingRate};`,
      "active display helper",
    );
  } else {
    next = next.replace(
      /const DxLightCaptureSamplingRate=\(\)=>(?:\{const e=Number\(Q\.get\("dxLightSamplingRate"\)\|\|\d+\);return e>=50&&e<=160\?e:\d+\}|\d+);/,
      `const DxLightCaptureSamplingRate=()=>${samplingRate};`,
    );
  }

  if (!next.includes("DxLightCaptureInterval")) {
    next = replaceOnce(
      next,
      /(const DxLightCaptureSamplingRate=\(\)=>[^;]+;)/,
      `$1const DxLightCaptureInterval=e=>{const t=Number(Q.get("dxLightCaptureInterval")||${captureInterval});return t>=20&&t<=160?t:Math.max(e+20,${captureInterval})};`,
      "capture interval helper",
    );
  } else {
    next = replaceOnce(
      next,
      /Q\.get\("dxLightCaptureInterval"\)\|\|\d+/,
      `Q.get("dxLightCaptureInterval")||${captureInterval}`,
      "capture interval helper default",
    );
    next = next.replace(/Math\.max\(e\+20,\d+\)/, `Math.max(e+20,${captureInterval})`);
  }

  if (!next.includes("DxLightActiveEdgeNumber")) {
    next = replaceOnce(
      next,
      /(const DxLightCaptureInterval=e=>\{const t=Number\(Q\.get\("dxLightCaptureInterval"\)\|\|\d+\);return t>=20&&t<=160\?t:Math\.max\(e\+20,\d+\)\};)/,
      '$1const DxLightActiveEdgeNumber=()=>{const e=(Q.get("devices")||[]).find((e=>e&&e.isSyncScreen));return 4===Number(e&&e.edgeNumber)?4:3};',
      "edge number helper",
    );
  }

  if (!next.includes("DxLightForceMaxBrightness")) {
    next = replaceOnce(
      next,
      /(const DxLightActiveEdgeNumber=\(\)=>\{const e=\(Q\.get\("devices"\)\|\|\[\]\)\.find\(\(e=>e&&e\.isSyncScreen\)\);return 4===Number\(e&&e\.edgeNumber\)\?4:3\};)/,
      '$1const DxLightSyncDevices=()=>{const e=Array.isArray(_e)?_e:[],t=Q.get("devices")||[];return e.some((e=>e&&e.isSyncScreen))?e:t};const DxLightReconnectBeforeSync=()=>{try{return Promise.resolve(fe.autoConnect(De)).catch((e=>R.error("DX Light sync reconnect failed",e)))}catch(e){return R.error("DX Light sync reconnect failed",e),Promise.resolve()}};const DxLightForceMaxBrightness=()=>{try{const e=(Q.get("devices")||[]).map((e=>e?{...e,brightnessColor:{...(e.brightnessColor||{}),a:1},whiteBrightValue:100}:e));Q.set("devices",e);const t=new H;Promise.resolve(t.send(255)).catch((e=>R.error("DX Light max brightness failed",e)))}catch(e){R.error("DX Light max brightness failed",e)}};',
      "max brightness helper",
    );
  }

  if (!next.includes("DxLightSyncDevices")) {
    next = replaceOnce(
      next,
      /(const DxLightActiveEdgeNumber=\(\)=>\{const e=\(Q\.get\("devices"\)\|\|\[\]\)\.find\(\(e=>e&&e\.isSyncScreen\)\);return 4===Number\(e&&e\.edgeNumber\)\?4:3\};)/,
      '$1const DxLightSyncDevices=()=>{const e=Array.isArray(_e)?_e:[],t=Q.get("devices")||[];return e.some((e=>e&&e.isSyncScreen))?e:t};const DxLightReconnectBeforeSync=()=>{try{return Promise.resolve(fe.autoConnect(De)).catch((e=>R.error("DX Light sync reconnect failed",e)))}catch(e){return R.error("DX Light sync reconnect failed",e),Promise.resolve()}};',
      "sync device recovery helper",
    );
  }

  next = replaceOnce(
    next,
    /const e=DxLightActiveDisplays\(\),t=Q\.get\("syncSpeed"\)\?Q\.get\("syncSpeed"\):0,n=(?:u|DxLightCaptureSamplingRate\(\))/,
    'const e=DxLightActiveDisplays(),t=Q.get("syncSpeed")?Q.get("syncSpeed"):0,n=DxLightCaptureSamplingRate()',
    "worker sampling expression",
  );

  next = next.replace(
    /displays:e,finalSyncSpeed:(?:t\+20|DxLightCaptureInterval\(t\)),samplingRate:n(?:,edgeCapture:!0)?(?:,edgeNumber:DxLightActiveEdgeNumber\(\))?/,
    "displays:e,finalSyncSpeed:DxLightCaptureInterval(t),samplingRate:n,edgeCapture:!0,edgeNumber:DxLightActiveEdgeNumber()",
  );

  if (!next.includes("DX Light process priority: below normal")) {
    next = replaceOnce(
      next,
      /const fe=new D;R\.initialize\(\);/,
      'const fe=new D;R.initialize();try{g.setPriority(g.constants.priority.PRIORITY_BELOW_NORMAL),R.info("DX Light process priority: below normal")}catch(e){R.error("DX Light process priority failed",e)};',
      "priority initialization",
    );
  }

  if (!next.includes("me=!1;DxLightReconnectBeforeSync();DxLightForceMaxBrightness();DxLightRememberSyncIntent();")) {
    next = replaceOnce(
      next,
      /const Re=\(\)=>\{me=!1;(?:DxLightReconnectBeforeSync\(\);)?(?:DxLightForceMaxBrightness\(\);)?(?:DxLightRememberSyncIntent\(\);)?/,
      "const Re=()=>{me=!1;DxLightReconnectBeforeSync();DxLightForceMaxBrightness();DxLightRememberSyncIntent();",
      "sync start max brightness and intent capture",
    );
  }

  next = next.replace(
    /const Re=\(\)=>\{me=!1;(?:DxLightReconnectBeforeSync\(\);)?DxLightForceMaxBrightness\(\);DxLightRememberSyncIntent\(\);/,
    "const Re=()=>{me=!1;DxLightReconnectBeforeSync();DxLightForceMaxBrightness();DxLightRememberSyncIntent();",
  );

  if (!next.includes("DxLightDashboardStatus")) {
    next = replaceOnce(
      next,
      /let \$e=\[\],Oe=\{\};/,
      `let $e=[],Oe={};const DxLightDashboardStatus=()=>{const e=Q.get("devices")||[],t=e.find((e=>e&&e.isSyncScreen))||e[0]||null,r=O.getMonitors(),n=DxLightActiveDisplays(),i=Q.get("syncSpeed")?Q.get("syncSpeed"):0;return{patchVersion:"sync-dashboard-v1",capture:{mode:"native-border",displayFilter:"sync-device-display",samplingRate:DxLightCaptureSamplingRate(),intervalMs:DxLightCaptureInterval(i),edgeNumber:DxLightActiveEdgeNumber(),priority:"below-normal",duplicateSuppression:!0,nativeBorderSampler:"planned"},runtime:{syncWorkerRunning:!!ve,mouseWorkerRunning:!!we,lastFrameAt:Oe.t||0,lastFrameAgeMs:Oe.t?Date.now()-Oe.t:null,signature:Oe.sig||null},device:t?{id:t.id,uuid:t.uuid,name:t.name,lampsAmount:t.lampsAmount,displayId:t.displayId,displaySize:t.displaySize,edgeNumber:t.edgeNumber,isSyncScreen:!!t.isSyncScreen,isSwitchOn:!!t.isSwitchOn,version:t.version,type:t.type}:null,monitors:r,activeDisplays:n,settings:{syncSpeed:i,fpsOptimization:Q.get("fpsOptimization")||0,syncColor:Q.get("syncColor")||0,isLightCompression:Q.get("isLightCompression")||0}}},DxLightDashboardApplyProfile=e=>{const r={dxLightCaptureInterval:50,dxLightSamplingRate:${samplingRate},fpsOptimization:1};return Object.keys(r).forEach((e=>Q.set(e,r[e]))),ve&&(Pe(),setTimeout(Re,250)),DxLightDashboardStatus()},DxLightDashboardSetSyncRunning=e=>{const t=!!e,r=O.getMonitors(),n=r[0]&&r[0].displayId,i=(Q.get("devices")||[]).map(((e,r)=>0===r?{...e,isSyncScreen:t,isSwitchOn:!0,syncMode:0,displayId:e.displayId||n||""}:{...e,isSyncScreen:!1}));return Q.set("devices",i),t?Re():Pe(),DxLightDashboardStatus()};`,
      "dashboard runtime status helpers",
    );
  }

  next = next.replace(
    /z\(Oe,_e,t,e,n\)/g,
    "z(Oe,DxLightSyncDevices(),t,e,n)",
  );

  next = next.replace(
    /DxLightDashboardSetSyncRunning=e=>\{const t=!!e,r=O\.getMonitors\(\),n=r\[0\]&&r\[0\]\.displayId,i=\(Q\.get\("devices"\)\|\|\[\]\)\.map\(\(\(e,r\)=>0===r\?\{\.\.\.e,isSyncScreen:t,isSwitchOn:!0,syncMode:0,displayId:e\.displayId\|\|n\|\|""\}:\{\.\.\.e,isSyncScreen:!1\}\)\);return Q\.set\("devices",i\),t\?Re\(\):Pe\(\),DxLightDashboardStatus\(\)\}/,
    'DxLightDashboardSetSyncRunning=e=>{const t=!!e,r=O.getMonitors(),n=r[0]&&r[0].displayId,i=(Q.get("devices")||[]).map(((e,r)=>0===r?{...e,isSyncScreen:t,isSwitchOn:!0,syncMode:0,displayId:e.displayId||n||""}:{...e,isSyncScreen:!1}));return Q.set("devices",i),t?(DxLightRememberSyncIntent(),Re()):(DxLightClearSyncIntent(),Pe()),DxLightDashboardStatus()}',
  );

  next = next.replace(
    /quiet:\{dxLightCaptureInterval:100,dxLightSamplingRate:\d+,fpsOptimization:1\},balanced:\{dxLightCaptureInterval:80,dxLightSamplingRate:\d+,fpsOptimization:1\},responsive:\{dxLightCaptureInterval:50,dxLightSamplingRate:\d+,fpsOptimization:1\}/,
    `quiet:{dxLightCaptureInterval:100,dxLightSamplingRate:${samplingRate},fpsOptimization:1},balanced:{dxLightCaptureInterval:80,dxLightSamplingRate:${samplingRate},fpsOptimization:1},responsive:{dxLightCaptureInterval:50,dxLightSamplingRate:${samplingRate},fpsOptimization:1}`,
  );
  next = next.replace(
    /DxLightDashboardApplyProfile=e=>\{const t=\{quiet:\{dxLightCaptureInterval:100,dxLightSamplingRate:\d+,fpsOptimization:1\},balanced:\{dxLightCaptureInterval:80,dxLightSamplingRate:\d+,fpsOptimization:1\},responsive:\{dxLightCaptureInterval:50,dxLightSamplingRate:\d+,fpsOptimization:1\}\},r=t\[e\]\|\|t\.balanced;return Object\.keys\(r\)\.forEach\(\(e=>Q\.set\(e,r\[e\]\)\)\),ve&&\(Pe\(\),setTimeout\(Re,250\)\),DxLightDashboardStatus\(\)\}/,
    `DxLightDashboardApplyProfile=e=>{const r={dxLightCaptureInterval:50,dxLightSamplingRate:${samplingRate},fpsOptimization:1};return Object.keys(r).forEach((e=>Q.set(e,r[e]))),ve&&(Pe(),setTimeout(Re,250)),DxLightDashboardStatus()}`,
  );

  next = next.replace(
    /mode:"sequential-edge",displayFilter:/g,
    'mode:Oe.native&&Oe.native.mode?Oe.native.mode:"native-border",displayFilter:',
  );
  next = next.replace(
    /mode:(?:Oe\.native&&Oe\.native\.mode\?Oe\.native\.mode:)+"(?:sequential-edge|native-border)",displayFilter:/g,
    'mode:Oe.native&&Oe.native.mode?Oe.native.mode:"native-border",displayFilter:',
  );
  next = next.replace(
    /nativeBorderSampler:"planned"/g,
    'nativeBorderSampler:Oe.native&&Oe.native.backend?Oe.native.backend:"planned",nativeFrameMs:Oe.native&&Oe.native.elapsedMs||null,nativeStatusReason:Oe.native&&Oe.native.reason||"",contentBoundsActive:!!(Oe.native&&Oe.native.contentBoundsActive),contentLeft:Oe.native&&Oe.native.contentLeft||0,contentRight:Oe.native&&Oe.native.contentRight||0,coastingActive:!!(Oe.native&&Oe.native.coastingActive),captureDegraded:!!(Oe.native&&Oe.native.captureDegraded),nativeCooldownMs:Oe.native&&Oe.native.nativeCooldownMs||0,coastingAgeMs:Oe.native&&Oe.native.coastingAgeMs||null',
  );
  next = next.replace(/nativeFallbackReason:/g, "nativeStatusReason:");
  next = next.replace(
    /nativeStatusReason:Oe\.native&&Oe\.native\.reason\|\|""(?!,contentBoundsActive)/g,
    'nativeStatusReason:Oe.native&&Oe.native.reason||"",contentBoundsActive:!!(Oe.native&&Oe.native.contentBoundsActive),contentLeft:Oe.native&&Oe.native.contentLeft||0,contentRight:Oe.native&&Oe.native.contentRight||0',
  );
  next = next.replace(
    /contentRight:Oe\.native&&Oe\.native\.contentRight\|\|0(?!,coastingActive)/g,
    'contentRight:Oe.native&&Oe.native.contentRight||0,coastingActive:!!(Oe.native&&Oe.native.coastingActive),captureDegraded:!!(Oe.native&&Oe.native.captureDegraded),nativeCooldownMs:Oe.native&&Oe.native.nativeCooldownMs||0,coastingAgeMs:Oe.native&&Oe.native.coastingAgeMs||null',
  );

  if (!next.includes("dxLightSyncDashboard:status")) {
    next = replaceOnce(
      next,
      /S\.handle\("writeData"/,
      'S.handle("dxLightSyncDashboard:status",(()=>DxLightDashboardStatus())),S.handle("dxLightSyncDashboard:setProfile",((e,t)=>DxLightDashboardApplyProfile(t))),S.handle("dxLightSyncDashboard:setSyncRunning",((e,t)=>DxLightDashboardSetSyncRunning(t))),S.handle("dxLightSyncDashboard:openLogs",(()=>b.openPath(A.join(y.getPath("userData"),"logs","main.log")))),S.handle("writeData"',
      "dashboard ipc handlers",
    );
  }

  next = next.replace(
    /S\.handle\("sendBrightness",\(async\(e,t\)=>\{const r=new H;await r\.send\((?:t|255)\)\}\)\)/,
    'S.handle("sendBrightness",(async(e,t)=>{const r=new H;await r.send(255)}))',
  );

  if (!next.includes("native-border-status")) {
    next = replaceOnce(
      next,
      /ve\.on\("message",\(t=>\{if\(!me\)\{/,
      've.on("message",(t=>{if(t&&t.type==="native-border-status"){Oe.native=t;return}if(!me){',
      "native border worker status handler",
    );
  }

  if (!next.includes("Oe.nativeOff")) {
    next = replaceOnce(
      next,
      /if\(t&&t\.type==="native-border-status"\)\{Oe\.native=t;return\}if\(!me\)\{/,
      'if(t&&t.type==="native-border-status"){Oe.native=t;if(t.displayActive===false){Oe.nativeOff=!0;Promise.resolve(M()).catch((e=>R.error("DX Light display-off turn off failed",e)));return}if(t.displayActive===true)Oe.nativeOff=!1;return}if(!me&&!Oe.nativeOff){',
      "native display-off light shutdown",
    );
  }

  if (!next.includes("DX Light display-removed turn off failed")) {
    next = replaceOnce(
      next,
      /I\.on\("display-removed",\(\(e,t\)=>\{Pe\(\),De\.webContents\.send\("displayRemoved",t\)\}\)\)/,
      'I.on("display-removed",((e,t)=>{Pe(),Oe.nativeOff=!0,Promise.resolve(M()).catch((e=>R.error("DX Light display-removed turn off failed",e))),De.webContents.send("displayRemoved",t)}))',
      "display removed light shutdown",
    );
  }

  if (!next.includes("DxLightHardwarePowerRecover")) {
    next = replaceOnce(
      next,
      /(Pe=\(\)=>\{if\(ve\)try\{\$e=\[\],Oe=\[\],ve\.postMessage\("exit"\)\}catch\(e\)\{R\.error\(e\)\}\})(?:,DxLightWakeRecover=\(\)=>\{setTimeout\(\(async\(\)=>\{try\{await fe\.autoConnect\(De\);.*?R\.error\("DX Light wake recovery failed",e\)\}\}\),2500\)\})?,Ae=\(\)=>\{/,
      `$1;${hardwarePowerRecoveryPatch};const Ae=()=>{`,
      "hardware power recovery helpers",
    );
  }

  if (!next.includes("DxLightStartupSyncRequested")) {
    next = replaceOnce(
      next,
      /DxLightClearSyncIntent=\(\)=>\{DxLightLastSyncDevice=null\},DxLightRecoveryDisplayId=/,
      'DxLightClearSyncIntent=()=>{DxLightLastSyncDevice=null},DxLightStartupSyncRequested=()=>process.argv.slice(1).some((e=>"--startup"===e)),DxLightRecoveryDisplayId=',
      "startup sync helper",
    );
  }

  next = next.replace(
    /DxLightHardwarePowerRecover=e=>\{clearTimeout\(DxLightHardwareRecoverTimer\),DxLightHardwareRecoverTimer=setTimeout\(\(async\(\)=>\{try\{await fe\.autoConnect\(De\);const e=\(Q\.get\("devices"\)\|\|\[\]\)\.some\(\(e=>e&&e\.isSyncScreen\)\),t=fe\.devices\.some\(\(e=>e&&!0===e\.isSyncScreen\)\);if\(e\|\|t\)return Re\(\),void R\.info\("DX Light hardware power recovery: restarted screen sync"\);if\(DxLightLastSyncDevice&&DxLightRestoreSyncDevice\(\)\)return Pe\(\),setTimeout\(Re,250\),void R\.info\("DX Light hardware power recovery: restored screen sync"\)\}catch\(e\)\{R\.error\("DX Light hardware power recovery failed",e\)\}\}\),2500\)\}/,
    'DxLightHardwarePowerRecover=e=>{clearTimeout(DxLightHardwareRecoverTimer),DxLightHardwareRecoverTimer=setTimeout((async()=>{try{await fe.autoConnect(De);const t=(Q.get("devices")||[]).some((e=>e&&e.isSyncScreen)),r=fe.devices.some((e=>e&&!0===e.isSyncScreen));if(t||r)return Re(),void R.info("DX Light hardware power recovery: restarted screen sync");if((DxLightLastSyncDevice||"startup"===e&&DxLightStartupSyncRequested())&&DxLightRestoreSyncDevice())return Pe(),setTimeout(Re,250),void R.info("DX Light hardware power recovery: restored screen sync")}catch(e){R.error("DX Light hardware power recovery failed",e)}}),2500)}',
  );

  if (!next.includes('DxLightHardwarePowerRecover("usb-attach")')) {
    next = replaceOnce(
      next,
      /await fe\.autoConnect\(De\)\)\}\),1500\)\}\)\),N\.on\("detach"/,
      'await fe.autoConnect(De),DxLightHardwarePowerRecover("usb-attach"))}),1500)})),N.on("detach"',
      "usb attach hardware recovery",
    );
  }

  if (!next.includes("DxLightRememberSyncIntent();R.info(`🔥 拨出设备")) {
    next = replaceOnce(
      next,
      /N\.on\("detach",\(e=>\{R\.info\(`/,
      'N.on("detach",(e=>{DxLightRememberSyncIntent();R.info(`',
      "usb detach sync intent capture",
    );
  }

  if (!next.includes('DxLightHardwarePowerRecover("hid-error")')) {
    next = replaceOnce(
      next,
      /j\.on\("disconnected",\(e=>\{De\.webContents\.send\("disconnect",e\),fe\.removeDevice\(e\)\}\)\)/,
      'j.on("disconnected",(e=>{DxLightRememberSyncIntent();De.webContents.send("disconnect",e),fe.removeDevice(e),DxLightHardwarePowerRecover("hid-error")}))',
      "hid error hardware recovery",
    );
  }

  if (!next.includes('DxLightHardwarePowerRecover("startup")')) {
    next = replaceOnce(
      next,
      /await fe\.autoConnect\(De\),clearTimeout\(e\)/,
      'await fe.autoConnect(De),DxLightHardwarePowerRecover("startup"),clearTimeout(e)',
      "startup screen sync recovery",
    );
  }

  next = next.replace(
    /new w\(\{width:1280,height:800,/,
    "new w({width:1120,height:760,",
  );
  next = next.replace(/De\.setResizable\(!1\)/, "De.setResizable(!0)");

  return next;
}

function createHardwarePowerRecoveryPatch() {
  return [
    'let DxLightLastSyncDevice=null,DxLightHardwareRecoverTimer=null;',
    'const DxLightRememberSyncIntent=()=>{try{const e=(Q.get("devices")||[]).find((e=>e&&e.isSyncScreen));e&&(DxLightLastSyncDevice={uuid:e.uuid,id:e.id,displayId:e.displayId,edgeNumber:e.edgeNumber,lampsAmount:e.lampsAmount})}catch(e){R.error("DX Light hardware power intent capture failed",e)}},',
    'DxLightClearSyncIntent=()=>{DxLightLastSyncDevice=null},',
    'DxLightRecoveryDisplayId=()=>{const e=O.getMonitors();return DxLightLastSyncDevice&&DxLightLastSyncDevice.displayId||e[0]&&e[0].displayId||""},',
    'DxLightRestoreSyncDevice=()=>{const e=Q.get("devices")||[],t=DxLightLastSyncDevice,r=DxLightRecoveryDisplayId(),n=fe.devices.some((e=>e&&(t&&(e.uuid===t.uuid||e.id===t.id)||!t)));if(!n)return!1;let i=!1;const o=e.map(((e,n)=>{if(!e)return e;const o=t&&(e.uuid&&e.uuid===t.uuid||e.id&&e.id===t.id),s=o||!t&&0===n;return s&&(i=!0),{...e,isSyncScreen:s,isSwitchOn:s?!0:e.isSwitchOn,syncMode:s?0:e.syncMode,displayId:s?e.displayId||r:e.displayId}}));return!i&&o[0]&&(o[0]={...o[0],isSyncScreen:!0,isSwitchOn:!0,syncMode:0,displayId:o[0].displayId||r},i=!0),i?(Q.set("devices",o),!0):!1},',
    'DxLightStartupSyncRequested=()=>process.argv.slice(1).some((e=>"--startup"===e)),',
    'DxLightHardwarePowerRecover=e=>{clearTimeout(DxLightHardwareRecoverTimer),DxLightHardwareRecoverTimer=setTimeout((async()=>{try{await fe.autoConnect(De);const t=(Q.get("devices")||[]).some((e=>e&&e.isSyncScreen)),r=fe.devices.some((e=>e&&!0===e.isSyncScreen));if(t||r)return Re(),void R.info("DX Light hardware power recovery: restarted screen sync");if((DxLightLastSyncDevice||"startup"===e&&DxLightStartupSyncRequested())&&DxLightRestoreSyncDevice())return Pe(),setTimeout(Re,250),void R.info("DX Light hardware power recovery: restored screen sync")}catch(e){R.error("DX Light hardware power recovery failed",e)}}),2500)},',
    'DxLightWakeRecover=()=>DxLightHardwarePowerRecover("wake")'
  ].join("");
}

function patchPreloadBundle(source) {
  if (source.includes("dxLightSyncDashboard")) {
    return source;
  }

  return replaceOnce(
    source,
    /r\.exposeInMainWorld\("QuikLight",\{getMonitors:\(\)=>u\.getMonitors\(\)\}\),/,
    'r.exposeInMainWorld("QuikLight",{getMonitors:()=>u.getMonitors()}),r.exposeInMainWorld("dxLightSyncDashboard",{status:()=>o.invoke("dxLightSyncDashboard:status"),setProfile:e=>o.invoke("dxLightSyncDashboard:setProfile",e),setSyncRunning:e=>o.invoke("dxLightSyncDashboard:setSyncRunning",e),openLogs:()=>o.invoke("dxLightSyncDashboard:openLogs")}),',
    "dashboard preload api",
  );
}

function patchRendererHtml(source) {
  let next = source;
  next = next.replace(/<link href="\.\.\/main_window\/dx-sync-dashboard\.css(?:\?v=[^"]*)?" rel="stylesheet">/g, "");
  next = next.replace(/<script defer="defer" src="\.\.\/main_window\/dx-sync-dashboard\.js(?:\?v=[^"]*)?"><\/script>/g, "");
  next = next.replace(
    /<link href="\.\.\/main_window\.css" rel="stylesheet">/,
    '<link href="../main_window.css" rel="stylesheet"><link href="../main_window/dx-sync-dashboard.css?v=sync-dashboard-v2" rel="stylesheet">',
  );
  next = next.replace(
    /<script defer="defer" src="\.\.\/main_window\/index\.js"><\/script>/,
    '<script defer="defer" src="../main_window/index.js"></script><script defer="defer" src="../main_window/dx-sync-dashboard.js?v=sync-dashboard-v2"></script>',
  );
  return next;
}

function verifyExtractedApp(directory) {
  const main = fs.readFileSync(path.join(directory, ".webpack", "main", "index.js"), "utf8");
  const worker = fs.readFileSync(path.join(directory, ".webpack", "main", "611cf1f512da07cc30d9.js"), "utf8");
  const coastingHelper = fs.readFileSync(path.join(directory, ".webpack", "main", "dx-light-frame-coasting.cjs"), "utf8");
  const preload = fs.readFileSync(path.join(directory, ".webpack", "renderer", "main_window", "preload.js"), "utf8");
  const html = fs.readFileSync(path.join(directory, ".webpack", "renderer", "main_window", "index.html"), "utf8");

  const markers = [
    [main, `u=${samplingRate},p=40`],
    [main, "DxLightActiveDisplays"],
    [main, "DxLightCaptureSamplingRate"],
    [main, "DxLightCaptureInterval"],
    [main, "DxLightActiveEdgeNumber"],
    [main, "DxLightSyncDevices"],
    [main, "DxLightReconnectBeforeSync"],
    [main, "DxLightForceMaxBrightness"],
    [main, "me=!1;DxLightReconnectBeforeSync();DxLightForceMaxBrightness();"],
    [main, 'S.handle("sendBrightness",(async(e,t)=>{const r=new H;await r.send(255)}))'],
    [main, `Q.get("dxLightCaptureInterval")||${captureInterval}`],
    [main, "finalSyncSpeed:DxLightCaptureInterval(t)"],
    [main, "edgeCapture:!0"],
    [main, "edgeNumber:DxLightActiveEdgeNumber()"],
    [main, "DX Light process priority: below normal"],
    [main, "DxLightShouldSendSyncFrame"],
    [main, "DxLightDashboardStatus"],
    [main, "DxLightHardwarePowerRecover"],
    [main, 'DxLightHardwarePowerRecover("startup")'],
    [main, 'DxLightHardwarePowerRecover("usb-attach")'],
    [main, 'DxLightHardwarePowerRecover("hid-error")'],
    [main, "native-border-status"],
    [main, "Oe.nativeOff"],
    [main, "DX Light display-off turn off failed"],
    [main, "DX Light display-removed turn off failed"],
    [main, "contentBoundsActive"],
    [main, "nativeStatusReason"],
    [main, "coastingActive"],
    [main, "captureDegraded"],
    [main, "nativeCooldownMs"],
    [main, "dxLightSyncDashboard:status"],
    [main, "width:1120,height:760"],
    [main, "De.setResizable(!0)"],
    [worker, "edgeCapture"],
    [worker, "DxLightDxgiBorderSampler.exe"],
    [worker, "dx-light-frame-coasting.cjs"],
    [worker, "native-border-status"],
    [worker, "scheduleNativeSamplerRestart"],
    [worker, "enterNativeCooldown"],
    [worker, "DX_LIGHT_NATIVE_RECOVERY_COOLDOWN_MS"],
    [worker, "coastingActive"],
    [worker, "captureDegraded"],
    [worker, "nativeCooldownMs"],
    [worker, "startSequentialEdgeCapture"],
    [worker, "displayActive: true"],
    [worker, "native ready timeout"],
    [worker, "parentPort.postMessage"],
    [coastingHelper, "createFrameCoaster"],
    [coastingHelper, "isProtectedCaptureReason"],
    [coastingHelper, "shouldCoastCaptureFrame"],
    [coastingHelper, "DEFAULT_COAST_MS = 8000"],
    [preload, "dxLightSyncDashboard"],
    [html, "dx-sync-dashboard.css"],
    [html, "dx-sync-dashboard.js"],
  ];

  for (const [content, marker] of markers) {
    if (!content.includes(marker)) {
      throw new Error(`Expected marker missing after patch: ${marker}`);
    }
  }

  const absentContents = [
    ["main", main],
    ["worker", worker],
    ["coasting-helper", coastingHelper],
    ["preload", preload],
    ["html", html],
  ];
  const absentMarkers = [
    "DxLightNetflix",
    "DxLightNetflixFallback",
    "DxLightNetflixActive",
    "DX Light Netflix fallback active",
    "Netflix",
    "넷플릭스",
    "media-context",
    "protectedLikely",
  ];

  for (const [label, content] of absentContents) {
    for (const marker of absentMarkers) {
      if (content.includes(marker)) {
        throw new Error(`Unexpected Netflix/media routing marker after patch in ${label}: ${marker}`);
      }
    }
  }
}

async function verifyActiveAsar() {
  const verifyDir = path.join(tmpDir, "verify-asar-sync-dashboard");
  removeDirectoryInsideTmp(verifyDir);
  asar.uncache(activeAsarPath);
  asar.extractAll(activeAsarPath, verifyDir);
  verifyExtractedApp(verifyDir);
  console.log("Active app.asar verified: sync dashboard and edge optimization markers found.");
}

function deployNativeSamplers() {
  fs.mkdirSync(deployedNativeDir, { recursive: true });
  fs.copyFileSync(dxgiSamplerPath, path.join(deployedNativeDir, "DxLightDxgiBorderSampler.exe"));
  if (fs.existsSync(gdiSamplerPath)) {
    fs.copyFileSync(gdiSamplerPath, path.join(deployedNativeDir, "DxLightBorderSampler.exe"));
  }
  console.log(`Installed native sampler ${path.join(deployedNativeDir, "DxLightDxgiBorderSampler.exe")}`);
}

function rollbackLatestBackup() {
  const latest = fs
    .readdirSync(resourcesDir)
    .filter((name) => name.startsWith("app.asar.before-sync-dashboard-"))
    .sort()
    .pop();
  if (!latest) {
    throw new Error("No sync-dashboard backup found.");
  }
  if (shouldRestart) {
    stopDxLight();
  }
  fs.copyFileSync(path.join(resourcesDir, latest), activeAsarPath);
  console.log(`Rolled back to ${latest}`);
  if (shouldRestart) {
    startDxLightHidden();
  }
}

function backupActiveAsar(label) {
  const timestamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const backupPath = path.join(resourcesDir, `app.asar.before-${label}-${timestamp}`);
  fs.copyFileSync(activeAsarPath, backupPath);
  return backupPath;
}

function stopDxLight() {
  spawnSync("powershell", [
    "-NoProfile",
    "-Command",
    "Get-Process -Name 'DX Light' -ErrorAction SilentlyContinue | Stop-Process -Force",
  ], { stdio: "inherit" });
}

function startDxLightHidden() {
  const child = spawn(dxLightExe, {
    cwd: dxLightDir,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  console.log(`Started ${dxLightExe}`);
}

function numberFromEnv(name, fallback, min, max) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return value;
}

function replaceOnce(source, pattern, replacement, label) {
  if (!pattern.test(source)) {
    throw new Error(`Patch anchor not found: ${label}`);
  }
  return source.replace(pattern, replacement);
}

function stripResidualNetflixRouting(source) {
  let next = source.replace(/\b([A-Za-z_$][\w$]*)=DxLightNetflixFallback\(\1\);/g, "");

  const declarationStart = next.indexOf("const{execFileSync:DxLightExecFileSync}");
  if (declarationStart < 0) {
    if (next.includes("DxLightNetflix")) {
      throw new Error("Unexpected residual Netflix routing shape in main bundle.");
    }
    return next;
  }

  const declarationEndMarker = ";const{convertToBlack:";
  const declarationEnd = next.indexOf(declarationEndMarker, declarationStart);
  if (declarationEnd < 0) {
    throw new Error("Could not find residual Netflix routing declaration end.");
  }

  next = `${next.slice(0, declarationStart)}const{convertToBlack:${next.slice(declarationEnd + declarationEndMarker.length)}`;
  if (next.includes("DxLightNetflix")) {
    throw new Error("Residual Netflix routing marker remains in main bundle.");
  }
  return next;
}

function assertFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing file: ${filePath}`);
  }
}

function removeDirectoryInsideTmp(directory) {
  const resolved = path.resolve(directory);
  const resolvedTmp = path.resolve(tmpDir);
  if (!resolved.startsWith(resolvedTmp + path.sep)) {
    throw new Error(`Refusing to remove directory outside .tmp: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

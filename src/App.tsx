import { type PointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import { BrowserScreenCaptureProvider, ScreenCaptureService } from './capture/captureService';
import { isScreenCapturePermissionError, screenCaptureStartMessage } from './capture/captureErrors';
import { BridgeLightDeviceAdapter } from './device/bridgeDeviceAdapter';
import { createSolidColorFrame, isFlatBlackLedFrame } from './domain/ledFrame';
import { createOrderedSamplingRegions } from './domain/ledLayout';
import { AdaptiveOptimizer } from './domain/optimizer';
import { domainToPreviewDomain, effectiveDisplayAreaPercent, previewFrameBounds, previewPointToFramePoint } from './domain/samplingFrame';
import {
  DEFAULT_LED_COUNT,
  DEFAULT_REGIONS,
  loadLocalAppSettings,
  normalizeAppSettings,
  normalizeSamplingRegion,
  saveLocalAppSettings,
  type AppSettings
} from './settings/appSettings';
import type {
  InstallationDirection,
  LightDeviceAdapter,
  LightDeviceInfo,
  OptimizerState,
  RgbColor,
  SamplingFrameMode,
  SamplingRegion,
  SyncMetrics,
  SyncStatus
} from './domain/types';

const INITIAL_METRICS: SyncMetrics = { frameMs: 0, captureMs: 0, writeMs: 0, droppedFrames: 0 };
const BLACK: RgbColor = { r: 0, g: 0, b: 0 };
const UI_UPDATE_INTERVAL_MS = 200;

type ResizeHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
type DragMode = 'move' | ResizeHandle;

interface DragState {
  id: string;
  mode: DragMode;
  pointerId: number;
  startPointer: Point;
  startRegion: SamplingRegion;
}

interface Point {
  x: number;
  y: number;
}

export default function App() {
  const captureService = useMemo(() => new ScreenCaptureService(new BrowserScreenCaptureProvider()), []);
  const bridgeAdapter = useMemo(() => new BridgeLightDeviceAdapter(), []);
  const deviceAdapter = bridgeAdapter as LightDeviceAdapter;
  const initialSettings = useMemo(() => loadLocalAppSettings(), []);
  const optimizerRef = useRef(new AdaptiveOptimizer());
  const runningRef = useRef(false);
  const frameRef = useRef<number | null>(null);
  const lastFrameAtRef = useRef(0);
  const lastUiUpdateAtRef = useRef(0);
  const frameIndexRef = useRef(0);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const autoConnectAttemptedRef = useRef(false);
  const settingsSaveTimerRef = useRef<number | null>(null);

  const [status, setStatus] = useState<SyncStatus>('idle');
  const [regions, setRegions] = useState<SamplingRegion[]>(initialSettings.regions);
  const [selectedRegionId, setSelectedRegionId] = useState(initialSettings.selectedRegionId);
  const [installationDirection, setInstallationDirection] = useState<InstallationDirection>(initialSettings.installationDirection);
  const [samplingFrameMode, setSamplingFrameMode] = useState<SamplingFrameMode>(initialSettings.samplingFrameMode);
  const [ledCount, setLedCount] = useState(initialSettings.ledCount);
  const [deviceInfo, setDeviceInfo] = useState<LightDeviceInfo | null>(null);
  const [color, setColor] = useState<RgbColor>(BLACK);
  const [metrics, setMetrics] = useState<SyncMetrics>(INITIAL_METRICS);
  const [optimizer, setOptimizer] = useState<OptimizerState>(optimizerRef.current.getState());
  const [deviceConnected, setDeviceConnected] = useState(false);
  const [message, setMessage] = useState('Ready');
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [startupSupported, setStartupSupported] = useState(true);
  const [startupEnabled, setStartupEnabled] = useState(false);
  const [startupBusy, setStartupBusy] = useState(false);
  const [captureBlocked, setCaptureBlocked] = useState(false);

  const currentSettings = useMemo<AppSettings>(() => normalizeAppSettings({
    regions,
    selectedRegionId,
    installationDirection,
    samplingFrameMode,
    ledCount
  }), [installationDirection, ledCount, regions, samplingFrameMode, selectedRegionId]);

  useEffect(() => {
    let disposed = false;

    async function loadSettings() {
      try {
        const remoteSettings = await resolveWithTimeout(bridgeAdapter.loadSettings(), 1200, null);
        if (!disposed && remoteSettings) {
          applySettings(normalizeAppSettings(remoteSettings));
        }
      } catch {
        // The local browser copy is enough when the bridge is not running yet.
      } finally {
        if (!disposed) {
          setSettingsLoaded(true);
        }
      }
    }

    void loadSettings();

    return () => {
      disposed = true;
    };
  }, [bridgeAdapter]);

  useEffect(() => {
    saveLocalAppSettings(currentSettings);

    if (!settingsLoaded) {
      return;
    }

    if (settingsSaveTimerRef.current !== null) {
      window.clearTimeout(settingsSaveTimerRef.current);
    }
    settingsSaveTimerRef.current = window.setTimeout(() => {
      void bridgeAdapter.saveSettings(currentSettings).catch(() => undefined);
    }, 250);

    return () => {
      if (settingsSaveTimerRef.current !== null) {
        window.clearTimeout(settingsSaveTimerRef.current);
        settingsSaveTimerRef.current = null;
      }
    };
  }, [bridgeAdapter, currentSettings, settingsLoaded]);

  useEffect(() => {
    let disposed = false;

    async function loadStartupStatus() {
      try {
        const startup = await resolveWithTimeout(bridgeAdapter.getStartupStatus(), 1200, null);
        if (!disposed && startup) {
          setStartupSupported(startup.supported);
          setStartupEnabled(startup.enabled);
        }
      } catch {
        if (!disposed) {
          setStartupSupported(false);
        }
      }
    }

    void loadStartupStatus();

    return () => {
      disposed = true;
    };
  }, [bridgeAdapter]);

  useEffect(() => {
    let disposed = false;

    async function connectPairedDevice() {
      if (autoConnectAttemptedRef.current) {
        return;
      }
      autoConnectAttemptedRef.current = true;

      if (!deviceAdapter.isSupported()) {
        setMessage('WebHID unavailable');
        return;
      }

      setMessage('Checking paired DX Light device');
      try {
        const info = await resolveWithTimeout(deviceAdapter.connectPaired(), 1200, null);
        if (disposed) {
          return;
        }
        if (info) {
          applyConnectedDevice(info, 'Auto-connected');
        } else {
          setMessage('DX Light bridge is waiting for the USB device');
        }
      } catch (error) {
        if (!disposed) {
          setMessage(error instanceof Error ? error.message : 'Device auto-connect failed');
        }
      }
    }

    void connectPairedDevice();

    return () => {
      disposed = true;
      runningRef.current = false;
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
      }
      captureService.stop();
      void deviceAdapter.disconnect();
      if (settingsSaveTimerRef.current !== null) {
        window.clearTimeout(settingsSaveTimerRef.current);
      }
    };
  }, [captureService, deviceAdapter]);

  async function startSync() {
    if (regions.length === 0) {
      setMessage('Add at least one sampling strip');
      return;
    }

    try {
      setStatus('capturing');
      setMessage('Waiting for screen capture');
      await captureService.start();
      setCaptureBlocked(false);
      runningRef.current = true;
      lastFrameAtRef.current = performance.now();
      lastUiUpdateAtRef.current = 0;
      setStatus('syncing');
      setMessage('Screen sync running');
      frameRef.current = window.requestAnimationFrame(runFrame);
    } catch (error) {
      setStatus('error');
      setCaptureBlocked(isScreenCapturePermissionError(error));
      setMessage(screenCaptureStartMessage(error));
    }
  }

  function stopSync() {
    runningRef.current = false;
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    captureService.stop();
    setStatus('idle');
    setMessage('Stopped');
    void turnOffConnectedDevice();
  }

  async function openInSystemBrowser() {
    try {
      await bridgeAdapter.openBrowser();
      setMessage('Opened in system browser');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not open system browser');
    }
  }

  async function connectDevice() {
    try {
      const info = await deviceAdapter.connect();
      applyConnectedDevice(info, 'Device connected');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Device connection failed');
    }
  }

  function applyConnectedDevice(info: LightDeviceInfo | null, prefix: string) {
    setDeviceConnected(true);
    setDeviceInfo(info);
    if (info?.lampsAmount) {
      setLedCount(info.lampsAmount);
    }
    setMessage(info ? `${prefix}: ${info.lampsAmount} LEDs, firmware ${info.version}` : prefix);
  }

  function applySettings(settings: AppSettings) {
    setRegions(settings.regions);
    setSelectedRegionId(settings.selectedRegionId);
    setInstallationDirection(settings.installationDirection);
    setSamplingFrameMode(settings.samplingFrameMode);
    setLedCount(settings.ledCount);
  }

  async function updateStartupEnabled(enabled: boolean) {
    setStartupBusy(true);
    try {
      const startup = await bridgeAdapter.setStartupEnabled(enabled);
      setStartupSupported(startup.supported);
      setStartupEnabled(startup.enabled);
      setMessage(startup.enabled ? 'Startup enabled' : 'Startup disabled');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Startup update failed');
    } finally {
      setStartupBusy(false);
    }
  }

  async function disconnectDevice() {
    await deviceAdapter.disconnect();
    setDeviceConnected(false);
    setDeviceInfo(null);
    setMessage('Device disconnected');
  }

  async function turnOffConnectedDevice() {
    if (!deviceConnected) {
      return;
    }

    try {
      await deviceAdapter.writeFrame(createSolidColorFrame(ledCount, BLACK));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Device turn-off failed');
      setDeviceConnected(false);
    }
  }

  async function runFrame(now: number) {
    if (!runningRef.current) {
      return;
    }

    const state = optimizerRef.current.getState();
    const minFrameMs = 1000 / state.targetFps;
    if (now - lastFrameAtRef.current < minFrameMs) {
      frameRef.current = window.requestAnimationFrame(runFrame);
      return;
    }

    const frameStartedAt = performance.now();
    lastFrameAtRef.current = now;
    frameIndexRef.current += 1;

    const sample = captureService.sampleLedFrame(regions, { direction: installationDirection, ledCount }, state.sampleStride, { mode: samplingFrameMode });
    if (!sample) {
      frameRef.current = window.requestAnimationFrame(runFrame);
      return;
    }

    const ledFrame = sample.ledFrame;
    const displayColor = sample.color;
    const suppressProtectedBlackSample = isFlatBlackLedFrame(ledFrame);

    let writeMs = 0;
    const shouldSend = !suppressProtectedBlackSample && deviceConnected && frameIndexRef.current % state.sendEvery === 0;
    if (shouldSend) {
      try {
        const write = await deviceAdapter.writeFrame(ledFrame);
        writeMs = write.writeMs;
      } catch (error) {
        setMessage(error instanceof Error ? error.message : 'Device write failed');
        setDeviceConnected(false);
      }
    }

    const frameFinishedAt = performance.now();
    const nextMetrics: SyncMetrics = {
      frameMs: frameFinishedAt - frameStartedAt,
      captureMs: sample.captureMs,
      writeMs,
      droppedFrames: Math.max(0, Math.floor((frameFinishedAt - frameStartedAt) / minFrameMs) - 1)
    };
    const nextOptimizer = optimizerRef.current.update(nextMetrics);

    if (lastUiUpdateAtRef.current === 0 || frameFinishedAt - lastUiUpdateAtRef.current >= UI_UPDATE_INTERVAL_MS) {
      lastUiUpdateAtRef.current = frameFinishedAt;
      setColor(displayColor);
      setMetrics(nextMetrics);
      setOptimizer(nextOptimizer);
    }
    frameRef.current = window.requestAnimationFrame(runFrame);
  }

  function addRegion() {
    const index = regions.length + 1;
    const y = 12 + ((index - 1) * 10) % 70;
    const region = normalizeRegion({
      id: `strip-${Date.now()}`,
      label: `Strip ${index}`,
      x: 10,
      y,
      width: 80,
      height: 8
    });
    setRegions((current) => [...current, region]);
    setSelectedRegionId(region.id);
  }

  function removeSelectedRegion() {
    const next = regions.filter((region) => region.id !== selectedRegionId);
    setRegions(next);
    setSelectedRegionId(next[0]?.id ?? '');
  }

  function resetBorderRegions() {
    setRegions(DEFAULT_REGIONS.map((region) => ({ ...region })));
    setSelectedRegionId(DEFAULT_REGIONS[0].id);
  }

  function beginDrag(event: PointerEvent<HTMLElement>, id: string, mode: DragMode) {
    const point = pointFromEvent(event);
    const region = regions.find((item) => item.id === id);
    if (!point || !region) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    previewRef.current?.setPointerCapture(event.pointerId);
    dragRef.current = {
      id,
      mode,
      pointerId: event.pointerId,
      startPointer: point,
      startRegion: region
    };
    setSelectedRegionId(id);
  }

  function updateDrag(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    const point = pointFromEvent(event);
    if (!drag || !point) {
      return;
    }

    const delta = {
      x: point.x - drag.startPointer.x,
      y: point.y - drag.startPointer.y
    };
    const nextRegion = drag.mode === 'move' ? moveRegion(drag.startRegion, delta) : resizeRegion(drag.startRegion, drag.mode, delta);
    setRegions((current) => current.map((region) => (region.id === drag.id ? nextRegion : region)));
  }

  function endDrag(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    const preview = previewRef.current;
    if (drag && preview?.hasPointerCapture(drag.pointerId)) {
      preview.releasePointerCapture(drag.pointerId);
    }
    dragRef.current = null;
    event.stopPropagation();
  }

  function pointFromEvent(event: PointerEvent<HTMLElement>): Point | null {
    const rect = previewRef.current?.getBoundingClientRect();
    if (!rect) {
      return null;
    }
    const displayPoint = {
      x: clamp(((event.clientX - rect.left) / rect.width) * 100, 0, 100),
      y: clamp(((event.clientY - rect.top) / rect.height) * 100, 0, 100)
    };
    return previewPointToFramePoint(displayPoint, samplingFrameMode);
  }

  const selectedRegion = regions.find((region) => region.id === selectedRegionId);
  const previewFrame = previewFrameBounds(samplingFrameMode);
  const chainPreview = useMemo(() => {
    let start = 1;
    return createOrderedSamplingRegions(regions, { direction: installationDirection, ledCount }).map((item) => {
      const end = start + item.ledCount - 1;
      const preview = { ...item, start, end };
      start = end + 1;
      return preview;
    });
  }, [installationDirection, ledCount, regions]);
  const colorCss = `rgb(${color.r}, ${color.g}, ${color.b})`;
  const statusLabel = status === 'syncing' ? 'Running' : status === 'capturing' ? 'Starting' : status === 'error' ? 'Error' : 'Idle';
  const statusClass = status;
  const sampledArea = effectiveDisplayAreaPercent(regions, samplingFrameMode);
  const areaLabel = `${sampledArea.toFixed(1)}% sampled`;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>DX Light Screen Sync</h1>
          <p>{message}</p>
        </div>
        <div className="status-group" aria-label="Sync state">
          <span className={`status-dot status-${statusClass}`} />
          <span>{statusLabel}</span>
        </div>
      </header>

      <section className="workspace" aria-label="Screen sync controller">
        <div className="preview-panel">
          <div className="preview-header">
            <h2>Sampling Domains</h2>
            <span>{areaLabel}</span>
          </div>
          <div
            ref={previewRef}
            className="screen-preview"
            aria-label="Editable sampling preview"
            onPointerDown={() => setSelectedRegionId('')}
            onPointerMove={updateDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <div
              className={`content-frame ${samplingFrameMode === 'center-16-9' ? 'content-frame-active' : ''}`}
              style={{
                left: `${previewFrame.x}%`,
                top: `${previewFrame.y}%`,
                width: `${previewFrame.width}%`,
                height: `${previewFrame.height}%`
              }}
            />
            {regions.map((region) => (
              <div
                key={region.id}
                className={`domain-box ${region.id === selectedRegionId ? 'domain-selected' : ''}`}
                style={domainPreviewStyle(region, samplingFrameMode)}
                onPointerDown={(event) => beginDrag(event, region.id, 'move')}
              >
                <span className="domain-label">{region.label}</span>
                {(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as ResizeHandle[]).map((handle) => (
                  <span
                    key={handle}
                    className={`resize-handle handle-${handle}`}
                    aria-hidden="true"
                    onPointerDown={(event) => beginDrag(event, region.id, handle)}
                  />
                ))}
              </div>
            ))}
            <div className="sample-color" style={{ backgroundColor: colorCss }} />
          </div>
        </div>

        <div className="controls-panel">
          <section className="control-section" aria-labelledby="capture-controls">
            <h2 id="capture-controls">Capture</h2>
            <div className="button-row">
              <button type="button" className="primary-button" onClick={startSync} disabled={status === 'syncing' || status === 'capturing'}>
                Start
              </button>
              <button type="button" onClick={stopSync} disabled={status === 'idle'}>
                Stop
              </button>
              {captureBlocked ? (
                <button type="button" onClick={() => void openInSystemBrowser()}>
                  Open Browser
                </button>
              ) : null}
            </div>
          </section>

          <section className="control-section" aria-labelledby="device-controls">
            <h2 id="device-controls">Device</h2>
            <div className="button-row">
              <button type="button" onClick={connectDevice} disabled={deviceConnected || !deviceAdapter.isSupported()}>
                Connect
              </button>
              <button type="button" onClick={disconnectDevice} disabled={!deviceConnected}>
                Disconnect
              </button>
            </div>
            <p className="device-state">
              {deviceConnected && deviceInfo
                ? `${deviceInfo.lampsAmount} LEDs, firmware ${deviceInfo.version}`
                : deviceConnected
                  ? 'Connected'
                  : deviceAdapter.isSupported()
                    ? 'Available'
                    : 'WebHID unavailable'}
            </p>
          </section>

          <section className="control-section" aria-labelledby="startup-controls">
            <h2 id="startup-controls">Startup</h2>
            <div className="button-row">
              <button type="button" onClick={() => void updateStartupEnabled(true)} disabled={!startupSupported || startupEnabled || startupBusy}>
                Enable
              </button>
              <button type="button" onClick={() => void updateStartupEnabled(false)} disabled={!startupSupported || !startupEnabled || startupBusy}>
                Disable
              </button>
            </div>
            <p className="device-state">
              {!startupSupported ? 'Unavailable' : startupEnabled ? 'Enabled at Windows sign-in' : 'Disabled'}
            </p>
          </section>

          <section className="control-section" aria-labelledby="chain-controls">
            <h2 id="chain-controls">LED Chain</h2>
            <div className="segmented-control" aria-label="Installation direction">
              <button
                type="button"
                className={installationDirection === 'left-to-right' ? 'segment-active' : ''}
                onClick={() => setInstallationDirection('left-to-right')}
              >
                Left to Right
              </button>
              <button
                type="button"
                className={installationDirection === 'right-to-left' ? 'segment-active' : ''}
                onClick={() => setInstallationDirection('right-to-left')}
              >
                Right to Left
              </button>
            </div>
            <label className="number-row">
              <span>Total LEDs</span>
              <input
                type="number"
                min="1"
                max="240"
                value={ledCount}
                onChange={(event) => setLedCount(Math.max(1, Math.min(240, Number(event.target.value) || DEFAULT_LED_COUNT)))}
              />
            </label>
          </section>

          <section className="control-section" aria-labelledby="domain-controls">
            <div className="section-title-row">
              <h2 id="domain-controls">Domains</h2>
              <span>{regions.length}</span>
            </div>
            <div className="control-field">
              <span>Sample Frame</span>
              <div className="segmented-control" aria-label="Sampling frame">
                <button
                  type="button"
                  className={samplingFrameMode === 'display' ? 'segment-active' : ''}
                  onClick={() => setSamplingFrameMode('display')}
                >
                  Full Display
                </button>
                <button
                  type="button"
                  className={samplingFrameMode === 'center-16-9' ? 'segment-active' : ''}
                  onClick={() => setSamplingFrameMode('center-16-9')}
                >
                  Centered 16:9
                </button>
              </div>
            </div>
            <div className="button-row">
              <button type="button" onClick={addRegion}>
                Add
              </button>
              <button type="button" onClick={removeSelectedRegion} disabled={!selectedRegion}>
                Remove
              </button>
              <button type="button" onClick={resetBorderRegions}>
                Reset 3 Edge
              </button>
            </div>
            <div className="domain-list" role="list" aria-label="Sampling domain list">
              {chainPreview.map((item) => (
                <button
                  key={item.region.id}
                  type="button"
                  className={`domain-list-item ${item.region.id === selectedRegionId ? 'domain-list-selected' : ''}`}
                  onClick={() => setSelectedRegionId(item.region.id)}
                >
                  <span>{item.region.label}</span>
                  <strong>{item.start}-{item.end}</strong>
                </button>
              ))}
            </div>
          </section>

          <section className="control-section" aria-labelledby="optimizer-controls">
            <h2 id="optimizer-controls">Optimizer</h2>
            <div className="metric-grid">
              <Metric label="FPS" value={optimizer.targetFps.toString()} />
              <Metric label="Stride" value={`${optimizer.sampleStride}x`} />
              <Metric label="Send" value={`1/${optimizer.sendEvery}`} />
              <Metric label="Frame" value={`${metrics.frameMs.toFixed(1)} ms`} />
              <Metric label="Capture" value={`${metrics.captureMs.toFixed(1)} ms`} />
              <Metric label="Write" value={`${metrics.writeMs.toFixed(1)} ms`} />
            </div>
            <p className="optimizer-reason">{optimizer.reason}</p>
          </section>
        </div>
      </section>
    </main>
  );
}

function domainPreviewStyle(region: SamplingRegion, samplingFrameMode: SamplingFrameMode) {
  const previewDomain = domainToPreviewDomain(region, samplingFrameMode);
  return {
    left: `${previewDomain.x}%`,
    top: `${previewDomain.y}%`,
    width: `${previewDomain.width}%`,
    height: `${previewDomain.height}%`
  };
}

async function resolveWithTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: number | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = window.setTimeout(() => resolve(fallback), timeoutMs);
      })
    ]);
  } finally {
    if (timer !== undefined) {
      window.clearTimeout(timer);
    }
  }
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function moveRegion(region: SamplingRegion, delta: Point): SamplingRegion {
  return normalizeRegion({
    ...region,
    x: region.x + delta.x,
    y: region.y + delta.y
  });
}

function resizeRegion(region: SamplingRegion, handle: ResizeHandle, delta: Point): SamplingRegion {
  let x = region.x;
  let y = region.y;
  let width = region.width;
  let height = region.height;

  if (handle.includes('w')) {
    x = region.x + delta.x;
    width = region.width - delta.x;
  }
  if (handle.includes('e')) {
    width = region.width + delta.x;
  }
  if (handle.includes('n')) {
    y = region.y + delta.y;
    height = region.height - delta.y;
  }
  if (handle.includes('s')) {
    height = region.height + delta.y;
  }

  return normalizeRegion({ ...region, x, y, width, height });
}

function normalizeRegion(region: SamplingRegion): SamplingRegion {
  return normalizeSamplingRegion(region);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

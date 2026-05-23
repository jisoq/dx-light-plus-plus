export type SyncStatus = 'idle' | 'capturing' | 'syncing' | 'error';

export interface SamplingDomain {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SamplingRegion extends SamplingDomain {
  id: string;
  label: string;
}

export type InstallationDirection = 'left-to-right' | 'right-to-left';
export type SamplingFrameMode = 'display' | 'center-16-9';

export interface SamplingFrameConfig {
  mode: SamplingFrameMode;
}

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

export interface CaptureFrame {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  timestamp: number;
}

export interface CaptureReadbackSize {
  width: number;
  height: number;
}

export interface CaptureReadbackOptions {
  targetSize?: CaptureReadbackSize;
}

export interface SampleResult {
  color: RgbColor;
  domain: SamplingDomain;
  domains: SamplingDomain[];
  sourceWidth: number;
  sourceHeight: number;
  sampledPixels: number;
  captureMs: number;
}

export interface LedSection {
  start: number;
  end: number;
  color: RgbColor;
}

export interface LedFrame {
  ledCount: number;
  sections: LedSection[];
}

export interface LedFrameSample extends SampleResult {
  ledFrame: LedFrame;
}

export interface SyncMetrics {
  frameMs: number;
  captureMs: number;
  writeMs: number;
  droppedFrames: number;
}

export interface OptimizerState {
  targetFps: number;
  sampleStride: number;
  sendEvery: number;
  reason: string;
}

export interface DeviceWriteResult {
  bytesWritten: number;
  chunks: number;
  writeMs: number;
}

export interface LightDeviceInfo {
  id: string;
  uuid: string;
  displaySize: number;
  lampsAmount: number;
  version: string;
}

export interface LightDeviceAdapter {
  readonly label: string;
  isSupported(): boolean;
  connectPaired(): Promise<LightDeviceInfo | null>;
  connect(): Promise<LightDeviceInfo | null>;
  disconnect(): Promise<void>;
  writeFrame(frame: LedFrame): Promise<DeviceWriteResult>;
}

export interface MediaContextMatch {
  processName: string;
  title: string;
}

export interface MediaContext {
  protectedLikely: boolean;
  mediaApp: 'netflix' | null;
  source: string;
  matches: MediaContextMatch[];
}

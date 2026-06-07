import type { DeviceWriteResult, LedFrame, LightDeviceAdapter, LightDeviceInfo } from '../domain/types';
import type { AppSettings } from '../settings/appSettings';

const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:8787';
const REQUEST_TIMEOUT_MS = 1200;

interface BridgeStatus {
  bridge: boolean;
  available: boolean;
  connected: boolean;
  info: LightDeviceInfo | null;
}

interface BridgeConnectResponse {
  connected: boolean;
  info: LightDeviceInfo | null;
}

export interface BridgeStartupStatus {
  supported: boolean;
  enabled: boolean;
  path: string | null;
}

interface BridgeSettingsResponse {
  settings: unknown;
}

export interface BridgeDeviceAdapterOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class BridgeLightDeviceAdapter implements LightDeviceAdapter {
  readonly label = 'Native DX Light bridge adapter';
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private connected = false;

  constructor(options: BridgeDeviceAdapterOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BRIDGE_URL;
    this.fetchImpl = options.fetchImpl ?? createDefaultFetch();
  }

  isSupported(): boolean {
    return typeof this.fetchImpl === 'function';
  }

  async connectPaired(): Promise<LightDeviceInfo | null> {
    return this.connect().catch(() => null);
  }

  async connect(): Promise<LightDeviceInfo | null> {
    const response = await this.request<BridgeConnectResponse>('/connect', { method: 'POST' });
    if (!response.connected) {
      throw new Error('DX Light bridge did not connect to the USB device.');
    }

    this.connected = true;
    return response.info;
  }

  async disconnect(): Promise<void> {
    await this.request('/disconnect', { method: 'POST' }).catch(() => undefined);
    this.connected = false;
  }

  async writeFrame(frame: LedFrame): Promise<DeviceWriteResult> {
    if (!this.connected) {
      await this.connect();
    }
    return this.request<DeviceWriteResult>('/frame', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ frame })
    });
  }

  async status(): Promise<BridgeStatus> {
    return this.request<BridgeStatus>('/status');
  }

  async getStartupStatus(): Promise<BridgeStartupStatus> {
    return this.request<BridgeStartupStatus>('/startup');
  }

  async setStartupEnabled(enabled: boolean): Promise<BridgeStartupStatus> {
    return this.request<BridgeStartupStatus>('/startup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
  }

  async loadSettings(): Promise<unknown> {
    const response = await this.request<BridgeSettingsResponse>('/settings');
    return response.settings;
  }

  async saveSettings(settings: AppSettings): Promise<void> {
    await this.request<BridgeSettingsResponse>('/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings })
    });
  }

  async openBrowser(): Promise<void> {
    await this.request('/open-browser', { method: 'POST' });
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController();
    const timer = globalThis.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal
      });
      const body = (await response.json()) as T & { error?: string };
      if (!response.ok) {
        throw new Error(body.error ?? `DX Light bridge request failed: ${response.status}`);
      }
      return body;
    } finally {
      globalThis.clearTimeout(timer);
    }
  }
}

function createDefaultFetch(): typeof fetch {
  if (typeof window !== 'undefined' && typeof window.fetch === 'function') {
    return (input, init) => window.fetch(input, init);
  }

  return (input, init) => globalThis.fetch(input, init);
}

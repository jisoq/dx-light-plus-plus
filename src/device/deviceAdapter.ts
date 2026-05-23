import type { DeviceWriteResult, LedFrame, LightDeviceAdapter, LightDeviceInfo } from '../domain/types';
import { createSolidColorFrame } from '../domain/ledFrame';

const HID_REPORT_ID = 0;
const MAX_HID_PAYLOAD_BYTES = 64;
const DEFAULT_WRITE_INTERVAL_MS = 8;
const ROBOBLOQ_LIGHT_VID = 6790;
const ROBOBLOQ_LIGHT_PID = 65031;
const ROBOBLOQ_LIGHT_USAGE_PAGE = 0xff00;
const HEADER_RB = [0x52, 0x42];
const HEADER_SC = [0x53, 0x43];
const ACTION_READ_DEVICE_INFO = 0x82;
const ACTION_SET_SYNC_SCREEN = 0x80;
export const ROBOBLOQ_HID_FILTERS = [{ vendorId: ROBOBLOQ_LIGHT_VID, productId: ROBOBLOQ_LIGHT_PID }];
const ROBOBLOQ_CONTROL_HID_FILTERS = [{ vendorId: ROBOBLOQ_LIGHT_VID, productId: ROBOBLOQ_LIGHT_PID, usagePage: ROBOBLOQ_LIGHT_USAGE_PAGE }];

export interface HidInputReportEvent {
  data: DataView;
  reportId: number;
}

export interface HidDevice {
  productName?: string;
  vendorId?: number;
  productId?: number;
  collections?: Array<{ usagePage?: number; usage?: number }>;
  opened: boolean;
  open(): Promise<void>;
  close(): Promise<void>;
  sendReport(reportId: number, data: BufferSource): Promise<void>;
  addEventListener?(type: 'inputreport', listener: (event: HidInputReportEvent) => void): void;
  removeEventListener?(type: 'inputreport', listener: (event: HidInputReportEvent) => void): void;
}

export interface HidNavigator {
  getDevices?(): Promise<HidDevice[]>;
  requestDevice(options: { filters: Array<Record<string, number>> }): Promise<HidDevice[]>;
}

export interface BrowserHidAdapterOptions {
  navigatorHid?: HidNavigator;
  filters?: Array<Record<string, number>>;
  writeIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

let protocolMessageId = 1;

export function createReadDeviceInfoPayload(messageId = nextProtocolMessageId()): Uint8Array {
  const payload = new Uint8Array(6);
  payload[0] = HEADER_RB[0];
  payload[1] = HEADER_RB[1];
  payload[2] = payload.byteLength;
  payload[3] = messageId;
  payload[4] = ACTION_READ_DEVICE_INFO;
  payload[5] = checksum(payload);
  return payload;
}

export function createSyncScreenPayload(frame: LedFrame, messageId = nextProtocolMessageId()): Uint8Array {
  const payload = new Uint8Array(7 + frame.sections.length * 5);
  payload[0] = HEADER_SC[0];
  payload[1] = HEADER_SC[1];
  writeUInt16BE(payload, payload.byteLength, 2);
  payload[4] = messageId;
  payload[5] = ACTION_SET_SYNC_SCREEN;

  let offset = 6;
  for (const section of frame.sections) {
    payload[offset] = clampByte(section.start);
    payload[offset + 1] = clampByte(section.color.r);
    payload[offset + 2] = clampByte(section.color.g);
    payload[offset + 3] = clampByte(section.color.b);
    payload[offset + 4] = clampByte(section.end);
    offset += 5;
  }

  payload[payload.byteLength - 1] = checksum(payload);
  return payload;
}

export function parseDeviceInfoReport(report: Uint8Array): LightDeviceInfo | null {
  const data = normalizeReport(report);
  if (data.byteLength < 25 || data[0] !== HEADER_RB[0] || data[1] !== HEADER_RB[1] || data[4] !== ACTION_READ_DEVICE_INFO) {
    return null;
  }

  return {
    id: hex(data.slice(5, 8)),
    displaySize: data[8],
    lampsAmount: data[11],
    uuid: hex(data.slice(12, 20)),
    version: `${data[21]}.${data[22]}.${data[23]}`
  };
}

export function chunkPayload(payload: Uint8Array, maxChunkBytes = MAX_HID_PAYLOAD_BYTES): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < payload.byteLength; offset += maxChunkBytes) {
    chunks.push(payload.slice(offset, offset + maxChunkBytes));
  }
  return chunks;
}

export class BrowserHidLightDeviceAdapter implements LightDeviceAdapter {
  readonly label = 'WebHID DX Light adapter';
  private device: HidDevice | null = null;
  private readonly navigatorHid?: HidNavigator;
  private readonly filters: Array<Record<string, number>>;
  private readonly controlFilters: Array<Record<string, number>>;
  private readonly writeIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private deviceInfo: LightDeviceInfo | null = null;
  private lastLedCount: number | null = null;

  constructor(options: BrowserHidAdapterOptions = {}) {
    this.navigatorHid = options.navigatorHid ?? readNavigatorHid();
    this.filters = options.filters ?? ROBOBLOQ_HID_FILTERS;
    this.controlFilters = ROBOBLOQ_CONTROL_HID_FILTERS;
    this.writeIntervalMs = options.writeIntervalMs ?? DEFAULT_WRITE_INTERVAL_MS;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => window.setTimeout(resolve, ms)));
  }

  isSupported(): boolean {
    return Boolean(this.navigatorHid);
  }

  async connect(): Promise<LightDeviceInfo | null> {
    if (!this.navigatorHid) {
      throw new Error('WebHID is not available in this browser.');
    }
    const devices = await this.navigatorHid.requestDevice({ filters: this.filters });
    const selected = devices[0];
    if (!selected) {
      throw new Error('No DX Light HID device was selected.');
    }
    return this.openDevice(selected);
  }

  async connectPaired(): Promise<LightDeviceInfo | null> {
    if (!this.navigatorHid?.getDevices) {
      return null;
    }

    const devices = await this.navigatorHid.getDevices();
    const selected = devices.find((device) => matchesFilters(device, this.controlFilters)) ?? devices.find((device) => matchesPairedFallback(device, this.filters));
    if (!selected) {
      return null;
    }

    return this.openDevice(selected);
  }

  async disconnect(): Promise<void> {
    if (this.device?.opened) {
      await this.turnOffDevice().catch(() => undefined);
      await this.device.close();
    }
    this.device = null;
    this.deviceInfo = null;
    this.lastLedCount = null;
  }

  async writeFrame(frame: LedFrame): Promise<DeviceWriteResult> {
    if (!this.device?.opened) {
      throw new Error('DX Light device is not connected.');
    }
    this.lastLedCount = frame.ledCount;
    const startedAt = performance.now();
    const payload = createSyncScreenPayload(frame);
    const chunks = chunkPayload(payload);

    for (const chunk of chunks) {
      const report = new ArrayBuffer(chunk.byteLength);
      new Uint8Array(report).set(chunk);
      await this.device.sendReport(HID_REPORT_ID, report);
      if (this.writeIntervalMs > 0) {
        await this.sleep(this.writeIntervalMs);
      }
    }

    return {
      bytesWritten: payload.byteLength,
      chunks: chunks.length,
      writeMs: performance.now() - startedAt
    };
  }

  private async readDeviceInfo(device: HidDevice): Promise<LightDeviceInfo | null> {
    const payload = createReadDeviceInfoPayload();
    const expectedMessageId = payload[3];
    const addInputReportListener = device.addEventListener?.bind(device);
    const removeInputReportListener = device.removeEventListener?.bind(device);
    if (!addInputReportListener || !removeInputReportListener) {
      await device.sendReport(HID_REPORT_ID, toArrayBuffer(payload));
      return null;
    }

    return new Promise((resolve) => {
      let settled = false;
      const cleanup = () => {
        removeInputReportListener('inputreport', listener);
        globalThis.clearTimeout(timer);
      };
      const finish = (info: LightDeviceInfo | null) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(info);
      };
      const listener = (event: HidInputReportEvent) => {
        const data = new Uint8Array(event.data.buffer.slice(event.data.byteOffset, event.data.byteOffset + event.data.byteLength));
        const normalized = normalizeReport(data);
        if (normalized[3] !== expectedMessageId) {
          return;
        }
        finish(parseDeviceInfoReport(normalized));
      };
      const timer = globalThis.setTimeout(() => finish(null), 300);

      addInputReportListener('inputreport', listener);
      device.sendReport(HID_REPORT_ID, toArrayBuffer(payload)).catch(() => finish(null));
    });
  }

  private async openDevice(selected: HidDevice): Promise<LightDeviceInfo | null> {
    if (!selected.opened) {
      await selected.open();
    }
    this.device = selected;
    this.deviceInfo = await this.readDeviceInfo(selected);
    this.lastLedCount = this.deviceInfo?.lampsAmount ?? this.lastLedCount;
    return this.deviceInfo;
  }

  private async turnOffDevice(): Promise<void> {
    const ledCount = this.deviceInfo?.lampsAmount ?? this.lastLedCount;
    if (!ledCount || !this.device?.opened) {
      return;
    }

    await this.writeFrame(createSolidColorFrame(ledCount, { r: 0, g: 0, b: 0 }));
  }
}

function readNavigatorHid(): HidNavigator | undefined {
  if (typeof navigator === 'undefined') {
    return undefined;
  }
  return (navigator as Navigator & { hid?: HidNavigator }).hid;
}

function nextProtocolMessageId(): number {
  protocolMessageId += 1;
  if (protocolMessageId >= 255) {
    protocolMessageId = 1;
  }
  return protocolMessageId;
}

function checksum(payload: Uint8Array): number {
  let total = 0;
  for (const byte of payload) {
    total += byte;
  }
  return total & 0xff;
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function writeUInt16BE(target: Uint8Array, value: number, offset: number): void {
  target[offset] = (value >> 8) & 0xff;
  target[offset + 1] = value & 0xff;
}

function normalizeReport(report: Uint8Array): Uint8Array {
  if (report[0] === 0 && report[1] === HEADER_RB[0] && report[2] === HEADER_RB[1]) {
    return report.slice(1);
  }
  return report;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function matchesFilters(device: HidDevice, filters: Array<Record<string, number>>): boolean {
  return filters.some((filter) => {
    if (typeof filter.vendorId === 'number' && device.vendorId !== filter.vendorId) {
      return false;
    }
    if (typeof filter.productId === 'number' && device.productId !== filter.productId) {
      return false;
    }
    if (typeof filter.usagePage === 'number') {
      return Boolean(device.collections?.some((collection) => collection.usagePage === filter.usagePage));
    }
    return true;
  });
}

function matchesPairedFallback(device: HidDevice, filters: Array<Record<string, number>>): boolean {
  return matchesFilters(device, filters) && (!device.collections || device.collections.length === 0);
}

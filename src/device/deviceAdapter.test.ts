import { describe, expect, it } from 'vitest';
import {
  BrowserHidLightDeviceAdapter,
  ROBOBLOQ_HID_FILTERS,
  chunkPayload,
  createReadDeviceInfoPayload,
  createSyncScreenPayload,
  parseDeviceInfoReport,
  type HidDevice
} from './deviceAdapter';

describe('device adapter', () => {
  it('creates the manufacturer sync-screen payload', () => {
    const payload = createSyncScreenPayload({
      ledCount: 2,
      sections: [
        { start: 1, end: 1, color: { r: 12, g: 34, b: 56 } },
        { start: 2, end: 2, color: { r: 78, g: 90, b: 100 } }
      ]
    }, 7);

    expect(Array.from(payload.slice(0, -1))).toEqual([
      0x53, 0x43, 0x00, 0x11, 0x07, 0x80,
      0x01, 12, 34, 56, 0x01,
      0x02, 78, 90, 100, 0x02
    ]);
    expect(payload[payload.length - 1]).toBe(Array.from(payload.slice(0, -1)).reduce((total, byte) => total + byte, 0) & 0xff);
  });

  it('parses the ROBOBLOQ read-device-info report', () => {
    const report = bytesFromHex('52421902820006032201004b00112233445566777f01090400000000000000000000000000000000000000000000000000000000000000000000000000000000');

    expect(createReadDeviceInfoPayload(2)[4]).toBe(0x82);
    expect(parseDeviceInfoReport(report)).toEqual({
      id: '000603',
      displaySize: 34,
      lampsAmount: 75,
      uuid: '0011223344556677',
      version: '1.9.4'
    });
  });

  it('chunks HID payloads at the 64 byte boundary', () => {
    const chunks = chunkPayload(new Uint8Array(145));

    expect(chunks.map((chunk) => chunk.byteLength)).toEqual([64, 64, 17]);
  });

  it('opens the selected HID device and writes paced chunks', async () => {
    const sent: number[] = [];
    const device: HidDevice = {
      opened: false,
      async open() {
        this.opened = true;
      },
      async close() {
        this.opened = false;
      },
      async sendReport(_reportId, data) {
        sent.push(data instanceof Uint8Array ? data.byteLength : data.byteLength);
      }
    };
    const adapter = new BrowserHidLightDeviceAdapter({
      navigatorHid: {
        async requestDevice() {
          return [device];
        }
      },
      sleep: async () => undefined,
      writeIntervalMs: 0
    });

    await adapter.connect();
    const result = await adapter.writeFrame({
      ledCount: 1,
      sections: [{ start: 1, end: 1, color: { r: 1, g: 2, b: 3 } }]
    });

    expect(result.bytesWritten).toBe(12);
    expect(result.chunks).toBe(1);
    expect(sent).toEqual([6, 12]);
  });

  it('turns LEDs off before closing a connected HID device', async () => {
    const sent: Uint8Array[] = [];
    const device: HidDevice = {
      opened: false,
      async open() {
        this.opened = true;
      },
      async close() {
        this.opened = false;
      },
      async sendReport(_reportId, data) {
        sent.push(bytesFromBufferSource(data));
      }
    };
    const adapter = new BrowserHidLightDeviceAdapter({
      navigatorHid: {
        async requestDevice() {
          return [device];
        }
      },
      sleep: async () => undefined,
      writeIntervalMs: 0
    });

    await adapter.connect();
    await adapter.writeFrame({
      ledCount: 1,
      sections: [{ start: 1, end: 1, color: { r: 10, g: 20, b: 30 } }]
    });
    await adapter.disconnect();

    expect(device.opened).toBe(false);
    expect(Array.from((sent[sent.length - 1] ?? new Uint8Array()).slice(6, 11))).toEqual([1, 0, 0, 0, 1]);
  });

  it('auto-connects a previously paired ROBOBLOQ control interface without prompting', async () => {
    const sent: number[] = [];
    let requestDeviceCalled = false;
    const device: HidDevice = {
      vendorId: 6790,
      productId: 65031,
      collections: [{ usagePage: 0xff00, usage: 1 }],
      opened: false,
      async open() {
        this.opened = true;
      },
      async close() {
        this.opened = false;
      },
      async sendReport(_reportId, data) {
        sent.push(data.byteLength);
      }
    };
    const adapter = new BrowserHidLightDeviceAdapter({
      navigatorHid: {
        async getDevices() {
          return [device];
        },
        async requestDevice() {
          requestDeviceCalled = true;
          return [];
        }
      },
      sleep: async () => undefined,
      writeIntervalMs: 0
    });

    await adapter.connectPaired();
    await adapter.writeFrame({
      ledCount: 1,
      sections: [{ start: 1, end: 1, color: { r: 1, g: 2, b: 3 } }]
    });

    expect(requestDeviceCalled).toBe(false);
    expect(device.opened).toBe(true);
    expect(sent).toEqual([6, 12]);
  });

  it('ignores paired HID devices that are not the vendor control interface', async () => {
    const keyboardInterface: HidDevice = {
      vendorId: 6790,
      productId: 65031,
      collections: [{ usagePage: 1, usage: 6 }],
      opened: false,
      async open() {
        this.opened = true;
      },
      async close() {},
      async sendReport() {}
    };
    const adapter = new BrowserHidLightDeviceAdapter({
      navigatorHid: {
        async getDevices() {
          return [keyboardInterface];
        },
        async requestDevice() {
          return [];
        }
      }
    });

    await expect(adapter.connectPaired()).resolves.toBeNull();
    expect(keyboardInterface.opened).toBe(false);
  });

  it('requests only confirmed ROBOBLOQ light HID devices by default', async () => {
    let filters: Array<Record<string, number>> = [];
    const adapter = new BrowserHidLightDeviceAdapter({
      navigatorHid: {
        async requestDevice(options) {
          filters = options.filters;
          return [];
        }
      }
    });

    await expect(adapter.connect()).rejects.toThrow('No DX Light HID device');
    expect(filters).toEqual(ROBOBLOQ_HID_FILTERS);
  });
});

function bytesFromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bytesFromBufferSource(source: BufferSource): Uint8Array {
  if (source instanceof Uint8Array) {
    return source;
  }
  if (source instanceof ArrayBuffer) {
    return new Uint8Array(source);
  }
  return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
}

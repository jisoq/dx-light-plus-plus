import { describe, expect, it } from 'vitest';
import { BridgeLightDeviceAdapter } from './bridgeDeviceAdapter';

describe('BridgeLightDeviceAdapter', () => {
  it('binds the default browser fetch so Window.fetch does not throw Illegal invocation', async () => {
    const originalFetch = globalThis.fetch;
    try {
      Object.defineProperty(globalThis, 'window', {
        value: {
          fetch(this: unknown, url: string, init?: RequestInit) {
            if (this !== globalThis.window) {
              throw new TypeError('Illegal invocation');
            }
            expect(url).toBe('http://bridge.test/status');
            expect(init?.signal).toBeInstanceOf(AbortSignal);
            return Promise.resolve(jsonResponse({ bridge: true, available: true, connected: true, info: null }));
          }
        },
        configurable: true
      });
      Object.defineProperty(globalThis, 'fetch', {
        value: globalThis.window.fetch,
        configurable: true
      });

      const adapter = new BridgeLightDeviceAdapter({ baseUrl: 'http://bridge.test' });

      await expect(adapter.status()).resolves.toMatchObject({ bridge: true, connected: true });
    } finally {
      Object.defineProperty(globalThis, 'fetch', {
        value: originalFetch,
        configurable: true
      });
      Reflect.deleteProperty(globalThis, 'window');
    }
  });

  it('connects through the native bridge when the USB device is available', async () => {
    const calls: string[] = [];
    const adapter = new BridgeLightDeviceAdapter({
      baseUrl: 'http://bridge.test',
      fetchImpl: (async (url, init) => {
        calls.push(`${init?.method ?? 'GET'} ${url}`);
        if (String(url).endsWith('/connect')) {
          return jsonResponse({ connected: true, info: { id: '000603', uuid: 'abc', displaySize: 34, lampsAmount: 75, version: '1.9.4' } });
        }
        return jsonResponse({}, 404);
      }) as typeof fetch
    });

    const info = await adapter.connectPaired();

    expect(info?.lampsAmount).toBe(75);
    expect(calls).toEqual(['POST http://bridge.test/connect']);
  });

  it('writes LED frames through the bridge endpoint', async () => {
    let frameBody = '';
    const adapter = new BridgeLightDeviceAdapter({
      baseUrl: 'http://bridge.test',
      fetchImpl: (async (url, init) => {
        if (String(url).endsWith('/connect')) {
          return jsonResponse({ connected: true, info: null });
        }
        if (String(url).endsWith('/frame')) {
          frameBody = String(init?.body);
          return jsonResponse({ bytesWritten: 12, chunks: 1, writeMs: 0.5 });
        }
        return jsonResponse({}, 404);
      }) as typeof fetch
    });

    const result = await adapter.writeFrame({
      ledCount: 1,
      sections: [{ start: 1, end: 1, color: { r: 1, g: 2, b: 3 } }]
    });

    expect(result.bytesWritten).toBe(12);
    expect(JSON.parse(frameBody).frame.sections[0].color).toEqual({ r: 1, g: 2, b: 3 });
  });

  it('returns null when the bridge is running but no device is available', async () => {
    const adapter = new BridgeLightDeviceAdapter({
      baseUrl: 'http://bridge.test',
      fetchImpl: (async () => jsonResponse({ error: 'DX Light USB HID control interface was not found.' }, 500)) as typeof fetch
    });

    await expect(adapter.connectPaired()).resolves.toBeNull();
  });

  it('reads and updates Windows startup state through the bridge', async () => {
    const calls: string[] = [];
    const adapter = new BridgeLightDeviceAdapter({
      baseUrl: 'http://bridge.test',
      fetchImpl: (async (url, init) => {
        calls.push(`${init?.method ?? 'GET'} ${url} ${init?.body ?? ''}`.trim());
        return jsonResponse({ supported: true, enabled: init?.method === 'POST', path: 'Startup/DX Light Screen Sync Bridge.vbs' });
      }) as typeof fetch
    });

    await expect(adapter.getStartupStatus()).resolves.toMatchObject({ supported: true, enabled: false });
    await expect(adapter.setStartupEnabled(true)).resolves.toMatchObject({ supported: true, enabled: true });
    expect(calls).toEqual([
      'GET http://bridge.test/startup',
      'POST http://bridge.test/startup {"enabled":true}'
    ]);
  });

  it('loads and saves app settings through the bridge', async () => {
    const bodies: string[] = [];
    const adapter = new BridgeLightDeviceAdapter({
      baseUrl: 'http://bridge.test',
      fetchImpl: (async (url, init) => {
        if (String(url).endsWith('/settings') && init?.method === 'POST') {
          bodies.push(String(init.body));
          return jsonResponse({ settings: JSON.parse(String(init.body)).settings });
        }
        return jsonResponse({ settings: { ledCount: 75 } });
      }) as typeof fetch
    });

    await expect(adapter.loadSettings()).resolves.toEqual({ ledCount: 75 });
    await adapter.saveSettings({
      regions: [{ id: 'top', label: 'Top', x: 0, y: 0, width: 100, height: 8 }],
      selectedRegionId: 'top',
      installationDirection: 'left-to-right',
      samplingFrameMode: 'display',
      ledCount: 75
    });

    expect(JSON.parse(bodies[0]).settings.selectedRegionId).toBe('top');
  });

  it('asks the bridge to open the app in the system browser', async () => {
    const calls: string[] = [];
    const adapter = new BridgeLightDeviceAdapter({
      baseUrl: 'http://bridge.test',
      fetchImpl: (async (url, init) => {
        calls.push(`${init?.method ?? 'GET'} ${url}`);
        return jsonResponse({ ok: true });
      }) as typeof fetch
    });

    await adapter.openBrowser();

    expect(calls).toEqual(['POST http://bridge.test/open-browser']);
  });

});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    }
  } as Response;
}

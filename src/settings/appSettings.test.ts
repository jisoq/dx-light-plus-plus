import { describe, expect, it } from 'vitest';
import { DEFAULT_REGIONS, loadLocalAppSettings, normalizeAppSettings, saveLocalAppSettings } from './appSettings';

describe('app settings', () => {
  it('normalizes missing settings to the commercial default border layout', () => {
    expect(normalizeAppSettings(null)).toEqual({
      regions: DEFAULT_REGIONS,
      selectedRegionId: 'left-edge',
      installationDirection: 'left-to-right',
      samplingFrameMode: 'display',
      ledCount: 75
    });
  });

  it('keeps valid user settings and clamps unsafe numeric values', () => {
    const settings = normalizeAppSettings({
      regions: [
        { id: 'custom', label: 'Custom', x: 96, y: -4, width: 20, height: 2 }
      ],
      selectedRegionId: 'custom',
      installationDirection: 'right-to-left',
      samplingFrameMode: 'center-16-9',
      ledCount: 999
    });

    expect(settings).toMatchObject({
      selectedRegionId: 'custom',
      installationDirection: 'right-to-left',
      samplingFrameMode: 'center-16-9',
      ledCount: 240
    });
    expect(settings.regions[0]).toMatchObject({ x: 80, y: 0, width: 20, height: 3 });
  });

  it('round-trips settings through local storage', () => {
    const storage = new MemoryStorage();
    const settings = normalizeAppSettings({
      regions: [{ id: 'top', label: 'Top', x: 0, y: 0, width: 100, height: 8 }],
      selectedRegionId: 'top',
      installationDirection: 'right-to-left',
      samplingFrameMode: 'center-16-9',
      ledCount: 75
    });

    saveLocalAppSettings(settings, storage);

    expect(loadLocalAppSettings(storage)).toEqual(settings);
  });
});

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

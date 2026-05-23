import type { InstallationDirection, SamplingFrameMode, SamplingRegion } from '../domain/types';

export const DEFAULT_REGIONS: SamplingRegion[] = [
  { id: 'left-edge', label: 'Left edge', x: 0, y: 8, width: 8, height: 84 },
  { id: 'top-edge', label: 'Top edge', x: 0, y: 0, width: 100, height: 8 },
  { id: 'right-edge', label: 'Right edge', x: 92, y: 8, width: 8, height: 84 }
];

export const DEFAULT_LED_COUNT = 75;
export const MIN_REGION_SIZE = 3;
export const APP_SETTINGS_STORAGE_KEY = 'dx-light-screen-sync-settings';

export interface AppSettings {
  regions: SamplingRegion[];
  selectedRegionId: string;
  installationDirection: InstallationDirection;
  samplingFrameMode: SamplingFrameMode;
  ledCount: number;
}

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  regions: DEFAULT_REGIONS,
  selectedRegionId: DEFAULT_REGIONS[0].id,
  installationDirection: 'left-to-right',
  samplingFrameMode: 'display',
  ledCount: DEFAULT_LED_COUNT
};

export function normalizeAppSettings(input: unknown): AppSettings {
  const source = isRecord(input) ? input : {};
  const regions = normalizeRegions(source.regions);
  const selectedRegionId = typeof source.selectedRegionId === 'string' && regions.some((region) => region.id === source.selectedRegionId)
    ? source.selectedRegionId
    : regions[0]?.id ?? '';

  return {
    regions,
    selectedRegionId,
    installationDirection: source.installationDirection === 'right-to-left' ? 'right-to-left' : 'left-to-right',
    samplingFrameMode: source.samplingFrameMode === 'center-16-9' ? 'center-16-9' : 'display',
    ledCount: clampInteger(source.ledCount, 1, 240, DEFAULT_LED_COUNT)
  };
}

export function loadLocalAppSettings(storage: KeyValueStorage | undefined = getBrowserStorage()): AppSettings {
  if (!storage) {
    return normalizeAppSettings(DEFAULT_APP_SETTINGS);
  }

  try {
    const raw = storage.getItem(APP_SETTINGS_STORAGE_KEY);
    return normalizeAppSettings(raw ? JSON.parse(raw) : DEFAULT_APP_SETTINGS);
  } catch {
    return normalizeAppSettings(DEFAULT_APP_SETTINGS);
  }
}

export function saveLocalAppSettings(settings: AppSettings, storage: KeyValueStorage | undefined = getBrowserStorage()): void {
  if (!storage) {
    return;
  }

  storage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify(normalizeAppSettings(settings)));
}

export function normalizeSamplingRegion(region: SamplingRegion): SamplingRegion {
  const width = clampNumber(region.width, MIN_REGION_SIZE, 100, DEFAULT_REGIONS[0].width);
  const height = clampNumber(region.height, MIN_REGION_SIZE, 100, DEFAULT_REGIONS[0].height);
  const x = clampNumber(region.x, 0, 100 - width, 0);
  const y = clampNumber(region.y, 0, 100 - height, 0);

  return {
    ...region,
    id: region.id || `strip-${Date.now()}`,
    label: region.label || 'Strip',
    x: roundPercent(x),
    y: roundPercent(y),
    width: roundPercent(width),
    height: roundPercent(height)
  };
}

function normalizeRegions(input: unknown): SamplingRegion[] {
  if (!Array.isArray(input)) {
    return DEFAULT_REGIONS.map((region) => ({ ...region }));
  }

  const regions = input
    .filter(isSamplingRegionCandidate)
    .slice(0, 12)
    .map((region, index) => normalizeSamplingRegion({
      id: region.id.trim() || `strip-${index + 1}`,
      label: region.label.trim() || `Strip ${index + 1}`,
      x: Number(region.x),
      y: Number(region.y),
      width: Number(region.width),
      height: Number(region.height)
    }));

  return regions.length > 0 ? regions : DEFAULT_REGIONS.map((region) => ({ ...region }));
}

function isSamplingRegionCandidate(value: unknown): value is SamplingRegion {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.label === 'string'
    && Number.isFinite(Number(value.x))
    && Number.isFinite(Number(value.y))
    && Number.isFinite(Number(value.width))
    && Number.isFinite(Number(value.height));
}

function getBrowserStorage(): KeyValueStorage | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }
  return window.localStorage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(number)));
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, number));
}

function roundPercent(value: number): number {
  return Math.round(value * 10) / 10;
}

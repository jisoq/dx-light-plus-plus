import type { LedFrame, RgbColor } from './types';

export const DEFAULT_LED_BRIGHTNESS_GAIN = 1;
export const MAX_LED_BRIGHTNESS_GAIN = 2;

export function boostRgbColor(color: RgbColor, gain = DEFAULT_LED_BRIGHTNESS_GAIN): RgbColor {
  const safeGain = normalizeBrightnessGain(gain);
  return {
    r: clampByte(color.r * safeGain),
    g: clampByte(color.g * safeGain),
    b: clampByte(color.b * safeGain)
  };
}

export function boostLedFrame(frame: LedFrame, gain = DEFAULT_LED_BRIGHTNESS_GAIN): LedFrame {
  return {
    ledCount: frame.ledCount,
    sections: frame.sections.map((section) => ({
      ...section,
      color: boostRgbColor(section.color, gain)
    }))
  };
}

export function normalizeBrightnessGain(value: number, fallback = DEFAULT_LED_BRIGHTNESS_GAIN): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(MAX_LED_BRIGHTNESS_GAIN, Math.max(1, value));
}

function clampByte(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(255, Math.round(value)));
}

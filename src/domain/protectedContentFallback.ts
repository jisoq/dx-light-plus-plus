import type { LedFrame, LedFrameSample, RgbColor } from './types';

const BLOCKED_BRIGHTNESS_THRESHOLD = 8;
const BLOCKED_SPREAD_THRESHOLD = 6;

export interface FallbackFrameOptions {
  ledCount: number;
  timeMs: number;
}

export function isProtectedCaptureSample(sample: LedFrameSample): boolean {
  let maxChannel = 0;
  let minChannel = 255;

  for (const section of sample.ledFrame.sections) {
    for (const value of [section.color.r, section.color.g, section.color.b]) {
      maxChannel = Math.max(maxChannel, value);
      minChannel = Math.min(minChannel, value);
    }
  }

  const averageBrightness = (sample.color.r + sample.color.g + sample.color.b) / 3;
  return averageBrightness <= BLOCKED_BRIGHTNESS_THRESHOLD && maxChannel <= BLOCKED_BRIGHTNESS_THRESHOLD && maxChannel - minChannel <= BLOCKED_SPREAD_THRESHOLD;
}

export function createProtectedContentFallbackFrame({ ledCount, timeMs }: FallbackFrameOptions): LedFrame {
  const safeLedCount = Math.max(1, Math.round(ledCount));
  const phase = timeMs / 1400;
  const sections = Array.from({ length: safeLedCount }, (_, index) => {
    const position = safeLedCount === 1 ? 0 : index / (safeLedCount - 1);
    const wave = (Math.sin((position * Math.PI * 2) + phase) + 1) / 2;
    const slowWave = (Math.sin((position * Math.PI * 1.25) - phase * 0.65) + 1) / 2;

    return {
      start: index + 1,
      end: index + 1,
      color: {
        r: Math.round(32 + wave * 92),
        g: Math.round(10 + slowWave * 30),
        b: Math.round(28 + (1 - wave) * 72)
      }
    };
  });

  return {
    ledCount: safeLedCount,
    sections
  };
}

export function frameAverageColor(frame: LedFrame): RgbColor {
  if (frame.sections.length === 0) {
    return { r: 0, g: 0, b: 0 };
  }

  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (const section of frame.sections) {
    const sectionCount = Math.max(1, section.end - section.start + 1);
    r += section.color.r * sectionCount;
    g += section.color.g * sectionCount;
    b += section.color.b * sectionCount;
    count += sectionCount;
  }

  return {
    r: Math.round(r / count),
    g: Math.round(g / count),
    b: Math.round(b / count)
  };
}

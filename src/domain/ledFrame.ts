import type { LedFrame, RgbColor } from './types';

const FLAT_BLACK_CHANNEL_THRESHOLD = 2;

export function createSolidColorFrame(ledCount: number, color: RgbColor): LedFrame {
  const safeLedCount = Number.isFinite(ledCount) ? Math.max(1, Math.round(ledCount)) : 1;
  return {
    ledCount: safeLedCount,
    sections: [
      {
        start: 1,
        end: safeLedCount,
        color
      }
    ]
  };
}

export function isFlatBlackLedFrame(frame: LedFrame): boolean {
  if (frame.sections.length === 0) {
    return false;
  }

  return frame.sections.every((section) =>
    isFlatBlackChannel(section.color.r) &&
    isFlatBlackChannel(section.color.g) &&
    isFlatBlackChannel(section.color.b)
  );
}

function isFlatBlackChannel(value: number): boolean {
  return Number.isFinite(value) && value <= FLAT_BLACK_CHANNEL_THRESHOLD;
}

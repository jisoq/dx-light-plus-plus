import type { LedFrame, RgbColor } from './types';

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

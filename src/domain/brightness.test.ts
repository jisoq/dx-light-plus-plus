import { describe, expect, it } from 'vitest';
import { boostLedFrame, boostRgbColor, normalizeBrightnessGain } from './brightness';

describe('brightness gain', () => {
  it('boosts mid-level RGB channels and clamps at byte range', () => {
    expect(boostRgbColor({ r: 80, g: 120, b: 240 }, 1.25)).toEqual({ r: 100, g: 150, b: 255 });
  });

  it('clamps gain to the supported range', () => {
    expect(normalizeBrightnessGain(0.4)).toBe(1);
    expect(normalizeBrightnessGain(3)).toBe(2);
    expect(normalizeBrightnessGain(Number.NaN)).toBe(1);
  });

  it('applies the same gain to every LED section', () => {
    const frame = boostLedFrame({
      ledCount: 2,
      sections: [
        { start: 1, end: 1, color: { r: 10, g: 20, b: 30 } },
        { start: 2, end: 2, color: { r: 0, g: 200, b: 255 } }
      ]
    }, 1.25);

    expect(frame.sections).toEqual([
      { start: 1, end: 1, color: { r: 13, g: 25, b: 38 } },
      { start: 2, end: 2, color: { r: 0, g: 250, b: 255 } }
    ]);
  });
});

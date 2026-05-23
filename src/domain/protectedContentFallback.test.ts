import { describe, expect, it } from 'vitest';
import { createProtectedContentFallbackFrame, frameAverageColor, isProtectedCaptureSample } from './protectedContentFallback';
import type { LedFrameSample } from './types';

describe('protected content fallback', () => {
  it('detects flat black protected-capture samples', () => {
    expect(isProtectedCaptureSample(sampleWithColors([
      { r: 0, g: 0, b: 0 },
      { r: 1, g: 1, b: 1 },
      { r: 0, g: 0, b: 0 }
    ]))).toBe(true);
  });

  it('does not treat naturally dark but varied samples as blocked', () => {
    expect(isProtectedCaptureSample(sampleWithColors([
      { r: 3, g: 2, b: 1 },
      { r: 24, g: 8, b: 5 },
      { r: 4, g: 3, b: 16 }
    ]))).toBe(false);
  });

  it('creates one fallback section per LED with changing ambient colors', () => {
    const frame = createProtectedContentFallbackFrame({ ledCount: 5, timeMs: 1000 });

    expect(frame.ledCount).toBe(5);
    expect(frame.sections.map((section) => section.start)).toEqual([1, 2, 3, 4, 5]);
    expect(frame.sections.every((section) => section.color.r > 0 || section.color.b > 0)).toBe(true);
    expect(new Set(frame.sections.map((section) => `${section.color.r},${section.color.g},${section.color.b}`)).size).toBeGreaterThan(1);
  });

  it('averages generated frame colors for UI preview', () => {
    const color = frameAverageColor({
      ledCount: 2,
      sections: [
        { start: 1, end: 1, color: { r: 10, g: 20, b: 30 } },
        { start: 2, end: 2, color: { r: 30, g: 40, b: 50 } }
      ]
    });

    expect(color).toEqual({ r: 20, g: 30, b: 40 });
  });
});

function sampleWithColors(colors: Array<{ r: number; g: number; b: number }>): LedFrameSample {
  return {
    color: average(colors),
    domain: { x: 0, y: 0, width: 10, height: 10 },
    domains: [{ x: 0, y: 0, width: 10, height: 10 }],
    sourceWidth: 10,
    sourceHeight: 10,
    sampledPixels: colors.length,
    captureMs: 1,
    ledFrame: {
      ledCount: colors.length,
      sections: colors.map((color, index) => ({
        start: index + 1,
        end: index + 1,
        color
      }))
    }
  };
}

function average(colors: Array<{ r: number; g: number; b: number }>) {
  return {
    r: Math.round(colors.reduce((total, color) => total + color.r, 0) / colors.length),
    g: Math.round(colors.reduce((total, color) => total + color.g, 0) / colors.length),
    b: Math.round(colors.reduce((total, color) => total + color.b, 0) / colors.length)
  };
}

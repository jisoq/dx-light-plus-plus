import { describe, expect, it } from 'vitest';
import { averageDomainColor, clampDomain, combineSampleResults, percentDomainToPixels } from './sampling';
import type { SampleResult } from './types';

describe('sampling', () => {
  it('clamps the sampling domain inside the source frame', () => {
    expect(clampDomain({ x: 8, y: 6, width: 10, height: 10 }, 10, 8)).toEqual({
      x: 8,
      y: 6,
      width: 2,
      height: 2
    });
  });

  it('averages RGB pixels inside the selected domain', () => {
    const data = new Uint8ClampedArray([
      255, 0, 0, 255, 0, 255, 0, 255,
      0, 0, 255, 255, 255, 255, 255, 255
    ]);

    const sample = averageDomainColor({ width: 2, height: 2, data, timestamp: 0 }, { x: 0, y: 0, width: 2, height: 2 });

    expect(sample.color).toEqual({ r: 128, g: 128, b: 128 });
    expect(sample.sampledPixels).toBe(4);
  });

  it('converts percent domains to pixels', () => {
    expect(percentDomainToPixels({ x: 25, y: 10, width: 50, height: 80 }, 200, 100)).toEqual({
      x: 50,
      y: 10,
      width: 100,
      height: 80
    });
  });

  it('combines multiple sampled domains by sampled pixel weight', () => {
    const samples: SampleResult[] = [
      {
        color: { r: 100, g: 0, b: 0 },
        domain: { x: 0, y: 0, width: 10, height: 2 },
        domains: [{ x: 0, y: 0, width: 10, height: 2 }],
        sourceWidth: 10,
        sourceHeight: 10,
        sampledPixels: 2,
        captureMs: 1
      },
      {
        color: { r: 0, g: 0, b: 100 },
        domain: { x: 0, y: 8, width: 10, height: 2 },
        domains: [{ x: 0, y: 8, width: 10, height: 2 }],
        sourceWidth: 10,
        sourceHeight: 10,
        sampledPixels: 2,
        captureMs: 1
      }
    ];

    const combined = combineSampleResults(samples, 10, 10, 5);

    expect(combined?.color).toEqual({ r: 50, g: 0, b: 50 });
    expect(combined?.domain).toEqual({ x: 0, y: 0, width: 10, height: 10 });
    expect(combined?.domains).toHaveLength(2);
    expect(combined?.captureMs).toBe(5);
  });
});

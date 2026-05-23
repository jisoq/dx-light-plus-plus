import { describe, expect, it } from 'vitest';
import { domainToPreviewDomain, effectiveDisplayAreaPercent, percentDomainToFramePixels, previewPointToFramePoint, samplingFrameBounds } from './samplingFrame';

describe('sampling frame', () => {
  it('centers a 16:9 content frame inside a 21:9 source', () => {
    expect(samplingFrameBounds(2100, 900, { mode: 'center-16-9' })).toEqual({
      x: 250,
      y: 0,
      width: 1600,
      height: 900
    });
  });

  it('maps percentage domains through the selected content frame', () => {
    expect(percentDomainToFramePixels({ x: 0, y: 8, width: 8, height: 84 }, 2100, 900, { mode: 'center-16-9' })).toEqual({
      x: 250,
      y: 72,
      width: 128,
      height: 756
    });
  });

  it('maps preview domains into the centered 16:9 visual area', () => {
    const left = domainToPreviewDomain({ x: 0, y: 0, width: 8, height: 100 }, 'center-16-9');

    expect(left.x).toBeCloseTo(11.9, 1);
    expect(left.width).toBeCloseTo(6.1, 1);
  });

  it('converts preview pointer coordinates back to content-frame coordinates', () => {
    const point = previewPointToFramePoint({ x: 11.9, y: 50 }, 'center-16-9');

    expect(point.x).toBeCloseTo(0, 1);
    expect(point.y).toBeCloseTo(50, 1);
  });

  it('reports effective sampled area against the full display', () => {
    const area = effectiveDisplayAreaPercent([{ x: 0, y: 0, width: 100, height: 10 }], 'center-16-9');

    expect(area).toBeCloseTo(7.62, 2);
  });
});

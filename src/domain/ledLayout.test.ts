import { describe, expect, it } from 'vitest';
import { createOrderedSamplingRegions, mergeAdjacentSections, sectionColorAverage } from './ledLayout';
import type { SamplingRegion } from './types';

const regions: SamplingRegion[] = [
  { id: 'top-edge', label: 'Top edge', x: 0, y: 0, width: 100, height: 8 },
  { id: 'left-edge', label: 'Left edge', x: 0, y: 8, width: 8, height: 84 },
  { id: 'right-edge', label: 'Right edge', x: 92, y: 8, width: 8, height: 84 }
];

describe('LED layout', () => {
  it('orders a three-strip chain from left to top to right', () => {
    const ordered = createOrderedSamplingRegions(regions, { direction: 'left-to-right', ledCount: 75 });

    expect(ordered.map((item) => item.region.id)).toEqual(['left-edge', 'top-edge', 'right-edge']);
    expect(ordered.map((item) => item.direction)).toEqual(['vertical-reverse', 'horizontal-forward', 'vertical-forward']);
    expect(ordered.map((item) => item.ledCount)).toEqual([25, 25, 25]);
  });

  it('mirrors the physical chain when installed right to left', () => {
    const ordered = createOrderedSamplingRegions(regions, { direction: 'right-to-left', ledCount: 75 });

    expect(ordered.map((item) => item.region.id)).toEqual(['right-edge', 'top-edge', 'left-edge']);
    expect(ordered.map((item) => item.direction)).toEqual(['vertical-reverse', 'horizontal-reverse', 'vertical-forward']);
  });

  it('averages LED sections by covered LED count', () => {
    expect(sectionColorAverage([
      { start: 1, end: 1, color: { r: 100, g: 0, b: 0 } },
      { start: 2, end: 3, color: { r: 0, g: 0, b: 100 } }
    ])).toEqual({ r: 33, g: 0, b: 67 });
  });

  it('merges adjacent sections with nearly identical colors', () => {
    expect(mergeAdjacentSections([
      { start: 1, end: 1, color: { r: 10, g: 20, b: 30 } },
      { start: 2, end: 2, color: { r: 12, g: 20, b: 31 } },
      { start: 3, end: 3, color: { r: 80, g: 20, b: 31 } }
    ], 3)).toEqual([
      { start: 1, end: 2, color: { r: 11, g: 20, b: 31 } },
      { start: 3, end: 3, color: { r: 80, g: 20, b: 31 } }
    ]);
  });
});

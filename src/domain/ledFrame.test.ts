import { describe, expect, it } from 'vitest';
import { createSolidColorFrame, isFlatBlackLedFrame } from './ledFrame';

describe('LED frame helpers', () => {
  it('creates a single section that covers every LED', () => {
    expect(createSolidColorFrame(75, { r: 0, g: 0, b: 0 })).toEqual({
      ledCount: 75,
      sections: [
        {
          start: 1,
          end: 75,
          color: { r: 0, g: 0, b: 0 }
        }
      ]
    });
  });

  it('keeps the frame valid when a caller passes an invalid count', () => {
    expect(createSolidColorFrame(0, { r: 1, g: 2, b: 3 }).ledCount).toBe(1);
    expect(createSolidColorFrame(Number.NaN, { r: 1, g: 2, b: 3 }).ledCount).toBe(1);
  });

  it('detects protected-style flat black LED frames without matching dark scenes', () => {
    expect(isFlatBlackLedFrame(createSolidColorFrame(75, { r: 0, g: 0, b: 0 }))).toBe(true);
    expect(isFlatBlackLedFrame(createSolidColorFrame(75, { r: 2, g: 1, b: 2 }))).toBe(true);
    expect(isFlatBlackLedFrame(createSolidColorFrame(75, { r: 3, g: 0, b: 0 }))).toBe(false);
    expect(isFlatBlackLedFrame({ ledCount: 75, sections: [] })).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { createSolidColorFrame } from './ledFrame';

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
});

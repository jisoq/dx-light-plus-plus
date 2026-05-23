import { describe, expect, it } from 'vitest';
import { AdaptiveOptimizer } from './optimizer';

describe('AdaptiveOptimizer', () => {
  it('starts with conservative frame pacing for ambient light sync', () => {
    const optimizer = new AdaptiveOptimizer();

    expect(optimizer.getState()).toMatchObject({
      targetFps: 30,
      sampleStride: 2
    });
  });

  it('can recover to a shorter sampling interval after stable frames', () => {
    const optimizer = new AdaptiveOptimizer();
    let state = optimizer.getState();

    for (let index = 0; index < 900; index += 1) {
      state = optimizer.update({ frameMs: 8, captureMs: 2, writeMs: 1, droppedFrames: 0 });
    }

    expect(state.targetFps).toBe(60);
  });

  it('reduces work when frame timing exceeds budget', () => {
    const optimizer = new AdaptiveOptimizer({ initialFps: 30, minFps: 12 });
    const next = optimizer.update({ frameMs: 60, captureMs: 30, writeMs: 12, droppedFrames: 1 });

    expect(next.targetFps).toBe(24);
    expect(next.sampleStride).toBe(3);
    expect(next.sendEvery).toBe(2);
    expect(next.reason).toContain('Reduced');
  });

  it('recovers quality after sustained stable frames', () => {
    const optimizer = new AdaptiveOptimizer({ initialFps: 30, maxFps: 36 });
    optimizer.update({ frameMs: 60, captureMs: 30, writeMs: 12, droppedFrames: 1 });

    let state = optimizer.getState();
    for (let index = 0; index < 90; index += 1) {
      state = optimizer.update({ frameMs: 20, captureMs: 3, writeMs: 2, droppedFrames: 0 });
    }

    expect(state.targetFps).toBe(27);
    expect(state.sampleStride).toBe(2);
    expect(state.sendEvery).toBe(1);
  });
});

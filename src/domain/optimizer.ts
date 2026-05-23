import type { OptimizerState, SyncMetrics } from './types';

export interface OptimizerOptions {
  minFps: number;
  maxFps: number;
  initialFps: number;
  maxStride: number;
}

const DEFAULT_OPTIONS: OptimizerOptions = {
  minFps: 10,
  maxFps: 60,
  initialFps: 30,
  maxStride: 8
};

export class AdaptiveOptimizer {
  private state: OptimizerState;
  private stableFrames = 0;
  private readonly options: OptimizerOptions;

  constructor(options: Partial<OptimizerOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.state = {
      targetFps: this.options.initialFps,
      sampleStride: 2,
      sendEvery: 1,
      reason: 'Balanced startup profile'
    };
  }

  getState(): OptimizerState {
    return { ...this.state };
  }

  update(metrics: SyncMetrics): OptimizerState {
    const budgetMs = 1000 / this.state.targetFps;
    const overloaded = metrics.frameMs > budgetMs * 1.15 || metrics.captureMs > budgetMs * 0.45 || metrics.writeMs > 10;

    if (overloaded) {
      this.stableFrames = 0;
      this.state = {
        targetFps: Math.max(this.options.minFps, this.state.targetFps - 6),
        sampleStride: Math.min(this.options.maxStride, this.state.sampleStride + 1),
        sendEvery: Math.min(3, this.state.sendEvery + (metrics.writeMs > 10 ? 1 : 0)),
        reason: 'Reduced load to avoid frame stutter'
      };
      return this.getState();
    }

    this.stableFrames += 1;
    if (this.stableFrames >= 90) {
      this.stableFrames = 0;
      this.state = {
        targetFps: Math.min(this.options.maxFps, this.state.targetFps + 3),
        sampleStride: Math.max(1, this.state.sampleStride - 1),
        sendEvery: Math.max(1, this.state.sendEvery - 1),
        reason: 'Recovered quality after stable frame pacing'
      };
      return this.getState();
    }

    this.state = {
      ...this.state,
      reason: metrics.droppedFrames > 0 ? 'Monitoring dropped frames' : 'Frame pacing is stable'
    };
    return this.getState();
  }

  setTargetFps(targetFps: number): OptimizerState {
    this.state = {
      ...this.state,
      targetFps: Math.min(this.options.maxFps, Math.max(this.options.minFps, Math.round(targetFps))),
      reason: 'Manual target FPS'
    };
    return this.getState();
  }
}

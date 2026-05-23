import { clampDomain } from './sampling';
import type { SamplingDomain, SamplingFrameConfig, SamplingFrameMode } from './types';

const CONTENT_16_9_ASPECT = 16 / 9;
const ULTRAWIDE_PREVIEW_ASPECT = 21 / 9;

export function samplingFrameBounds(sourceWidth: number, sourceHeight: number, config: SamplingFrameConfig): SamplingDomain {
  if (config.mode === 'display') {
    return { x: 0, y: 0, width: sourceWidth, height: sourceHeight };
  }

  return centeredAspectBounds(sourceWidth, sourceHeight, CONTENT_16_9_ASPECT);
}

export function percentDomainToFramePixels(
  domain: SamplingDomain,
  sourceWidth: number,
  sourceHeight: number,
  config: SamplingFrameConfig
): SamplingDomain {
  const frame = samplingFrameBounds(sourceWidth, sourceHeight, config);
  return clampDomain({
    x: frame.x + (domain.x / 100) * frame.width,
    y: frame.y + (domain.y / 100) * frame.height,
    width: (domain.width / 100) * frame.width,
    height: (domain.height / 100) * frame.height
  }, sourceWidth, sourceHeight);
}

export function previewFrameBounds(mode: SamplingFrameMode, previewAspect = ULTRAWIDE_PREVIEW_ASPECT): SamplingDomain {
  if (mode === 'display') {
    return { x: 0, y: 0, width: 100, height: 100 };
  }

  return centeredAspectBounds(100 * previewAspect, 100, CONTENT_16_9_ASPECT, true);
}

export function domainToPreviewDomain(domain: SamplingDomain, mode: SamplingFrameMode): SamplingDomain {
  const frame = previewFrameBounds(mode);
  return {
    x: frame.x + (domain.x / 100) * frame.width,
    y: frame.y + (domain.y / 100) * frame.height,
    width: (domain.width / 100) * frame.width,
    height: (domain.height / 100) * frame.height
  };
}

export function previewPointToFramePoint(point: { x: number; y: number }, mode: SamplingFrameMode): { x: number; y: number } {
  const frame = previewFrameBounds(mode);
  return {
    x: clamp(((point.x - frame.x) / frame.width) * 100, 0, 100),
    y: clamp(((point.y - frame.y) / frame.height) * 100, 0, 100)
  };
}

export function effectiveDisplayAreaPercent(regions: SamplingDomain[], mode: SamplingFrameMode): number {
  const frame = previewFrameBounds(mode);
  const frameArea = (frame.width * frame.height) / 10000;
  const regionArea = regions.reduce((total, region) => total + (region.width * region.height) / 100, 0);
  return regionArea * frameArea;
}

function centeredAspectBounds(width: number, height: number, targetAspect: number, percentOutput = false): SamplingDomain {
  const sourceAspect = width / height;
  let frameWidth = width;
  let frameHeight = height;
  let x = 0;
  let y = 0;

  if (sourceAspect > targetAspect) {
    frameWidth = height * targetAspect;
    x = (width - frameWidth) / 2;
  } else if (sourceAspect < targetAspect) {
    frameHeight = width / targetAspect;
    y = (height - frameHeight) / 2;
  }

  if (!percentOutput) {
    return { x, y, width: frameWidth, height: frameHeight };
  }

  return {
    x: (x / width) * 100,
    y: (y / height) * 100,
    width: (frameWidth / width) * 100,
    height: (frameHeight / height) * 100
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

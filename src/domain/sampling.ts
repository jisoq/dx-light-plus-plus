import type { CaptureFrame, RgbColor, SampleResult, SamplingDomain } from './types';

const MIN_DOMAIN_SIZE = 1;

export function clampDomain(domain: SamplingDomain, frameWidth: number, frameHeight: number): SamplingDomain {
  const x = clamp(Math.round(domain.x), 0, Math.max(0, frameWidth - MIN_DOMAIN_SIZE));
  const y = clamp(Math.round(domain.y), 0, Math.max(0, frameHeight - MIN_DOMAIN_SIZE));
  const maxWidth = Math.max(MIN_DOMAIN_SIZE, frameWidth - x);
  const maxHeight = Math.max(MIN_DOMAIN_SIZE, frameHeight - y);

  return {
    x,
    y,
    width: clamp(Math.round(domain.width), MIN_DOMAIN_SIZE, maxWidth),
    height: clamp(Math.round(domain.height), MIN_DOMAIN_SIZE, maxHeight)
  };
}

export function averageDomainColor(frame: CaptureFrame, domain: SamplingDomain, stride = 1): SampleResult {
  const startedAt = performance.now();
  const safeDomain = clampDomain(domain, frame.width, frame.height);
  const safeStride = Math.max(1, Math.round(stride));
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;

  const maxX = safeDomain.x + safeDomain.width;
  const maxY = safeDomain.y + safeDomain.height;
  for (let y = safeDomain.y; y < maxY; y += safeStride) {
    for (let x = safeDomain.x; x < maxX; x += safeStride) {
      const offset = (y * frame.width + x) * 4;
      r += frame.data[offset] ?? 0;
      g += frame.data[offset + 1] ?? 0;
      b += frame.data[offset + 2] ?? 0;
      count += 1;
    }
  }

  return {
    color: toRgb({ r: r / count, g: g / count, b: b / count }),
    domain: safeDomain,
    domains: [safeDomain],
    sourceWidth: frame.width,
    sourceHeight: frame.height,
    sampledPixels: count,
    captureMs: performance.now() - startedAt
  };
}

export function combineSampleResults(samples: SampleResult[], sourceWidth: number, sourceHeight: number, captureMs: number): SampleResult | null {
  if (samples.length === 0) {
    return null;
  }

  let weightedR = 0;
  let weightedG = 0;
  let weightedB = 0;
  let sampledPixels = 0;
  const domains: SamplingDomain[] = [];

  for (const sample of samples) {
    weightedR += sample.color.r * sample.sampledPixels;
    weightedG += sample.color.g * sample.sampledPixels;
    weightedB += sample.color.b * sample.sampledPixels;
    sampledPixels += sample.sampledPixels;
    domains.push(...sample.domains);
  }

  return {
    color: toRgb({
      r: weightedR / sampledPixels,
      g: weightedG / sampledPixels,
      b: weightedB / sampledPixels
    }),
    domain: boundsForDomains(domains),
    domains,
    sourceWidth,
    sourceHeight,
    sampledPixels,
    captureMs
  };
}

export function percentDomainToPixels(domain: SamplingDomain, width: number, height: number): SamplingDomain {
  return clampDomain({
    x: (domain.x / 100) * width,
    y: (domain.y / 100) * height,
    width: (domain.width / 100) * width,
    height: (domain.height / 100) * height
  }, width, height);
}

function boundsForDomains(domains: SamplingDomain[]): SamplingDomain {
  const minX = Math.min(...domains.map((domain) => domain.x));
  const minY = Math.min(...domains.map((domain) => domain.y));
  const maxX = Math.max(...domains.map((domain) => domain.x + domain.width));
  const maxY = Math.max(...domains.map((domain) => domain.y + domain.height));

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY
  };
}

function toRgb(color: RgbColor): RgbColor {
  return {
    r: clamp(Math.round(color.r), 0, 255),
    g: clamp(Math.round(color.g), 0, 255),
    b: clamp(Math.round(color.b), 0, 255)
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

import { averageDomainColor, combineSampleResults, percentDomainToPixels } from '../domain/sampling';
import { boostRgbColor } from '../domain/brightness';
import { createOrderedSamplingRegions, mergeAdjacentSections, sectionColorAverage, type LedLayoutConfig } from '../domain/ledLayout';
import { percentDomainToFramePixels } from '../domain/samplingFrame';
import { ledCellDomainFor, ledReadbackSizeFor } from './ledReadback';
import type { CaptureFrame, CaptureReadbackOptions, LedFrameSample, LedSection, SampleResult, SamplingDomain, SamplingFrameConfig, SamplingRegion } from '../domain/types';

const DEFAULT_MAX_READBACK_PIXELS = 90_000;
const CAPTURE_FRAME_RATE = { ideal: 60, max: 60 };

export interface CaptureProvider {
  start(): Promise<void>;
  stop(): void;
  sourceSize(): { width: number; height: number } | null;
  readFrame(domain?: SamplingDomain, options?: CaptureReadbackOptions): CaptureFrame | null;
}

export function fitReadbackSize(width: number, height: number, maxPixels = DEFAULT_MAX_READBACK_PIXELS): { width: number; height: number } {
  const safeWidth = Math.max(1, Math.round(width));
  const safeHeight = Math.max(1, Math.round(height));
  const safeMaxPixels = Math.max(1, Math.round(maxPixels));
  const pixelCount = safeWidth * safeHeight;

  if (pixelCount <= safeMaxPixels) {
    return { width: safeWidth, height: safeHeight };
  }

  const scale = Math.sqrt(safeMaxPixels / pixelCount);
  let readbackWidth = Math.max(1, Math.floor(safeWidth * scale));
  let readbackHeight = Math.max(1, Math.floor(safeHeight * scale));

  if (readbackWidth * readbackHeight > safeMaxPixels) {
    if (readbackWidth >= readbackHeight) {
      readbackWidth = Math.max(1, Math.floor(safeMaxPixels / readbackHeight));
    } else {
      readbackHeight = Math.max(1, Math.floor(safeMaxPixels / readbackWidth));
    }
  }

  return {
    width: readbackWidth,
    height: readbackHeight
  };
}

export class ScreenCaptureService {
  constructor(private readonly provider: CaptureProvider) {}

  async start(): Promise<void> {
    await this.provider.start();
  }

  stop(): void {
    this.provider.stop();
  }

  sample(domainPercents: SamplingDomain[], stride: number): SampleResult | null {
    const sourceSize = this.provider.sourceSize();
    if (!sourceSize) {
      return null;
    }

    const startedAt = performance.now();
    const samples: SampleResult[] = [];
    for (const domainPercent of domainPercents) {
      const domain = percentDomainToPixels(domainPercent, sourceSize.width, sourceSize.height);
      const frame = this.provider.readFrame(domain);
      if (!frame) {
        continue;
      }

      const sample = averageDomainColor(frame, { x: 0, y: 0, width: frame.width, height: frame.height }, stride);
      samples.push({
        ...sample,
        domain,
        domains: [domain],
        sourceWidth: sourceSize.width,
        sourceHeight: sourceSize.height
      });
    }

    if (samples.length === 0) {
      return null;
    }

    return combineSampleResults(samples, sourceSize.width, sourceSize.height, performance.now() - startedAt);
  }

  sampleLedFrame(regions: SamplingRegion[], layout: LedLayoutConfig, stride: number, frameConfig: SamplingFrameConfig = { mode: 'display' }): LedFrameSample | null {
    const sourceSize = this.provider.sourceSize();
    if (!sourceSize) {
      return null;
    }

    const orderedRegions = createOrderedSamplingRegions(regions, layout);
    if (orderedRegions.length === 0) {
      return null;
    }

    const startedAt = performance.now();
    const sections: LedSection[] = [];
    const domains: SamplingDomain[] = [];
    let sampledPixels = 0;
    let ledIndex = 1;

    for (const ordered of orderedRegions) {
      if (ordered.ledCount <= 0) {
        continue;
      }

      const domain = percentDomainToFramePixels(ordered.region, sourceSize.width, sourceSize.height, frameConfig);
      const frame = this.provider.readFrame(domain, { targetSize: ledReadbackSizeFor(ordered.direction, ordered.ledCount, stride) });
      if (!frame) {
        ledIndex += ordered.ledCount;
        continue;
      }

      domains.push(domain);
      for (let index = 0; index < ordered.ledCount; index += 1) {
        const sampleDomain = ledCellDomainFor(frame, ordered.direction, index, ordered.ledCount);
        const sample = averageDomainColor(frame, sampleDomain, 1);
        sections.push({
          start: ledIndex,
          end: ledIndex,
          color: boostRgbColor(sample.color)
        });
        sampledPixels += sample.sampledPixels;
        ledIndex += 1;
      }
    }

    if (sections.length === 0) {
      return null;
    }

    const mergedSections = mergeAdjacentSections(sections);
    const captureMs = performance.now() - startedAt;
    return {
      color: sectionColorAverage(sections),
      domain: boundsForDomains(domains),
      domains,
      sourceWidth: sourceSize.width,
      sourceHeight: sourceSize.height,
      sampledPixels,
      captureMs,
      ledFrame: {
        ledCount: layout.ledCount,
        sections: mergedSections
      }
    };
  }
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

export class BrowserScreenCaptureProvider implements CaptureProvider {
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private context: CanvasRenderingContext2D | null = null;

  async start(): Promise<void> {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error('Screen capture is not available in this browser.');
    }
    this.stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: CAPTURE_FRAME_RATE
      },
      audio: false
    });

    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.srcObject = this.stream;
    await this.video.play();

    this.canvas = document.createElement('canvas');
    this.context = this.canvas.getContext('2d', { willReadFrequently: true });
  }

  stop(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video = null;
    this.canvas = null;
    this.context = null;
  }

  sourceSize(): { width: number; height: number } | null {
    if (!this.video || this.video.videoWidth === 0 || this.video.videoHeight === 0) {
      return null;
    }

    return {
      width: this.video.videoWidth,
      height: this.video.videoHeight
    };
  }

  readFrame(domain?: SamplingDomain, options: CaptureReadbackOptions = {}): CaptureFrame | null {
    if (!this.video || !this.canvas || !this.context || this.video.videoWidth === 0 || this.video.videoHeight === 0) {
      return null;
    }

    const safeDomain = domain ?? { x: 0, y: 0, width: this.video.videoWidth, height: this.video.videoHeight };
    const readbackSize = options.targetSize
      ? fitReadbackSize(options.targetSize.width, options.targetSize.height)
      : fitReadbackSize(safeDomain.width, safeDomain.height);
    if (this.canvas.width !== readbackSize.width) {
      this.canvas.width = readbackSize.width;
    }
    if (this.canvas.height !== readbackSize.height) {
      this.canvas.height = readbackSize.height;
    }

    this.context.drawImage(
      this.video,
      safeDomain.x,
      safeDomain.y,
      safeDomain.width,
      safeDomain.height,
      0,
      0,
      readbackSize.width,
      readbackSize.height
    );
    const image = this.context.getImageData(0, 0, this.canvas.width, this.canvas.height);

    return {
      width: image.width,
      height: image.height,
      data: image.data,
      timestamp: performance.now()
    };
  }
}

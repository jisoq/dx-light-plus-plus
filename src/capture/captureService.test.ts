import { describe, expect, it } from 'vitest';
import { fitReadbackSize, ScreenCaptureService, type CaptureProvider } from './captureService';
import { ledReadbackSizeFor } from './ledReadback';
import { percentDomainToFramePixels } from '../domain/samplingFrame';
import type { CaptureFrame, CaptureReadbackOptions, CaptureReadbackSize, SamplingDomain, SamplingRegion } from '../domain/types';

class FakeProvider implements CaptureProvider {
  domains: SamplingDomain[] = [];
  targetSizes: CaptureReadbackSize[] = [];
  readbackPixels = 0;

  async start(): Promise<void> {}

  stop(): void {}

  sourceSize() {
    return { width: 200, height: 100 };
  }

  readFrame(domain?: SamplingDomain, options?: CaptureReadbackOptions): CaptureFrame {
    if (domain) {
      this.domains.push(domain);
    }
    if (options?.targetSize) {
      this.targetSizes.push(options.targetSize);
    }
    const width = options?.targetSize?.width ?? domain?.width ?? 200;
    const height = options?.targetSize?.height ?? domain?.height ?? 100;
    this.readbackPixels += width * height;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < data.length; index += 4) {
      data[index] = 10;
      data[index + 1] = 20;
      data[index + 2] = 30;
      data[index + 3] = 255;
    }

    return {
      width,
      height,
      data,
      timestamp: 0
    };
  }
}

class VerticalGradientProvider extends FakeProvider {
  override sourceSize() {
    return { width: 100, height: 100 };
  }

  override readFrame(domain?: SamplingDomain, options?: CaptureReadbackOptions): CaptureFrame {
    if (domain) {
      this.domains.push(domain);
    }
    if (options?.targetSize) {
      this.targetSizes.push(options.targetSize);
    }
    const width = options?.targetSize?.width ?? domain?.width ?? 100;
    const height = options?.targetSize?.height ?? domain?.height ?? 100;
    this.readbackPixels += width * height;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4;
        data[offset] = y * 50;
        data[offset + 1] = 0;
        data[offset + 2] = 0;
        data[offset + 3] = 255;
      }
    }

    return {
      width,
      height,
      data,
      timestamp: 0
    };
  }
}

describe('ScreenCaptureService', () => {
  it('downscales large readback domains into a bounded pixel budget', () => {
    const size = fitReadbackSize(3840, 160, 90_000);

    expect(size.width * size.height).toBeLessThanOrEqual(90_000);
    expect(size.width).toBeLessThan(3840);
    expect(size.height).toBeLessThan(160);
    expect(Math.abs((size.width / size.height) - (3840 / 160))).toBeLessThan(0.15);
  });

  it('keeps small readback domains at native size', () => {
    expect(fitReadbackSize(320, 80, 90_000)).toEqual({ width: 320, height: 80 });
  });

  it('keeps very thin readback domains inside the pixel budget', () => {
    const size = fitReadbackSize(1_000_000, 1, 90_000);

    expect(size.width * size.height).toBeLessThanOrEqual(90_000);
    expect(size.height).toBe(1);
  });

  it('creates LED-sized readback buffers from layout direction and stride', () => {
    expect(ledReadbackSizeFor('horizontal-forward', 25, 1)).toEqual({ width: 25, height: 6 });
    expect(ledReadbackSizeFor('horizontal-forward', 25, 3)).toEqual({ width: 25, height: 2 });
    expect(ledReadbackSizeFor('vertical-reverse', 25, 3)).toEqual({ width: 2, height: 25 });
  });


  it('pushes the selected percentage domain into the provider readback', () => {
    const provider = new FakeProvider();
    const service = new ScreenCaptureService(provider);
    const sample = service.sample([{ x: 25, y: 10, width: 50, height: 80 }], 1);

    expect(provider.domains).toEqual([{ x: 50, y: 10, width: 100, height: 80 }]);
    expect(sample?.domain).toEqual(provider.domains[0]);
    expect(sample?.domains).toEqual(provider.domains);
    expect(sample?.sourceWidth).toBe(200);
    expect(sample?.sourceHeight).toBe(100);
  });

  it('samples every selected border domain independently', () => {
    const provider = new FakeProvider();
    const service = new ScreenCaptureService(provider);
    const sample = service.sample([
      { x: 0, y: 0, width: 100, height: 10 },
      { x: 0, y: 90, width: 100, height: 10 }
    ], 2);

    expect(provider.domains).toEqual([
      { x: 0, y: 0, width: 200, height: 10 },
      { x: 0, y: 90, width: 200, height: 10 }
    ]);
    expect(sample?.domains).toEqual(provider.domains);
    expect(sample?.domain).toEqual({ x: 0, y: 0, width: 200, height: 100 });
    expect(sample?.sampledPixels).toBeGreaterThan(0);
  });

  it('builds a physical LED frame in installation order', () => {
    const provider = new VerticalGradientProvider();
    const service = new ScreenCaptureService(provider);
    const sample = service.sampleLedFrame([
      { id: 'left-edge', label: 'Left edge', x: 0, y: 0, width: 10, height: 100 }
    ], { direction: 'left-to-right', ledCount: 4 }, 1);

    expect(provider.domains).toEqual([{ x: 0, y: 0, width: 10, height: 100 }]);
    expect(provider.targetSizes).toEqual([{ width: 6, height: 4 }]);
    expect(sample?.ledFrame.sections.map((section) => section.start)).toEqual([1, 2, 3, 4]);
    expect(sample?.ledFrame.sections[0]?.color.r).toBeGreaterThan(sample?.ledFrame.sections[3]?.color.r ?? 0);
    expect(sample?.ledFrame.ledCount).toBe(4);
  });

  it('samples LED frames against a centered 16:9 content frame', () => {
    const provider = new VerticalGradientProvider();
    provider.sourceSize = () => ({ width: 2100, height: 900 });
    const service = new ScreenCaptureService(provider);
    const sample = service.sampleLedFrame([
      { id: 'left-edge', label: 'Left edge', x: 0, y: 8, width: 8, height: 84 }
    ], { direction: 'left-to-right', ledCount: 4 }, 1, { mode: 'center-16-9' });

    expect(provider.domains).toEqual([{ x: 250, y: 72, width: 128, height: 756 }]);
    expect(provider.targetSizes).toEqual([{ width: 6, height: 4 }]);
    expect(sample?.ledFrame.ledCount).toBe(4);
    expect(sample?.ledFrame.sections[0]?.start).toBe(1);
  });

  it('limits LED frame readback work to LED count instead of high-resolution strip pixels', () => {
    const regions: SamplingRegion[] = [
      { id: 'top-edge', label: 'Top edge', x: 0, y: 0, width: 100, height: 8 },
      { id: 'left-edge', label: 'Left edge', x: 0, y: 8, width: 8, height: 84 },
      { id: 'right-edge', label: 'Right edge', x: 92, y: 8, width: 8, height: 84 }
    ];
    const provider = new FakeProvider();
    provider.sourceSize = () => ({ width: 3840, height: 2160 });
    const service = new ScreenCaptureService(provider);
    const sample = service.sampleLedFrame(regions, { direction: 'left-to-right', ledCount: 75 }, 2);

    const legacyReadbackPixels = provider.domains.reduce((total, domain) => {
      const legacySize = fitReadbackSize(domain.width, domain.height);
      return total + legacySize.width * legacySize.height;
    }, 0);
    const expectedDomains = [regions[1], regions[0], regions[2]]
      .map((region) => percentDomainToFramePixels(region, 3840, 2160, { mode: 'display' }));

    expect(provider.domains).toEqual(expectedDomains);
    expect(provider.targetSizes).toEqual([
      { width: 3, height: 25 },
      { width: 25, height: 3 },
      { width: 3, height: 25 }
    ]);
    expect(provider.readbackPixels).toBe(225);
    expect(legacyReadbackPixels).toBe(268_353);
    expect(provider.readbackPixels).toBeLessThan(legacyReadbackPixels / 1_000);
    expect(sample?.sampledPixels).toBe(225);
  });
});

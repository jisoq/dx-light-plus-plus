import type { CaptureFrame, CaptureReadbackSize, SamplingDomain } from '../domain/types';
import type { RegionDirection } from '../domain/ledLayout';

const DEFAULT_LED_READBACK_DEPTH = 6;

export function ledReadbackSizeFor(
  direction: RegionDirection,
  ledCount: number,
  stride: number,
  maxDepth = DEFAULT_LED_READBACK_DEPTH
): CaptureReadbackSize {
  const safeLedCount = Math.max(1, Math.round(ledCount));
  const safeStride = Math.max(1, Math.round(stride));
  const depth = Math.max(1, Math.ceil(Math.max(1, Math.round(maxDepth)) / safeStride));

  if (direction.startsWith('horizontal')) {
    return { width: safeLedCount, height: depth };
  }

  return { width: depth, height: safeLedCount };
}

export function ledCellDomainFor(frame: CaptureFrame, direction: RegionDirection, index: number, count: number): SamplingDomain {
  const safeCount = Math.max(1, Math.round(count));
  const safeIndex = Math.min(safeCount - 1, Math.max(0, Math.round(index)));
  const reverse = direction.endsWith('reverse');
  const horizontal = direction.startsWith('horizontal');
  const segmentIndex = reverse ? safeCount - 1 - safeIndex : safeIndex;

  if (horizontal) {
    const x = Math.floor((segmentIndex / safeCount) * frame.width);
    const nextX = Math.floor(((segmentIndex + 1) / safeCount) * frame.width);
    return { x, y: 0, width: Math.max(1, nextX - x), height: frame.height };
  }

  const y = Math.floor((segmentIndex / safeCount) * frame.height);
  const nextY = Math.floor(((segmentIndex + 1) / safeCount) * frame.height);
  return { x: 0, y, width: frame.width, height: Math.max(1, nextY - y) };
}

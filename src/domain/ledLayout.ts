import type { InstallationDirection, LedSection, RgbColor, SamplingRegion } from './types';

export type RegionDirection = 'horizontal-forward' | 'horizontal-reverse' | 'vertical-forward' | 'vertical-reverse';
type RegionEdge = 'left' | 'top' | 'right' | 'bottom' | 'custom';

export interface OrderedSamplingRegion {
  region: SamplingRegion;
  direction: RegionDirection;
  ledCount: number;
}

export interface LedLayoutConfig {
  direction: InstallationDirection;
  ledCount: number;
}

interface RegionPlan {
  region: SamplingRegion;
  edge: RegionEdge;
  direction: RegionDirection;
}

export function createOrderedSamplingRegions(regions: SamplingRegion[], config: LedLayoutConfig): OrderedSamplingRegion[] {
  if (regions.length === 0 || config.ledCount <= 0) {
    return [];
  }

  const plans = createRegionPlans(regions, config.direction);
  const counts = allocateCounts(config.ledCount, plans.length);
  return plans.map((plan, index) => ({
    ...plan,
    ledCount: counts[index] ?? 0
  }));
}

export function sectionColorAverage(sections: LedSection[]): RgbColor {
  if (sections.length === 0) {
    return { r: 0, g: 0, b: 0 };
  }

  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (const section of sections) {
    const sectionCount = Math.max(1, section.end - section.start + 1);
    r += section.color.r * sectionCount;
    g += section.color.g * sectionCount;
    b += section.color.b * sectionCount;
    count += sectionCount;
  }

  return {
    r: Math.round(r / count),
    g: Math.round(g / count),
    b: Math.round(b / count)
  };
}

export function mergeAdjacentSections(sections: LedSection[], tolerance = 3): LedSection[] {
  const merged: LedSection[] = [];
  for (const section of sections) {
    const previous = merged[merged.length - 1];
    if (previous && previous.end + 1 === section.start && colorDistance(previous.color, section.color) <= tolerance) {
      previous.end = section.end;
      previous.color = averageColors(previous.color, section.color);
    } else {
      merged.push({ ...section, color: { ...section.color } });
    }
  }
  return merged;
}

function createRegionPlans(regions: SamplingRegion[], direction: InstallationDirection): RegionPlan[] {
  const plans = regions.map((region) => ({ region, edge: classifyRegion(region) }));
  const orderedEdges: RegionEdge[] = direction === 'left-to-right' ? ['left', 'top', 'right', 'bottom'] : ['right', 'top', 'left', 'bottom'];
  const result: RegionPlan[] = [];

  for (const edge of orderedEdges) {
    for (const plan of plans.filter((item) => item.edge === edge)) {
      result.push({
        ...plan,
        direction: directionForEdge(plan.edge, direction)
      });
    }
  }

  for (const plan of plans.filter((item) => item.edge === 'custom')) {
    result.push({
      ...plan,
      direction: plan.region.width >= plan.region.height ? 'horizontal-forward' : 'vertical-forward'
    });
  }

  return result;
}

function classifyRegion(region: SamplingRegion): RegionEdge {
  const horizontal = region.width >= region.height;
  if (horizontal && region.y <= 20) {
    return 'top';
  }
  if (horizontal && region.y + region.height >= 80) {
    return 'bottom';
  }
  if (!horizontal && region.x <= 20) {
    return 'left';
  }
  if (!horizontal && region.x + region.width >= 80) {
    return 'right';
  }
  return 'custom';
}

function directionForEdge(edge: RegionEdge, direction: InstallationDirection): RegionDirection {
  if (direction === 'left-to-right') {
    if (edge === 'left') {
      return 'vertical-reverse';
    }
    if (edge === 'right') {
      return 'vertical-forward';
    }
    if (edge === 'bottom') {
      return 'horizontal-reverse';
    }
    return 'horizontal-forward';
  }

  if (edge === 'right') {
    return 'vertical-reverse';
  }
  if (edge === 'left') {
    return 'vertical-forward';
  }
  if (edge === 'bottom') {
    return 'horizontal-reverse';
  }
  return 'horizontal-reverse';
}

function allocateCounts(total: number, regionCount: number): number[] {
  const safeTotal = Math.max(0, Math.round(total));
  const safeRegionCount = Math.max(1, regionCount);
  const base = Math.floor(safeTotal / safeRegionCount);
  let remainder = safeTotal % safeRegionCount;

  return Array.from({ length: safeRegionCount }, () => {
    const count = base + (remainder > 0 ? 1 : 0);
    remainder -= 1;
    return count;
  });
}

function colorDistance(left: RgbColor, right: RgbColor): number {
  return Math.max(Math.abs(left.r - right.r), Math.abs(left.g - right.g), Math.abs(left.b - right.b));
}

function averageColors(left: RgbColor, right: RgbColor): RgbColor {
  return {
    r: Math.round((left.r + right.r) / 2),
    g: Math.round((left.g + right.g) / 2),
    b: Math.round((left.b + right.b) / 2)
  };
}

import type { CropKeyframe, RegionOfInterest, ReframePlan } from '@/lib/types';
import { clamp, round } from '@/lib/time';

/**
 * Auto-reframe: turn a landscape source into vertical (or square) while keeping
 * the subject in frame.
 *
 * The hard part is not finding the subject — it is moving the camera. A crop
 * window that snaps to every detection jitters horribly. This implementation
 * uses a critically-damped follow with a dead zone, which is how a competent
 * camera operator actually behaves: ignore small movements, ease onto large
 * ones, never overshoot.
 */

export interface ReframeOptions {
  /** Target aspect ratio as width/height. 9/16 ≈ 0.5625. */
  targetAspect: number;
  /**
   * Subject movement smaller than this fraction of frame width is ignored.
   * Without it, natural head sway makes the frame breathe.
   */
  deadZone: number;
  /**
   * Follow strength per second in `(0, 1]`. Lower is smoother and laggier.
   * 0.55 tracks a walking subject without visible catch-up.
   */
  smoothing: number;
  /** Maximum pan speed as a fraction of frame width per second. */
  maxPanPerSec: number;
  /** Frames per second at which keyframes are emitted. */
  keyframeFps: number;
  /** Priority order when several subjects are visible. */
  preferLargest: boolean;
  /**
   * When a scene cut is detected (subject jumps far in one step) the camera
   * teleports instead of panning. Threshold is a fraction of frame width.
   */
  cutThreshold: number;
}

export const DEFAULT_REFRAME_OPTIONS: ReframeOptions = {
  targetAspect: 9 / 16,
  deadZone: 0.04,
  smoothing: 0.55,
  maxPanPerSec: 0.35,
  keyframeFps: 10,
  preferLargest: true,
  cutThreshold: 0.35,
};

/** The crop window size for a target aspect, in source pixels. */
export function cropSize(
  sourceWidth: number,
  sourceHeight: number,
  targetAspect: number,
): { width: number; height: number } {
  const sourceAspect = sourceWidth / sourceHeight;

  if (targetAspect < sourceAspect) {
    // Output is narrower than source: full height, cropped width.
    const width = Math.round(sourceHeight * targetAspect);
    return { width: Math.min(width, sourceWidth), height: sourceHeight };
  }

  // Output is wider (or equal): full width, cropped height.
  const height = Math.round(sourceWidth / targetAspect);
  return { width: sourceWidth, height: Math.min(height, sourceHeight) };
}

/**
 * Pick the subject to follow at one instant.
 *
 * Faces beat bodies beat generic saliency, because a viewer's eye goes to a
 * face first. Within a kind, confidence and size break the tie.
 */
export function selectSubject(
  regions: RegionOfInterest[],
  preferLargest: boolean,
): RegionOfInterest | null {
  if (regions.length === 0) return null;

  const priority: Record<RegionOfInterest['kind'], number> = {
    face: 4,
    person: 3,
    object: 2,
    motion: 1,
    saliency: 0,
  };

  return [...regions].sort((a, b) => {
    const byKind = priority[b.kind] - priority[a.kind];
    if (byKind !== 0) return byKind;

    const areaA = a.width * a.height;
    const areaB = b.width * b.height;
    if (preferLargest && Math.abs(areaA - areaB) > 0.005) return areaB - areaA;

    return b.confidence - a.confidence;
  })[0]!;
}

/**
 * When several faces are on screen, framing the *group* beats picking one —
 * cutting a second speaker out of an interview is the classic auto-reframe
 * failure. Returns the centre of the bounding box covering all high-confidence
 * subjects of the winning kind, provided they fit inside the crop window.
 */
export function groupCenter(
  regions: RegionOfInterest[],
  cropWidthNorm: number,
): { x: number; y: number } | null {
  const faces = regions.filter((r) => r.kind === 'face' && r.confidence >= 0.5);
  if (faces.length < 2) return null;

  const left = Math.min(...faces.map((f) => f.x));
  const right = Math.max(...faces.map((f) => f.x + f.width));
  const top = Math.min(...faces.map((f) => f.y));
  const bottom = Math.max(...faces.map((f) => f.y + f.height));

  // Only frame as a group if everyone actually fits.
  if (right - left > cropWidthNorm * 0.92) return null;

  return { x: (left + right) / 2, y: (top + bottom) / 2 };
}

/**
 * Build the animated crop.
 *
 * ROIs may be sparse and unsorted; times without a detection hold the last
 * known position rather than recentring, which avoids a distracting drift back
 * to centre every time the detector drops a frame.
 */
export function planReframe(
  regions: RegionOfInterest[],
  source: { width: number; height: number; durationSec: number },
  options: Partial<ReframeOptions> = {},
): ReframePlan {
  const opts = { ...DEFAULT_REFRAME_OPTIONS, ...options };
  const crop = cropSize(source.width, source.height, opts.targetAspect);

  const cropWidthNorm = crop.width / source.width;
  const cropHeightNorm = crop.height / source.height;

  // Centre crop is both the fallback and the starting position.
  const centerX = 0.5;
  const centerY = 0.5;

  if (regions.length === 0) {
    return {
      targetAspect: opts.targetAspect,
      sourceWidth: source.width,
      sourceHeight: source.height,
      isStaticFallback: true,
      keyframes: [
        {
          time: 0,
          x: Math.round((source.width - crop.width) / 2),
          y: Math.round((source.height - crop.height) / 2),
          width: crop.width,
          height: crop.height,
        },
      ],
    };
  }

  const sorted = [...regions].sort((a, b) => a.time - b.time);
  const step = 1 / opts.keyframeFps;
  const keyframes: CropKeyframe[] = [];

  let currentX = centerX;
  let currentY = centerY;
  let targetX = centerX;
  let targetY = centerY;
  let initialized = false;

  for (let time = 0; time <= source.durationSec + 1e-6; time += step) {
    const nearby = regionsNear(sorted, time, step);

    if (nearby.length > 0) {
      const group = groupCenter(nearby, cropWidthNorm);
      if (group) {
        targetX = group.x;
        targetY = group.y;
      } else {
        const subject = selectSubject(nearby, opts.preferLargest);
        if (subject) {
          targetX = subject.x + subject.width / 2;
          // Bias upward: headroom looks natural, a centred face looks low.
          targetY = subject.y + subject.height * 0.42;
        }
      }

      if (!initialized) {
        currentX = targetX;
        currentY = targetY;
        initialized = true;
      }
    }

    const deltaX = targetX - currentX;
    const deltaY = targetY - currentY;

    if (Math.abs(deltaX) > opts.cutThreshold) {
      // Hard scene change — teleport rather than whipping across the frame.
      currentX = targetX;
    } else if (Math.abs(deltaX) > opts.deadZone) {
      const move = deltaX * opts.smoothing * step * opts.keyframeFps * 0.25;
      const maxMove = opts.maxPanPerSec * step;
      currentX += clamp(move, -maxMove, maxMove);
    }

    if (Math.abs(deltaY) > opts.cutThreshold) {
      currentY = targetY;
    } else if (Math.abs(deltaY) > opts.deadZone) {
      const move = deltaY * opts.smoothing * step * opts.keyframeFps * 0.25;
      const maxMove = opts.maxPanPerSec * step;
      currentY += clamp(move, -maxMove, maxMove);
    }

    // Keep the crop window fully inside the frame.
    const clampedX = clamp(currentX, cropWidthNorm / 2, 1 - cropWidthNorm / 2);
    const clampedY = clamp(currentY, cropHeightNorm / 2, 1 - cropHeightNorm / 2);

    keyframes.push({
      time: round(time, 3),
      x: Math.round(clamp((clampedX - cropWidthNorm / 2) * source.width, 0, source.width - crop.width)),
      y: Math.round(
        clamp((clampedY - cropHeightNorm / 2) * source.height, 0, source.height - crop.height),
      ),
      width: crop.width,
      height: crop.height,
    });
  }

  return {
    targetAspect: opts.targetAspect,
    sourceWidth: source.width,
    sourceHeight: source.height,
    keyframes: dropRedundantKeyframes(keyframes),
    isStaticFallback: false,
  };
}

function regionsNear(
  sorted: RegionOfInterest[],
  time: number,
  tolerance: number,
): RegionOfInterest[] {
  const window = Math.max(tolerance, 0.08);
  return sorted.filter((region) => Math.abs(region.time - time) <= window);
}

/**
 * Collapse runs of identical positions into a single keyframe. A static shot
 * should produce one keyframe, not 600 — this keeps the ffmpeg expression
 * short enough to stay fast to parse.
 */
export function dropRedundantKeyframes(keyframes: CropKeyframe[]): CropKeyframe[] {
  if (keyframes.length <= 2) return keyframes;
  const result: CropKeyframe[] = [keyframes[0]!];

  for (let i = 1; i < keyframes.length - 1; i++) {
    const previous = result[result.length - 1]!;
    const current = keyframes[i]!;
    const next = keyframes[i + 1]!;

    const isFlat = current.x === previous.x && current.y === previous.y;
    const staysFlat = next.x === current.x && next.y === current.y;
    if (isFlat && staysFlat) continue;

    result.push(current);
  }

  const last = keyframes[keyframes.length - 1]!;
  const tail = result[result.length - 1]!;
  if (tail.time !== last.time) result.push(last);

  return result;
}

/**
 * Sample the plan at an arbitrary time with linear interpolation, so previews
 * and the renderer agree on where the crop window is at any instant.
 */
export function sampleCrop(plan: ReframePlan, time: number): CropKeyframe {
  const frames = plan.keyframes;
  const first = frames[0]!;
  if (frames.length === 1 || time <= first.time) return first;

  const last = frames[frames.length - 1]!;
  if (time >= last.time) return last;

  for (let i = 1; i < frames.length; i++) {
    const previous = frames[i - 1]!;
    const current = frames[i]!;
    if (time <= current.time) {
      const span = current.time - previous.time;
      const t = span > 0 ? (time - previous.time) / span : 0;
      return {
        time: round(time, 3),
        x: Math.round(previous.x + (current.x - previous.x) * t),
        y: Math.round(previous.y + (current.y - previous.y) * t),
        width: current.width,
        height: current.height,
      };
    }
  }

  return last;
}

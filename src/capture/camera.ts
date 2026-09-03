import type { Gray } from '../ocr/preprocess';
import { toGray } from '../ocr/preprocess';

/**
 * Browser camera glue, ported from MHLHUB's lib/scan/decoder.ts — the parts
 * that are about a phone camera rather than about barcodes.
 *
 * What carried over, and why each is here:
 *
 *  - `ideal` constraints everywhere. An `exact` constraint a device cannot
 *    meet fails getUserMedia outright, which is how a camera button goes dead
 *    on one phone model and nobody can say why.
 *  - We ask for 1920x1080 and continuous autofocus. A great phone camera does
 *    not mean a great frame: OCR sees the resolution the TRACK negotiated, not
 *    the sensor, so `trackResolution()` is displayed live. Read the number
 *    before theorising about a receipt that will not read.
 *  - Decode what the user sees. The <video> is object-fit: cover, so the element
 *    shows a centred crop of the stream; the guide frame is drawn on the
 *    element, and the pixels handed to OCR are the guide's rectangle mapped
 *    back into stream coordinates. This is also the "crop to the paper" stage
 *    the real-photograph measurements asked for — a receipt is ~30% of an
 *    unframed photo, and everything else in the frame gets OCR'd too.
 *  - A cadence, not a sleep. The next attempt is scheduled from the budget
 *    minus the time this one took, floored so a slow phone backs off instead
 *    of pinning its main thread. For OCR the budget is nearly irrelevant: a
 *    frame costs 300 ms to 2 s, which spaces frames out for free — and that
 *    spacing is load-bearing for the confirmation streak (adjacent frames that
 *    are too alike are not independent observations). Do not "optimise" it.
 *  - The torch. Dim receipts went 0% -> 80% on software sharpening alone;
 *    light at source is the larger lever and this is one tap.
 *  - Stop is idempotent and stops every track. A leaked track keeps the
 *    camera light on until the tab closes.
 */

export const VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  facingMode: { ideal: 'environment' },
  width: { ideal: 1920 },
  height: { ideal: 1080 },
  focusMode: { ideal: 'continuous' },
} as MediaTrackConstraints;

export function hasCamera(): boolean {
  if (typeof navigator === 'undefined') return false;
  return typeof navigator.mediaDevices?.getUserMedia === 'function';
}

/** Open the rear camera onto `video`. Throws when blocked or absent. */
export async function openCamera(video: HTMLVideoElement): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getUserMedia({ video: VIDEO_CONSTRAINTS });
  try {
    video.srcObject = stream;
    await video.play().catch(() => {
      /* autoplay-blocked; the poster stays and the loop sees readyState < 2 */
    });
  } catch (err) {
    stopStream(stream);
    throw err;
  }
  return stream;
}

export function stopStream(stream: MediaStream | null): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      /* already ended */
    }
  }
}

export function hasTorch(stream: MediaStream | null): boolean {
  const track = stream?.getVideoTracks?.()[0];
  const caps = (track?.getCapabilities?.() ?? {}) as { torch?: boolean };
  return Boolean(caps.torch);
}

export async function setTorch(stream: MediaStream | null, on: boolean): Promise<boolean> {
  const track = stream?.getVideoTracks?.()[0];
  if (!track) return false;
  if (!hasTorch(stream)) return false;
  try {
    // A real constraint on Android Chrome and iOS Safari 17.4+, absent from the TS DOM lib.
    await track.applyConstraints({ advanced: [{ torch: on }] } as unknown as MediaTrackConstraints);
    return true;
  } catch {
    return false;
  }
}

/** What the camera ACTUALLY gave us, e.g. "1080×1920". */
export function trackResolution(stream: MediaStream | null): string | null {
  const s = stream?.getVideoTracks?.()[0]?.getSettings?.();
  if (!s?.width || !s?.height) return null;
  return `${s.width}×${s.height}`;
}

/** A rectangle as fractions of the video ELEMENT — what the overlay draws. */
export interface Guide {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SourceRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/**
 * Map the guide (drawn on the element) into stream pixels, through the
 * object-fit: cover geometry. With no layout yet, the whole frame.
 */
export function guideSourceRect(video: HTMLVideoElement, guide: Guide): SourceRect {
  const fw = video.videoWidth;
  const fh = video.videoHeight;
  const ew = video.clientWidth;
  const eh = video.clientHeight;
  let sx = 0;
  let sy = 0;
  let sw = fw;
  let sh = fh;
  if (ew > 0 && eh > 0 && fw > 0 && fh > 0) {
    const elAspect = ew / eh;
    const frAspect = fw / fh;
    if (frAspect > elAspect) {
      sw = Math.max(1, Math.round(fh * elAspect));
      sx = Math.floor((fw - sw) / 2);
    } else if (frAspect < elAspect) {
      sh = Math.max(1, Math.round(fw / elAspect));
      sy = Math.floor((fh - sh) / 2);
    }
  }
  return {
    sx: sx + Math.round(sw * guide.x),
    sy: sy + Math.round(sh * guide.y),
    sw: Math.max(1, Math.round(sw * guide.w)),
    sh: Math.max(1, Math.round(sh * guide.h)),
  };
}

export interface FrameLoopOptions {
  video: HTMLVideoElement;
  guide: Guide;
  /**
   * Called with the guide's pixels. Return true to stop the loop (accepted).
   * Awaited, so frames are strictly serial — one OCR in flight at a time.
   */
  onFrame: (gray: Gray) => Promise<boolean>;
  /** Target gap between attempt STARTS. OCR usually exceeds it on its own. */
  attemptMs?: number;
}

export interface FrameLoopControls {
  stop: () => void;
}

const MIN_YIELD_MS = 16;
const MAX_DUTY_RATIO = 0.5;

export function startFrameLoop({ video, guide, onFrame, attemptMs = 300 }: FrameLoopOptions): FrameLoopControls {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  // One canvas for the life of the loop. Allocating per frame at 1080p is how
  // a phone tab gets killed by the OS after a minute of scanning.
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const stop = () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const tick = async () => {
    if (stopped) return;
    // Monotonic: a wall-clock jump must not park the loop.
    const startedAt = performance.now();
    let accepted = false;
    // A suspended camera (tab hidden, OS lock) shows up as readyState < 2, and
    // arrives downstream as a blank frame — which breaks the streak. A gap is a gap.
    if (ctx && video.readyState >= 2 && video.videoWidth > 0) {
      const { sx, sy, sw, sh } = guideSourceRect(video, guide);
      canvas.width = sw;
      canvas.height = sh;
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
      let gray: Gray | null = null;
      try {
        gray = toGray(ctx.getImageData(0, 0, sw, sh).data, sw, sh);
      } catch {
        /* a frame that could not be read is a blank frame */
      }
      if (gray) {
        try {
          accepted = await onFrame(gray);
        } catch (err) {
          console.error('[capture] frame failed', err);
        }
      }
    }
    if (stopped) return;
    if (accepted) {
      stop();
      return;
    }
    const elapsed = performance.now() - startedAt;
    const idle = Math.max(MIN_YIELD_MS, attemptMs - elapsed, elapsed * MAX_DUTY_RATIO);
    timer = setTimeout(tick, idle);
  };
  timer = setTimeout(tick, attemptMs);

  return { stop };
}

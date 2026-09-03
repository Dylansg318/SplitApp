import { useEffect, useRef, useState } from 'preact/hooks';
import type { OcrEngine } from '../ocr/engine';
import { grayToCanvas, sourceToGray } from '../ocr/canvas';
import { preprocess } from '../ocr/preprocess';
import { CaptureSession, type Looking, type Settled } from '../capture/session';
import {
  hasCamera,
  hasTorch,
  openCamera,
  setTorch,
  startFrameLoop,
  stopStream,
  trackResolution,
  type FrameLoopControls,
  type Guide,
} from '../capture/camera';

/**
 * THE CAMERA STAGE — slice 3b.
 *
 * Shape borrowed from MHLHUB's <CameraScanner>: a live preview with a frame
 * loop behind it, a torch button that only appears when the device has one,
 * the negotiated resolution on screen so a failure is a measurement, an
 * "unsteady" hint that outranks stale status, a still-photo path as the
 * escalation (and the only path when getUserMedia is blocked), and an
 * idempotent stop so the camera light never stays on.
 *
 * What is different: the loop hands each frame to OCR, and the accept decision
 * belongs to `CaptureSession`, which is pure and tested. This component owns
 * the camera and the pixels, nothing about money.
 */

/** Portrait guide, as fractions of the preview. A receipt is tall. */
const GUIDE: Guide = { x: 0.08, y: 0.05, w: 0.84, h: 0.9 };

/** Long-edge cap for a camera-app photo — see sourceToGray. */
const STILL_MAX_EDGE = 3000;

const CAMERA_BLOCKED = 'Camera blocked. Take a photo with your camera app instead, or type the receipt in.';
const NO_CAMERA = 'No camera here. Choose a photo of the receipt, or type it in.';

const FIELDS = ['subtotal', 'tax', 'tip', 'total'] as const;

export interface CaptureProps {
  engine: OcrEngine;
  onSettled: (state: Settled, source: 'live' | 'photo') => void;
  onManual: () => void;
}

/**
 * The page opens with the camera CLOSED. Nothing asks for a permission until
 * the user taps for it — a portfolio visitor who only wanted to read should
 * never see a camera prompt, and on a phone the prompt is the moment the app
 * either earns trust or loses it.
 */
type Phase = 'idle' | 'starting' | 'live' | 'blocked' | 'nocamera';

export function Capture({ engine, onSettled, onManual }: CaptureProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const loopRef = useRef<FrameLoopControls | null>(null);
  const sessionRef = useRef(new CaptureSession());
  const deadRef = useRef(false);
  const busyRef = useRef(false);
  const engineReadyRef = useRef(false);
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;

  const [phase, setPhase] = useState<Phase>('idle');
  const [engineState, setEngineState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [looking, setLooking] = useState<Looking | null>(null);
  const [torchOn, setTorchOn] = useState(false);
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [resolution, setResolution] = useState<string | null>(null);
  const [photo, setPhoto] = useState<{ state: 'idle' | 'reading' | 'failed'; problems: string[] }>({
    state: 'idle',
    problems: [],
  });

  const stopCamera = () => {
    loopRef.current?.stop();
    loopRef.current = null;
    stopStream(streamRef.current);
    streamRef.current = null;
    const v = videoRef.current;
    if (v) {
      try {
        v.srcObject = null;
      } catch {
        /* nothing to release */
      }
    }
  };

  useEffect(() => {
    deadRef.current = false;
    sessionRef.current.reset();

    // Preload the reader so the camera is useful the moment it opens. This is
    // a fetch from our own origin, not a permission — see tesseractPaths().
    engine
      .init()
      .then(() => {
        engineReadyRef.current = true;
        if (!deadRef.current) setEngineState('ready');
      })
      .catch((err) => {
        console.error('[capture] engine failed to load', err);
        if (!deadRef.current) setEngineState('failed');
      });

    return () => {
      deadRef.current = true;
      stopCamera();
    };
    // The engine is created once per page; the callbacks are held in refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine]);

  /** The user asked for the camera. Only now does the permission prompt appear. */
  const openLive = async () => {
    if (!hasCamera()) {
      setPhase('nocamera');
      return;
    }
    setPhase('starting');
    sessionRef.current.reset();
    setLooking(null);
    // The <video> mounts with the stage, on the same render as 'starting'.
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    const video = videoRef.current;
    if (!video || deadRef.current) return;
    let stream: MediaStream;
    try {
      stream = await openCamera(video);
    } catch (err) {
      console.warn('[capture] camera unavailable', err);
      setPhase('blocked');
      return;
    }
    // Unmounted, or closed, while the permission prompt was up: release it, or the light stays on.
    if (deadRef.current || videoRef.current !== video) {
      stopStream(stream);
      return;
    }
    streamRef.current = stream;
    setTorchAvailable(hasTorch(stream));
    setResolution(trackResolution(stream));
    setPhase('live');

    loopRef.current = startFrameLoop({
      video,
      guide: GUIDE,
      onFrame: async (gray) => {
        // Nothing to OCR with yet, or a photo is being read: this frame is skipped,
        // not blanked — skipping does not touch the streak, blanking would break it.
        if (deadRef.current || busyRef.current || !engineReadyRef.current) return false;
        const { words } = await engine.recognize(grayToCanvas(preprocess(gray)));
        if (deadRef.current || streamRef.current === null) return false;
        const state = sessionRef.current.observeWords(words);
        if (state.kind === 'settled') {
          stopCamera();
          onSettledRef.current(state, 'live');
          return true;
        }
        setLooking(state);
        return false;
      },
    });
  };

  /** Back to idle. Idempotent; the light goes off. */
  const closeLive = () => {
    stopCamera();
    setTorchOn(false);
    setTorchAvailable(false);
    setResolution(null);
    setLooking(null);
    setPhase('idle');
  };

  const toggleTorch = async () => {
    const next = !torchOn;
    if (await setTorch(streamRef.current, next)) setTorchOn(next);
  };

  const onPhoto = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // let the same photo be retried
    if (!file) return;
    busyRef.current = true;
    setPhoto({ state: 'reading', problems: [] });
    try {
      await engine.init();
      const bitmap = await loadBitmap(file);
      const gray = sourceToGray(bitmap, { maxEdge: STILL_MAX_EDGE });
      if ('close' in bitmap) bitmap.close();
      const { words } = await engine.recognize(grayToCanvas(preprocess(gray)));
      const state = CaptureSession.still(words);
      if (state.kind === 'settled') {
        stopCamera();
        onSettledRef.current(state, 'photo');
        return;
      }
      setPhoto({
        state: 'failed',
        problems: state.sawMoney
          ? state.problems
          : ['No prices found in that photo. Fill the frame with the receipt, flat, in good light.'],
      });
    } catch (err) {
      console.error('[capture] photo failed', err);
      setPhoto({ state: 'failed', problems: ['Could not read that photo.'] });
    } finally {
      busyRef.current = false;
    }
  };

  const photoInput = (
    <label class="btn btn-secondary">
      {photo.state === 'reading' ? 'Reading photo…' : 'Use a photo'}
      <input type="file" accept="image/*" capture="environment" class="sr-only" onChange={onPhoto} disabled={photo.state === 'reading'} />
    </label>
  );

  const snapshot = looking?.snapshot;
  const status = (() => {
    if (engineState === 'failed') return 'The reader failed to load. Reload the page to try again.';
    if (engineState === 'loading') return 'Loading the reader — one time, about 6 MB…';
    if (phase === 'idle') return 'Open the camera and fill the frame with the receipt, or use a photo.';
    if (phase !== 'live') return null;
    if (!looking) return 'Fill the frame with the receipt.';
    if (snapshot?.unsteady) return 'Hold steady — not reading the same numbers twice.';
    if (looking.awaitingRepeat) return 'Nearly there — hold it for one more frame.';
    if (!looking.sawMoney) return 'Looking for prices… move closer, or turn on the light.';
    return 'Reading… keep the whole receipt in the frame.';
  })();

  const fallback = phase === 'blocked' || phase === 'nocamera';
  const showStage = phase === 'starting' || phase === 'live';

  return (
    <main class="screen capture">
      <header class="topbar">
        <h1>Receipt Splitter</h1>
        <span class="muted small">Nothing leaves your phone</span>
      </header>

      {phase === 'idle' && (
        <div class="stage idle">
          <button type="button" class="btn btn-primary big" onClick={openLive} disabled={engineState === 'failed'}>
            Open camera
          </button>
          <span class="small" style={{ color: '#bbb' }}>Asks for camera permission only when you tap</span>
        </div>
      )}

      {showStage && (
        <div class="stage">
          <video ref={videoRef} class="preview" playsInline muted autoPlay />
          <div
            class="guide"
            style={{ left: `${GUIDE.x * 100}%`, top: `${GUIDE.y * 100}%`, width: `${GUIDE.w * 100}%`, height: `${GUIDE.h * 100}%` }}
            aria-hidden="true"
          />
          {torchAvailable && (
            <button type="button" class="btn btn-ghost torch" onClick={toggleTorch}>
              {torchOn ? 'Light off' : 'Light on'}
            </button>
          )}
          <button type="button" class="btn btn-ghost close" onClick={closeLive} aria-label="Close camera">
            ×
          </button>
          {phase === 'starting' && <div class="stage-note">Opening the camera…</div>}
        </div>
      )}

      {fallback && (
        <div class="panel" role="alert">
          {phase === 'blocked' ? CAMERA_BLOCKED : NO_CAMERA}
          {phase === 'blocked' && (
            <div class="row" style={{ marginTop: '0.5rem' }}>
              <button type="button" class="btn btn-secondary" onClick={openLive}>
                Try the camera again
              </button>
            </div>
          )}
        </div>
      )}

      <section class="status" aria-live="polite">
        {status && <p class="status-line">{status}</p>}
        {snapshot && phase === 'live' && (
          <ul class="streaks" aria-label="Confirmation progress">
            {FIELDS.map((f) => (
              <li key={f} class={snapshot.confirmed[f] !== null ? 'confirmed' : snapshot.streaks[f] > 0 ? 'seen' : ''}>
                <span class="dots" aria-hidden="true">
                  {Array.from({ length: snapshot.confirmationsNeeded }, (_, i) => (
                    <i key={i} class={i < snapshot.streaks[f] ? 'on' : ''} />
                  ))}
                </span>
                {f}
              </li>
            ))}
          </ul>
        )}
        {looking?.problems[0] && !snapshot?.unsteady && <p class="muted small">{looking.problems[0]}</p>}
        {photo.state === 'failed' && (
          <div class="panel warn" role="status">
            <strong>Couldn’t settle that photo.</strong>
            <ul>
              {photo.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
            <p class="small muted">Refusing is on purpose: a wrong split is worse than none.</p>
          </div>
        )}
        <p class="meta small muted">
          {resolution && <span>{resolution}</span>}
          {snapshot && <span>{snapshot.framesSeen} frames</span>}
          <span>{engine.name}</span>
        </p>
      </section>

      <footer class="actions">
        {photoInput}
        <button type="button" class="btn btn-secondary" onClick={onManual}>
          Type it in
        </button>
      </footer>
    </main>
  );
}

async function loadBitmap(file: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      // Honour EXIF rotation, or a portrait receipt arrives sideways.
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      /* fall through to <img> */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('image decode failed'));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

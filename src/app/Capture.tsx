import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { OcrEngine } from '../ocr/engine';
import { sourceToGray } from '../ocr/canvas';
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
 * Shape borrowed from the ERP's <CameraScanner>: a live preview with a frame
 * loop behind it, a torch button that only appears when the device has one,
 * the negotiated resolution on screen so a failure is a measurement, an
 * "unsteady" hint that outranks stale status, a still-photo path as the
 * escalation (and the only path when getUserMedia is blocked), and an
 * idempotent stop so the camera light never stays on.
 *
 * What is different: the loop hands each frame to OCR, and the accept decision
 * belongs to `CaptureSession`, which is pure and tested. This component owns
 * the camera and the pixels, nothing about money.
 *
 * The page opens with the camera CLOSED. Nothing asks for a permission until
 * the user taps for it — a portfolio visitor who only wanted to read should
 * never see a camera prompt, and on a phone the prompt is the moment the app
 * either earns trust or loses it.
 */

/** Portrait guide, as fractions of the preview. A receipt is tall. */
const GUIDE: Guide = { x: 0.08, y: 0.05, w: 0.84, h: 0.9 };

/** Long-edge cap for a camera-app photo — see sourceToGray. */
const STILL_MAX_EDGE = 3000;

const CAMERA_BLOCKED = 'The camera’s blocked. Choose a photo or type it in instead.';
const NO_CAMERA = 'No camera here. Choose a photo or type it in instead.';

const FIELDS = ['subtotal', 'tax', 'tip', 'total'] as const;

/** A single image, from the user's camera roll or the bundled example. */
export type StillSource = 'photo' | 'example';

export interface CaptureProps {
  engine: OcrEngine;
  /** `image` is a URL the review screen may show; blob: URLs are the caller's to revoke. */
  onSettled: (state: Settled, source: 'live' | StillSource, image: string | null) => void;
  onManual: () => void;
}

type Phase = 'idle' | 'starting' | 'live' | 'blocked' | 'nocamera';

interface StillState {
  state: 'idle' | 'reading' | 'failed';
  /** Shown in the stage while it is read, and kept on failure so the user sees what was tried. */
  url: string | null;
  problems: string[];
}

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
  const [still, setStill] = useState<StillState>({ state: 'idle', url: null, problems: [] });

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

  // Leaving the tab turns the camera off; Scan turns it back on. Nothing
  // should hold the camera, or run OCR, behind a page nobody is looking at.
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden && streamRef.current) closeLive();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
    // closeLive only touches refs and state setters, so the first one serves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** The user asked for the camera. Only now does the permission prompt appear. */
  const openLive = async () => {
    if (!hasCamera()) {
      setPhase('nocamera');
      return;
    }
    setStill({ state: 'idle', url: null, problems: [] });
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
    // The OS can take the camera back (a call, another app). Land on the start
    // screen rather than a frozen preview that is still "reading".
    stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (streamRef.current === stream) closeLive();
    });
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
        const { words } = await engine.recognize(preprocess(gray));
        if (deadRef.current || streamRef.current === null) return false;
        const state = sessionRef.current.observeWords(words);
        if (state.kind === 'settled') {
          stopCamera();
          onSettledRef.current(state, 'live', null);
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

  /**
   * One image through the whole pipeline. The same code serves the camera
   * roll and the bundled example, so the example is a real test of the
   * reader, not a canned result.
   */
  const readStill = async (blob: Blob, url: string, source: StillSource) => {
    if (phase === 'live' || phase === 'starting') closeLive();
    busyRef.current = true;
    setStill({ state: 'reading', url, problems: [] });
    try {
      await engine.init();
      const bitmap = await loadBitmap(blob);
      const gray = sourceToGray(bitmap, { maxEdge: STILL_MAX_EDGE });
      if ('close' in bitmap) bitmap.close();
      const { words } = await engine.recognize(preprocess(gray));
      if (deadRef.current) return;
      const state = CaptureSession.still(words);
      if (state.kind === 'settled') {
        onSettledRef.current(state, source, url);
        return;
      }
      setStill({
        state: 'failed',
        url,
        problems: state.sawMoney
          ? state.problems
          : ['No prices found. Retake it flat, close up, in good light.'],
      });
    } catch (err) {
      console.error('[capture] photo failed', err);
      setStill({ state: 'failed', url, problems: ['Couldn’t open that photo.'] });
    } finally {
      busyRef.current = false;
    }
  };

  const onPhoto = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // let the same photo be retried
    if (!file) return;
    await readStill(file, URL.createObjectURL(file), 'photo');
  };

  const tryExample = async () => {
    const url = new URL('example-receipt.png', document.baseURI).href;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status}`);
      await readStill(await res.blob(), url, 'example');
    } catch (err) {
      console.error('[capture] example missing', err);
      setStill({ state: 'failed', url: null, problems: ['The example receipt didn’t load.'] });
    }
  };

  const reading = still.state === 'reading';
  const snapshot = looking?.snapshot;
  const status = (() => {
    if (engineState === 'failed') return 'Couldn’t load the reader. Reload the page to try again.';
    if (reading) return 'Reading the receipt…';
    if (engineState === 'loading') return 'Loading the reader. About 4.5 MB, first time only.';
    if (phase !== 'live') return null;
    if (!looking) return 'Fill the frame with the receipt.';
    if (snapshot?.unsteady) return 'Hold steady.';
    if (looking.awaitingRepeat) return 'Almost there. Hold still.';
    if (!looking.sawMoney) return 'No prices yet. Move closer or add light.';
    return 'Reading… keep the whole receipt in frame.';
  })();

  const fallback = phase === 'blocked' || phase === 'nocamera';
  const showStage = phase === 'starting' || phase === 'live';
  const showStill = !showStage && still.url !== null;
  // The start screen, and where it lands when the camera can't open: the
  // finder says why, and the other ways in stay right under it.
  const home = (phase === 'idle' || fallback) && !showStill;
  const homeNote = (() => {
    if (fallback) return phase === 'blocked' ? CAMERA_BLOCKED : NO_CAMERA;
    if (still.state === 'failed') return still.problems[0];
    return status ?? 'Nothing leaves your phone.';
  })();

  return (
    <main class="screen capture">
      <header class="hero">
        <h1>Split the check from a photo.</h1>
        <p class="lede">Each person’s share with tax and tip, checked against the total.</p>
      </header>

      {home && (
        <>
          {/* The camera before it's on: the same guide the live preview draws,
              so Scan turns on what's already there. */}
          <div class="stage finder">
            <div class="corners" aria-hidden="true">
              <i />
              <i />
              <i />
              <i />
            </div>
            {phase !== 'nocamera' && (
              <button type="button" class="btn btn-primary big" onClick={openLive} disabled={engineState === 'failed'}>
                <Icon>
                  <path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.1l1.4-2h6l1.4 2h2.1A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z" />
                  <circle cx="12" cy="12.75" r="3.25" />
                </Icon>
                {phase === 'blocked' ? 'Try the camera again' : 'Scan receipt'}
              </button>
            )}
            <p class="finder-note" role={fallback ? 'alert' : undefined} aria-live="polite">
              {homeNote}
            </p>
          </div>

          <ul class="card options">
            <li>
              <button type="button" class="option" onClick={tryExample}>
                <Icon>
                  <path d="M6 3.5h12v17l-2-1.25-2 1.25-2-1.25-2 1.25-2-1.25-2 1.25z" />
                  <path d="M9 8h6M9 11.5h6M9 15h3.5" />
                </Icon>
                Try the example receipt
                <Chevron />
              </button>
            </li>
            <li>
              <label class="option">
                <Icon>
                  <rect x="3.5" y="5" width="17" height="14" rx="2" />
                  <circle cx="9" cy="10" r="1.75" />
                  <path d="m20.5 16-4.5-4.5L7 19" />
                </Icon>
                Choose a photo
                <Chevron />
                <input type="file" accept="image/*" class="sr-only" onChange={onPhoto} />
              </label>
            </li>
            <li>
              <button type="button" class="option" onClick={onManual}>
                <Icon>
                  <rect x="2.75" y="6" width="18.5" height="12" rx="2" />
                  <path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M8 14h8" />
                </Icon>
                Type it in
                <Chevron />
              </button>
            </li>
          </ul>
        </>
      )}

      {showStill && (
        <div class={`stage still${reading ? ' reading' : ''}`}>
          <img src={still.url ?? undefined} alt="The receipt being read" />
          {reading && <div class="stage-note">Reading…</div>}
          {!reading && (
            <button type="button" class="btn btn-ghost close" onClick={() => setStill({ state: 'idle', url: null, problems: [] })} aria-label="Back">
              <Cross />
            </button>
          )}
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
            <Cross />
          </button>
          {phase === 'starting' && <div class="stage-note">Opening the camera…</div>}
        </div>
      )}

      {!home && (
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
          {still.state === 'failed' && (
            <div class="card notice" role="status">
              <p>
                <strong>Couldn’t read that receipt.</strong>
              </p>
              <ul>
                {still.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
              <p class="muted small">It won’t show a split it can’t check.</p>
            </div>
          )}
          {/* Diagnostics, and they change every frame: kept out of the live region's announcements. */}
          {(resolution || snapshot) && (
            <p class="meta" aria-hidden="true">
              {resolution && <span>{resolution}</span>}
              {snapshot && <span>{snapshot.framesSeen} frames</span>}
            </p>
          )}
        </section>
      )}

      {!home && (
        <footer class="actions">
          <label class={`btn btn-secondary${reading ? ' disabled' : ''}`}>
            Choose a photo
            <input type="file" accept="image/*" class="sr-only" onChange={onPhoto} disabled={reading} />
          </label>
          <button type="button" class="btn btn-secondary" onClick={onManual}>
            Type it in
          </button>
          <button type="button" class="btn btn-link" onClick={tryExample} disabled={reading}>
            Try the example
          </button>
        </footer>
      )}
    </main>
  );
}

/** One stroke family for every glyph on this screen: 24px grid, 1.75 stroke, round ends. */
function Icon({ children, class: cls = 'icon' }: { children: ComponentChildren; class?: string }) {
  return (
    <svg
      class={cls}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const Chevron = () => (
  <Icon class="icon chevron">
    <path d="m9 6 6 6-6 6" />
  </Icon>
);

const Cross = () => (
  <Icon>
    <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
  </Icon>
);

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

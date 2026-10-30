import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { TesseractEngine } from '../ocr/tesseract';
import { tesseractPaths } from './paths';
import { Capture, type StillSource } from './Capture';
import { Review } from './Review';
import { adoptIds, billFromParsed, emptyBill, person, type EditableBill } from './bill';
import type { Settled } from '../capture/session';
import type { Person } from '../split/split';

type ReviewScreen = { kind: 'review'; bill: EditableBill; origin: string; image: string | null };
type Screen = { kind: 'capture' } | ReviewScreen;

/**
 * The review screen, kept for this tab. A phone browser reloads a background
 * tab when it wants the memory back — typically while someone is off in a
 * payment app — and the bill must still be there when they return. Per tab,
 * so a new tab starts a new bill. A photo's blob: URL dies with the page, so
 * it is not kept; the example receipt's plain URL is.
 */
const SAVED = 'receipt-splitter:review';
/** Bump when EditableBill changes shape: an older save is dropped, not misread. */
const SAVED_VERSION = 2;

function loadSaved(): ReviewScreen | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(SAVED) ?? 'null');
    if (saved?.v !== SAVED_VERSION) return null;
    adoptIds(saved.bill);
    return { kind: 'review', bill: saved.bill, origin: saved.origin, image: saved.image };
  } catch {
    return null;
  }
}

function save(screen: Screen): void {
  try {
    if (screen.kind !== 'review') {
      sessionStorage.removeItem(SAVED);
      return;
    }
    const image = screen.image?.startsWith('blob:') ? null : screen.image;
    sessionStorage.setItem(SAVED, JSON.stringify({ v: SAVED_VERSION, bill: screen.bill, origin: screen.origin, image }));
  } catch {
    /* storage blocked (private mode, sandbox): the bill lives as long as the page */
  }
}

export function App() {
  // One engine for the life of the page: the worker holds ~10MB of WASM and
  // language data, and a second one is a second copy.
  const engine = useMemo(() => new TesseractEngine(tesseractPaths()), []);
  // Before anything mints an id: a restored bill moves the id counter first.
  const [screen, setScreen] = useState<Screen>(() => loadSaved() ?? { kind: 'capture' });
  // People outlive a scan — the same friends are at the table for the next receipt.
  const peopleRef = useRef<Person[] | null>(null);
  peopleRef.current ??= screen.kind === 'review' ? screen.bill.people : [person('You'), person('Friend')];

  useEffect(() => save(screen), [screen]);

  const settled = (state: Settled, source: 'live' | StillSource, image: string | null) => {
    const origin =
      source === 'example'
        ? 'Read from the example receipt'
        : source === 'photo'
          ? 'Read from your photo'
          : state.via === 'consensus'
            ? `Confirmed across ${state.frames} frames`
            : state.frames === 1
              ? 'Read and verified in one frame'
              : `Verified on frame ${state.frames}`;
    setScreen({ kind: 'review', bill: billFromParsed(state.parsed, peopleRef.current!), origin, image });
  };

  const manual = () =>
    setScreen({ kind: 'review', bill: emptyBill(peopleRef.current!), origin: 'Typed in by hand', image: null });

  if (screen.kind === 'capture') {
    return <Capture engine={engine} onSettled={settled} onManual={manual} />;
  }

  return (
    <Review
      bill={screen.bill}
      origin={screen.origin}
      image={screen.image}
      onChange={(bill) => {
        peopleRef.current = bill.people;
        setScreen({ ...screen, bill });
      }}
      onRescan={() => {
        // A photo's object URL is ours to release; the example's is a plain path.
        if (screen.image?.startsWith('blob:')) URL.revokeObjectURL(screen.image);
        setScreen({ kind: 'capture' });
      }}
    />
  );
}

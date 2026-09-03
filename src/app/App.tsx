import { useMemo, useRef, useState } from 'preact/hooks';
import { TesseractEngine } from '../ocr/tesseract';
import { tesseractPaths } from './paths';
import { Capture, type StillSource } from './Capture';
import { Review } from './Review';
import { billFromParsed, emptyBill, person, type EditableBill } from './bill';
import type { Settled } from '../capture/session';
import type { Person } from '../split/split';

type Screen =
  | { kind: 'capture' }
  | { kind: 'review'; bill: EditableBill; origin: string; image: string | null };

export function App() {
  // One engine for the life of the page: the worker holds ~10MB of WASM and
  // language data, and a second one is a second copy.
  const engine = useMemo(() => new TesseractEngine(tesseractPaths()), []);
  // People outlive a scan — the same friends are at the table for the next receipt.
  const peopleRef = useRef<Person[]>([person('You'), person('Friend')]);
  const [screen, setScreen] = useState<Screen>({ kind: 'capture' });

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
    setScreen({ kind: 'review', bill: billFromParsed(state.parsed, peopleRef.current), origin, image });
  };

  const manual = () =>
    setScreen({ kind: 'review', bill: emptyBill(peopleRef.current), origin: 'Typed in by hand', image: null });

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

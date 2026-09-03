import { describe, it, expect } from 'vitest';
import { CaptureSession } from '../src/capture/session';
import type { ParsedReceipt, FieldName } from '../src/parse/receipt';
import type { Cents } from '../src/types';

function frame(fields: Partial<Record<FieldName, Cents>>, items: Cents[] = []): ParsedReceipt {
  return {
    items: items.map((price, i) => ({ desc: `ITEM ${i}`, price, rowIndex: i })),
    fields: { subtotal: null, tax: null, tip: null, total: null, ...fields },
    fieldRows: {},
    unreadable: [],
    rows: [],
    priceColumnX: null,
  };
}

const ITEMS = [1200, 1450, 700, 1100];
const WHOLE = { subtotal: 4450, tax: 367, tip: 890, total: 5707 };

describe('CaptureSession accept policy', () => {
  it('accepts a frame that reconciles on its own, first time', () => {
    const state = new CaptureSession().observe(frame(WHOLE, ITEMS));
    expect(state.kind).toBe('settled');
    if (state.kind === 'settled') {
      expect(state.via).toBe('frame');
      expect(state.frames).toBe(1);
      expect(state.result.status).toBe('reconciled');
    }
  });

  // The class of answer that produces wrong bills: the books close only after
  // deriving a field. One pose is not enough for it.
  it('makes a repaired single frame repeat before accepting it', () => {
    const session = new CaptureSession();
    // Tip not printed (blank tip line); subtotal + tax == total so the
    // reconciler proposes tip = 0. Correct, and still a repair.
    const preTip = frame({ subtotal: 4450, tax: 367, total: 4817 }, ITEMS);

    const first = session.observe(preTip);
    expect(first.kind).toBe('looking');
    if (first.kind === 'looking') expect(first.awaitingRepeat).toBe(true);

    const second = session.observe(preTip);
    expect(second.kind).toBe('settled');
    if (second.kind === 'settled') {
      expect(second.result.status).toBe('repaired');
      expect(second.result.repairs.map((r) => r.field)).toEqual(['tip']);
    }
  });

  it('breaks the repaired streak when a different repaired bill shows up', () => {
    const session = new CaptureSession();
    session.observe(frame({ subtotal: 4450, tax: 367, total: 4817 }, ITEMS));
    // A misread in between: different subtotal, still "repairable" in isolation.
    const other = session.observe(frame({ subtotal: 4400, tax: 367, total: 4767 }, [1200, 1450, 700, 1050]));
    expect(other.kind).toBe('looking');
    const back = session.observe(frame({ subtotal: 4450, tax: 367, total: 4817 }, ITEMS));
    // Back to the first reading, but the streak restarted — not yet.
    expect(back.kind).toBe('looking');
  });

  it('keeps looking through unresolved frames and reports why', () => {
    const state = new CaptureSession().observe(frame({ total: 5707 }));
    expect(state.kind).toBe('looking');
    if (state.kind === 'looking') {
      expect(state.problems.length).toBeGreaterThan(0);
      expect(state.sawMoney).toBe(true);
      expect(state.awaitingRepeat).toBe(false);
    }
  });

  it('reports a blank frame as not having seen money', () => {
    const state = new CaptureSession().observe(frame({}));
    expect(state.kind).toBe('looking');
    if (state.kind === 'looking') expect(state.sawMoney).toBe(false);
  });

  // QUI A4: junk off the table edge differs every frame, the totals repeat.
  it('settles via consensus when the noise cannot repeat', () => {
    const session = new CaptureSession();
    expect(session.observe(frame(WHOLE, [...ITEMS, 9999])).kind).toBe('looking');
    const state = session.observe(frame(WHOLE, [...ITEMS, 8888]));
    expect(state.kind).toBe('settled');
    if (state.kind === 'settled') expect(state.via).toBe('consensus');
  });

  it('reset() forgets everything', () => {
    const session = new CaptureSession();
    session.observe(frame({ subtotal: 4450, tax: 367, total: 4817 }, ITEMS));
    session.reset();
    const state = session.observe(frame({ subtotal: 4450, tax: 367, total: 4817 }, ITEMS));
    expect(state.kind).toBe('looking');
  });
});

describe('CaptureSession.still', () => {
  it('accepts a reconciled photo outright', () => {
    const state = CaptureSession.still([]);
    expect(state.kind).toBe('looking'); // no words at all
  });

  it('hands a repaired photo over as settled, for the user to confirm', () => {
    // Build words the parser will read as a two-line receipt with no tip.
    const w = (text: string, x0: number, y: number) => ({
      text,
      bbox: { x0, y0: y, x1: x0 + text.length * 10, y1: y + 20 },
      confidence: 90,
    });
    const words = [
      w('BURGER', 10, 10), w('12.00', 300, 10),
      w('FRIES', 10, 40), w('4.50', 300, 40),
      w('SUBTOTAL', 10, 100), w('16.50', 300, 100),
      w('TAX', 10, 130), w('1.32', 300, 130),
      w('TOTAL', 10, 160), w('17.82', 300, 160),
    ];
    const state = CaptureSession.still(words);
    expect(state.kind).toBe('settled');
    if (state.kind === 'settled') {
      expect(state.result.status).toBe('repaired');
      expect(state.result.values.tip).toBe(0);
    }
  });
});

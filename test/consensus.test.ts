import { describe, it, expect } from 'vitest';
import { ReceiptConsensus } from '../src/ocr/consensus';
import type { ParsedReceipt, FieldName } from '../src/parse/receipt';
import type { Cents } from '../src/types';

/** One frame's parse. Geometry is irrelevant to the streak logic. */
function frame(
  fields: Partial<Record<FieldName, Cents>>,
  items: Cents[] = [],
): ParsedReceipt {
  return {
    items: items.map((price, i) => ({ desc: `ITEM ${i}`, price, rowIndex: i })),
    fields: { subtotal: null, tax: null, tip: null, total: null, ...fields },
    fieldRows: {},
    unreadable: [],
    rows: [],
    priceColumnX: null,
  };
}

describe('ReceiptConsensus', () => {
  it('withholds a value seen only once', () => {
    const c = new ReceiptConsensus();
    const snap = c.observe(frame({ total: 5707 }));
    expect(snap.confirmed.total).toBeNull();
    expect(snap.streaks.total).toBe(1);
  });

  it('confirms a value that repeats back to back', () => {
    const c = new ReceiptConsensus();
    c.observe(frame({ total: 5707 }));
    expect(c.observe(frame({ total: 5707 })).confirmed.total).toBe(5707);
  });

  // Rule 1: consecutive, not tallied. A plurality vote would accept 5707 here
  // on three sightings out of five; the claim under test is specifically that a
  // wrong read cannot survive the hand moving, and this one did not survive it.
  it('does not let a non-consecutive majority win', () => {
    const c = new ReceiptConsensus();
    c.observe(frame({ total: 5707 }));
    c.observe(frame({ total: 9999 }));
    c.observe(frame({ total: 5707 }));
    c.observe(frame({ total: 1234 }));
    const snap = c.observe(frame({ total: 5707 }));
    expect(snap.confirmed.total).toBeNull();
  });

  // Rule 2, and MHLHUB measured the lenient variant: ignoring blanks accepts
  // ~10% more and leaves 1.5% wrong.
  it('breaks the streak on a frame that did not read the field', () => {
    const c = new ReceiptConsensus();
    c.observe(frame({ total: 5707 }));
    c.observe(frame({}));
    const snap = c.observe(frame({ total: 5707 }));
    expect(snap.confirmed.total).toBeNull();
    expect(snap.streaks.total).toBe(1);
  });

  it('tracks each field independently', () => {
    const c = new ReceiptConsensus();
    c.observe(frame({ subtotal: 4450, tax: 367 }));
    const snap = c.observe(frame({ subtotal: 4450, tax: 999 }));
    expect(snap.confirmed.subtotal).toBe(4450);
    expect(snap.confirmed.tax).toBeNull();
  });

  it('confirms items only when the same prices repeat, order aside', () => {
    const c = new ReceiptConsensus();
    c.observe(frame({}, [1200, 1450, 700]));
    const snap = c.observe(frame({}, [700, 1200, 1450]));
    expect(snap.items?.map((i) => i.price).sort((a, b) => a - b)).toEqual([700, 1200, 1450]);
  });

  it('rejects an item list that changes between frames', () => {
    const c = new ReceiptConsensus();
    c.observe(frame({}, [1200, 1450]));
    expect(c.observe(frame({}, [1200, 1450, 700])).items).toBeNull();
  });

  // Rule 3. A till report with sixty amounts produced a balancing triple by
  // coincidence, so a dense page must pay another frame.
  it('demands a third frame on a number-dense page', () => {
    const c = new ReceiptConsensus();
    const dense = Array.from({ length: 30 }, (_, i) => 100 + i);
    c.observe(frame({ total: 5707 }, dense));
    const two = c.observe(frame({ total: 5707 }, dense));
    expect(two.confirmationsNeeded).toBe(3);
    expect(two.confirmed.total).toBeNull();
    expect(c.observe(frame({ total: 5707 }, dense)).confirmed.total).toBe(5707);
  });

  it('honours an explicit confirmation count over the derived one', () => {
    const c = new ReceiptConsensus({ confirmations: 1 });
    expect(c.observe(frame({ total: 5707 })).confirmed.total).toBe(5707);
  });

  it('reports unsteady when frames parse but never agree', () => {
    const c = new ReceiptConsensus({ unsteadyAfter: 3 });
    let snap = c.observe(frame({ total: 1 }));
    expect(snap.unsteady).toBe(false);
    for (const v of [2, 3, 4]) snap = c.observe(frame({ total: v }));
    expect(snap.unsteady).toBe(true);
  });

  it('is not unsteady merely because nothing has been read yet', () => {
    const c = new ReceiptConsensus({ unsteadyAfter: 2 });
    let snap = c.observe(frame({}));
    for (let i = 0; i < 5; i++) snap = c.observe(frame({}));
    expect(snap.unsteady).toBe(false);
  });

  it('hands the reconciler only confirmed values', () => {
    const c = new ReceiptConsensus();
    const a = frame({ subtotal: 4450, tax: 367, tip: 890, total: 5707 }, [1200, 1450, 700, 1100]);
    c.observe(a);
    c.observe(frame({ subtotal: 4450, tax: 367, tip: 890, total: 9999 }, [1200, 1450, 700, 1100]));
    const parsed = c.asParsed(a);
    expect(parsed.fields.subtotal).toBe(4450);
    expect(parsed.fields.total).toBeNull();
    expect(parsed.unreadable).toContain('total');
    expect(parsed.items).toHaveLength(4);
  });

  it('starts over after reset', () => {
    const c = new ReceiptConsensus();
    c.observe(frame({ total: 5707 }));
    c.reset();
    expect(c.observe(frame({ total: 5707 })).confirmed.total).toBeNull();
  });
});

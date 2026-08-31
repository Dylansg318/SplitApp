import { describe, it, expect } from 'vitest';
import { settleFrame } from '../src/pipeline';
import { ReceiptConsensus } from '../src/ocr/consensus';
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

const WHOLE = { subtotal: 4450, tax: 367, tip: 890, total: 5707 };

describe('settleFrame ordering', () => {
  // The regression that motivated the ordering: a receipt read perfectly in one
  // frame was refused when the streak was a gate, because no second frame had
  // arrived yet to confirm it.
  it('accepts a first frame that reconciles on its own', () => {
    const settlement = settleFrame(frame(WHOLE, [1200, 1450, 700, 1100]), new ReceiptConsensus());
    expect(settlement.via).toBe('frame');
    expect(settlement.result.values.total).toBe(5707);
  });

  // The real QUI A4 mechanism. Every frame reads the true totals plus a
  // different piece of junk off the table edge, so every frame contradicts its
  // own subtotal and is refused. The junk cannot repeat; the totals do.
  it('settles via consensus once unstable misreads fail to confirm', () => {
    const consensus = new ReceiptConsensus();
    const withJunk = (junk: Cents) => frame(WHOLE, [1200, 1450, 700, 1100, junk]);

    // Frame 1 has nothing to agree with, so nothing is confirmed and it fails.
    expect(settleFrame(withJunk(9999), consensus).via).toBeNull();

    // Frame 2 completes the streak on all four totals. The junk item differs, so
    // it does NOT confirm and drops out — which is the whole mechanism.
    const second = settleFrame(withJunk(8888), consensus);
    expect(second.via).toBe('consensus');
    expect(second.result.values.total).toBe(5707);
    expect(second.result.values.subtotal).toBe(4450);
  });

  // The flip side, and the reason this is safe: a STABLE item set is kept, so
  // consensus cannot quietly discard real line items to force a bill to close.
  it('keeps line items that do repeat', () => {
    const consensus = new ReceiptConsensus();
    const stable = frame(WHOLE, [1200, 1450, 700, 1100]);
    settleFrame(stable, consensus);
    settleFrame(stable, consensus);
    expect(consensus.snapshot().items).toHaveLength(4);
  });

  it('keeps observing frames that settled alone, so the streak stays honest', () => {
    const consensus = new ReceiptConsensus();
    settleFrame(frame(WHOLE, [1200, 1450, 700, 1100]), consensus);
    settleFrame(frame(WHOLE, [1200, 1450, 700, 1100]), consensus);
    expect(consensus.snapshot().confirmed.total).toBe(5707);
  });

  it('reports nothing settled rather than inventing a partial answer', () => {
    const settlement = settleFrame(frame({ total: 5707 }), new ReceiptConsensus());
    expect(settlement.via).toBeNull();
    expect(settlement.result.status).toBe('unresolved');
  });
});

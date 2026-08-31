import { describe, it, expect } from 'vitest';
import { reconcile } from '../src/parse/reconcile';
import type { ParsedReceipt, LineItem, FieldName } from '../src/parse/receipt';
import type { Cents } from '../src/types';

/** Minimal ParsedReceipt; geometry is irrelevant to the arithmetic under test. */
function parsed(
  items: [string, Cents][],
  fields: Partial<Record<FieldName, Cents>>,
): ParsedReceipt {
  return {
    items: items.map(([desc, price], rowIndex): LineItem => ({ desc, price, rowIndex })),
    fields: { subtotal: null, tax: null, tip: null, total: null, ...fields },
    fieldRows: {},
    rows: [],
    priceColumnX: null,
  };
}

describe('reconcile', () => {
  it('accepts a receipt that adds up, and proposes nothing', () => {
    const r = reconcile(
      parsed(
        [['CHEESEBURGER', 1200], ['PAD THAI', 1450], ['DRAFT BEER', 700], ['CALAMARI', 1100]],
        { subtotal: 4450, tax: 367, tip: 890, total: 5707 },
      ),
    );
    expect(r.status).toBe('reconciled');
    expect(r.repairs).toEqual([]);
    expect(r.problems).toEqual([]);
    expect(r.itemsCorroborateSubtotal).toBe(true);
  });

  // The real misread from fixtures/receipts/synthetic/taqueria-faded.png:
  // fading turned "TAX 1.69" into "TAX 19.169" while every other field read
  // correctly. An LLM asked to split this bill would have reported $39.58.
  it('repairs the single misread field that the other three determine', () => {
    const r = reconcile(
      parsed(
        [['AL PASTOR TACO', 425], ['CARNITAS TACO', 425], ['CHIPS AND SALSA', 550], ['HORCHATA', 375]],
        { subtotal: 1775, tax: 19169, tip: 266, total: 2210 },
      ),
    );
    expect(r.status).toBe('repaired');
    expect(r.values.tax).toBe(169);
    expect(r.repairs).toHaveLength(1);
    expect(r.repairs[0]!.field).toBe('tax');
    expect(r.repairs[0]!.from).toBe(19169);
    expect(r.repairs[0]!.to).toBe(169);
    // 'repair the total to 212.10' also balances the books. It is rejected
    // because it leaves a 1080% tax standing — this assertion is the whole
    // difference between a correct split and a confident wrong one.
    expect(r.values.total).toBe(2210);
    expect(r.values.subtotal).toBe(1775);
    expect(r.values.tip).toBe(266);
  });

  it('treats an unfilled tip line as zero rather than an error', () => {
    const r = reconcile(parsed([['LARGE MARGHERITA', 2200]], { subtotal: 2200, tax: 154, total: 2354 }));
    expect(r.status).toBe('repaired');
    expect(r.values.tip).toBe(0);
    expect(r.repairs[0]!.reason).toMatch(/no tip/i);
  });

  it('derives a subtotal the receipt never printed from the line items', () => {
    const r = reconcile(parsed([['TACO', 425], ['HORCHATA', 375]], { tax: 76, tip: 120, total: 996 }));
    expect(r.status).toBe('repaired');
    expect(r.values.subtotal).toBe(800);
    expect(r.itemsCorroborateSubtotal).toBe(true);
  });

  it('derives a single missing field from the other three', () => {
    const r = reconcile(parsed([], { subtotal: 4450, tax: 367, total: 5707 }));
    expect(r.status).toBe('repaired');
    expect(r.values.tip).toBe(890);
  });

  // The safety property. When the error is small, several different single-field
  // corrections all balance the books and all look reasonable. Guessing between
  // them is exactly the confident-wrong-answer failure, so it must refuse.
  it('refuses to guess when more than one correction would balance the bill', () => {
    const r = reconcile(parsed([], { subtotal: 1000, tax: 100, tip: 100, total: 1300 }));
    expect(r.status).toBe('unresolved');
    expect(r.repairs).toEqual([]);
    expect(r.problems.join(' ')).toMatch(/Cannot choose safely/);
  });

  it('refuses when no single correction can balance the bill', () => {
    const r = reconcile(parsed([], { subtotal: 1000, tax: 5000, tip: 9000, total: 1300 }));
    expect(r.status).toBe('unresolved');
    expect(r.problems.join(' ')).toMatch(/no single correction/i);
  });

  it('reports items that do not add up to the printed subtotal', () => {
    const r = reconcile(parsed([['TACO', 425]], { subtotal: 1775, tax: 5000, tip: 9000, total: 1300 }));
    expect(r.status).toBe('unresolved');
    expect(r.itemsCorroborateSubtotal).toBe(false);
    expect(r.problems.join(' ')).toMatch(/some items were missed or misread/i);
  });

  // A total of 10.00 under a 50.00 subtotal is a dropped digit, and repairing
  // the total is the only correction that both balances and stays plausible.
  // Repairing the subtotal instead would imply a 67% tax rate.
  it('identifies the total as the misread field when it reads far too low', () => {
    const r = reconcile(parsed([], { subtotal: 5000, tax: 400, tip: 0, total: 1000 }));
    expect(r.status).toBe('repaired');
    expect(r.values.total).toBe(5400);
    expect(r.repairs[0]!.field).toBe('total');
  });

  // The plausibility bound doing its job. Items corroborate a 10.00 subtotal
  // against a printed 9.00 tax, so every candidate correction leaves a ~90% tax
  // standing. Balancing the books by "fixing" the total would be arithmetically
  // valid and obviously wrong, so nothing is proposed at all.
  it('refuses every repair when one field stays absurd whichever is corrected', () => {
    const r = reconcile(parsed([['SODA', 1000]], { subtotal: 1000, tax: 900, tip: 0, total: 2000 }));
    expect(r.status).toBe('unresolved');
    expect(r.repairs).toEqual([]);
    expect(r.values.total).toBe(2000);
    expect(r.problems.join(' ')).toMatch(/no single correction/i);
  });

  it('never invents money: repaired values still satisfy the printed arithmetic', () => {
    const r = reconcile(
      parsed([['A', 1000]], { subtotal: 1000, tax: 8250, tip: 200, total: 1280 }),
    );
    expect(r.status).toBe('repaired');
    const { subtotal, tax, tip, total } = r.values;
    expect(subtotal! + tax! + tip!).toBe(total);
  });
});

import { describe, it, expect } from 'vitest';
import { parseReceipt } from '../src/parse/receipt';
import { reconcile } from '../src/parse/reconcile';
import { parseCents, type Word } from '../src/types';

/** One printed line: description words on the left, the price right-aligned. */
const line = (y: number, desc: string, price: string): Word[] => [
  ...desc.split(' ').map((text, i) => ({
    text,
    bbox: { x0: 20 + i * 90, y0: y, x1: 100 + i * 90, y1: y + 20 },
    confidence: 90,
  })),
  { text: price, bbox: { x0: 520, y0: y, x1: 600, y1: y + 20 }, confidence: 90 },
];

describe('parseCents', () => {
  it.each([
    ['12.34', 1234],
    ['$12.34', 1234],
    ['12,34', 1234],
    ['1,234.56', 123456],
    ['$12,345.00', 1234500],
  ])('%s -> %i', (raw, cents) => expect(parseCents(raw)).toBe(cents));

  // Malformed money never becomes money: a wrong grouping is a misread, not a number.
  it.each(['19.169', '2300', '12,34.56', '1,23.45', '1,234,56'])('refuses %j', (raw) =>
    expect(parseCents(raw)).toBeNull(),
  );
});

describe('parseReceipt labels', () => {
  it('reads a dish called "Sub" as a dish, not as the subtotal', () => {
    const parsed = parseReceipt([
      ...line(0, 'TURKEY SUB', '9.50'),
      ...line(40, 'FRIES', '4.00'),
      ...line(80, 'SUBTOTAL', '13.50'),
      ...line(120, 'TAX', '1.08'),
      ...line(160, 'TOTAL', '14.58'),
    ]);
    expect(parsed.items.map((i) => i.price)).toEqual([950, 400]);
    expect(parsed.fields.subtotal).toBe(1350);
    // No tip printed, so the reconciler proposes 0 for the user to confirm.
    expect(reconcile(parsed).status).toBe('repaired');
  });
});

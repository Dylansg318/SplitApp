import type { Cents, Word } from '../types';
import { parseCents } from '../types';
import { clusterRows, type Row } from './rows';

export type FieldName = 'subtotal' | 'tax' | 'tip' | 'total';

export interface LineItem {
  desc: string;
  price: Cents;
  /** Index into ParsedReceipt.rows, so the UI can point at the source line. */
  rowIndex: number;
}

export interface ParsedReceipt {
  items: LineItem[];
  fields: Record<FieldName, Cents | null>;
  /**
   * Fields whose LABEL was found but whose value would not parse. Different
   * from absent: the receipt does state this number, we simply could not read
   * it, which is worth telling the user rather than silently deriving.
   */
  unreadable: FieldName[];
  /** Where each field was found, for highlighting a suspect line. */
  fieldRows: Partial<Record<FieldName, number>>;
  rows: Row[];
  /** Right edge of the detected price column, in image pixels. */
  priceColumnX: number | null;
}

/**
 * Label patterns, checked in order. SUBTOTAL must be tested before TOTAL or it
 * matches as a total and the arithmetic silently uses the wrong number — the
 * kind of bug that produces a plausible split that is simply wrong.
 */
const LABELS: [FieldName, RegExp][] = [
  ['subtotal', /\b(SUB\s?-?\s?TOTAL|SUBTTL|SUB)\b/],
  ['tax', /\b(TAX|VAT|GST|HST|PST|SALES\s?TAX)\b/],
  ['tip', /\b(TIP|GRATUITY|SERVICE\s?(CHARGE|CHG)?)\b/],
  ['total', /\b(GRAND\s?TOTAL|TOTAL|BALANCE(\s?DUE)?|AMOUNT\s?DUE)\b/],
];

/**
 * Labels that mark where the totals block begins.
 *
 * NOT anchored to the start of the row. On a real photograph the receipt is a
 * bright rectangle inside a darker scene, and OCR reads the surroundings too —
 * a real Thai Duong receipt produced the row `RE | Subtotal $60.80`, where the
 * `RE |` is a table edge. Anchoring to `^` meant the totals block was never
 * located, so the rows below it stayed eligible as line items and a row whose
 * "Total" label OCR had lost entirely became a $77.34 dish.
 *
 * Still bounded rather than free: the label must appear near the START of the
 * row (see LABEL_LEAD). A dish called "TIP TOP BURGER" must not be mistaken for
 * the totals block, because everything after the block is discarded and a false
 * positive high on the receipt would throw away the whole meal.
 */
const BLOCK_START = /(^|[^A-Z])(SUB\s?-?\s?TOTAL|SUBTTL|GRAND\s?TOTAL|TOTAL|BALANCE(\s?DUE)?|AMOUNT\s?DUE)\b/;

/** How much leading noise may precede a totals label. Roughly two short words. */
const LABEL_LEAD = 14;

/**
 * True when the row opens the totals block.
 *
 * Only the long, distinctive labels count. TAX, VAT and GST were tried and
 * removed: three characters match OCR noise far too readily, and a false
 * positive here is expensive because everything below the boundary is
 * discarded — on a folded fixture a spurious TAX cost the receipt its last
 * line item and broke a bill that had previously reconciled.
 *
 * A genuine totals row also states a number, so one is required.
 */
function opensTotalsBlock(row: Row, hasPrice: boolean): boolean {
  if (!hasPrice) return false;
  const match = BLOCK_START.exec(row.text.toUpperCase().trim());
  return match !== null && match.index <= LABEL_LEAD;
}

/** Rows that carry a price but are not part of the bill's arithmetic. */
const PAYMENT = /\b(CASH|CHANGE|VISA|MASTERCARD|MC|AMEX|DEBIT|CREDIT|CARD|TENDER|AUTH|APPROVED|REF|ACCT)\b/;

/** A run of dashes, underscores or equals signs used as a separator. */
const DIVIDER = /^[-_=~*.\s]+$/;

const moneyOf = (w: Word) => parseCents(w.text);

/**
 * Find the receipt's price column: the x-position where right-aligned money
 * tokens line up. Everything downstream keys off this rather than off text
 * patterns, which is what makes a stray "2 for 1" in a description harmless.
 */
function detectPriceColumn(rows: Row[]): number | null {
  const rightEdges: number[] = [];
  for (const row of rows) {
    const money = row.words.filter((w) => moneyOf(w) !== null);
    const last = money.at(-1);
    if (last) rightEdges.push(last.bbox.x1);
  }
  if (rightEdges.length < 2) return rightEdges[0] ?? null;

  // The column is where most right edges agree. Take the densest cluster rather
  // than the mean, so one stray number in the body cannot drag the column left.
  const sorted = [...rightEdges].sort((a, b) => a - b);
  const span = (sorted.at(-1)! - sorted[0]!) || 1;
  const tolerance = Math.max(span * 0.05, 12);

  let best = { x: sorted[0]!, count: 0 };
  for (const candidate of sorted) {
    const count = sorted.filter((x) => Math.abs(x - candidate) <= tolerance).length;
    if (count > best.count) best = { x: candidate, count };
  }
  return best.x;
}

/** The rightmost money token in the row that sits in the price column. */
function priceOf(row: Row, columnX: number | null, tolerance: number): { price: Cents; at: number } | null {
  const money = row.words
    .map((w, i) => ({ w, i, cents: moneyOf(w) }))
    .filter((m): m is { w: Word; i: number; cents: Cents } => m.cents !== null);
  if (money.length === 0) return null;

  const inColumn = columnX === null ? money : money.filter((m) => Math.abs(m.w.bbox.x1 - columnX) <= tolerance);
  const chosen = (inColumn.length ? inColumn : money).at(-1)!;
  return { price: chosen.cents, at: chosen.i };
}

export function parseReceipt(words: Word[]): ParsedReceipt {
  const rows = clusterRows(words);
  const priceColumnX = detectPriceColumn(rows);
  const pageWidth = Math.max(1, ...rows.map((r) => r.bbox.x1));
  const tolerance = Math.max(pageWidth * 0.06, 15);

  const items: LineItem[] = [];
  const fields: Record<FieldName, Cents | null> = { subtotal: null, tax: null, tip: null, total: null };
  const fieldRows: Partial<Record<FieldName, number>> = {};
  const unreadable: FieldName[] = [];

  /**
   * Where the totals block starts. Receipts are ordered — line items, then the
   * subtotal/tax/tip/total block — and that ordering is the only defence
   * against a misread label leaking into the items.
   *
   * On sushi-dim, "TIP 10.76" was read as "SNIP 10.76". Without this the row
   * matched no label, became a line item, and its 10.76 was absorbed into the
   * item sum. That corrupted sum then stood in for an unreadable subtotal and
   * balanced against the printed total exactly, producing a confidently wrong
   * bill. Nothing in the arithmetic could catch it, because the tip had been
   * added to the subtotal — which is precisely what the equations expect.
   *
   * Detected from the row TEXT, not from a parsed price: on that same receipt
   * the SUBTOTAL line's own value was unreadable, and it is the label that
   * marks the boundary.
   */
  const totalsBlockStart = rows.findIndex((row) =>
    opensTotalsBlock(row, priceOf(row, priceColumnX, tolerance) !== null),
  );

  rows.forEach((row, rowIndex) => {
    if (DIVIDER.test(row.text)) return;

    const found = priceOf(row, priceColumnX, tolerance);
    const upperRow = row.text.toUpperCase().trim();

    // A label whose value would not parse still tells us the receipt HAS this
    // number — worth reporting instead of pretending the line was never there.
    if (!found) {
      const labelOnly = LABELS.find(([, pattern]) => pattern.test(upperRow));
      if (labelOnly && fields[labelOnly[0]] === null && !unreadable.includes(labelOnly[0])) {
        unreadable.push(labelOnly[0]);
      }
      return;
    }

    const desc = row.words
      .slice(0, found.at)
      .map((w) => w.text)
      .join(' ')
      .trim();
    const upper = desc.toUpperCase();

    const label = LABELS.find(([, pattern]) => pattern.test(upper));
    if (label) {
      const [name] = label;
      // First occurrence wins: receipts often repeat TOTAL in the payment block.
      if (fields[name] === null) {
        fields[name] = found.price;
        fieldRows[name] = rowIndex;
      }
      return;
    }

    if (PAYMENT.test(upper)) return;
    if (!desc) return;
    // Past the totals block, an unrecognised priced row is a misread label or a
    // payment line — never a dish. Treating it as one is how a tip becomes food.
    if (totalsBlockStart !== -1 && rowIndex >= totalsBlockStart) return;

    items.push({ desc, price: found.price, rowIndex });
  });

  return { items, fields, fieldRows, unreadable, rows, priceColumnX };
}

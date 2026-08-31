/**
 * Core domain types.
 *
 * MONEY IS ALWAYS INTEGER CENTS. Never a float, anywhere, ever. Invariant 3 of
 * the change record says allocations must sum to the printed total exactly, and
 * you cannot promise that on top of binary floating point — 0.1 + 0.2 is the
 * canonical reason. Cents in, cents out; format to dollars only at the edge.
 */
export type Cents = number;

/** Pixel box in the coordinate space of the image that was recognised. */
export interface BBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * One word located on the page.
 *
 * `confidence` is what the OCR engine reports about itself. It is recorded for
 * diagnostics and deliberately NOT the basis of any trust decision the app
 * makes: a receipt states its own subtotal, tax, tip and total, so correctness
 * is settled by arithmetic that reconciles against those printed numbers, not
 * by a number the engine made up about its own certainty. See invariant 2.
 */
export interface Word {
  text: string;
  bbox: BBox;
  confidence: number;
}

export interface OcrResult {
  words: Word[];
  /** Dimensions of the recognised image, so geometry is interpretable later. */
  width: number;
  height: number;
  engine: string;
  ms: number;
}

/** A synthetic or real fixture's known-correct contents, in cents. */
export interface ReceiptGroundTruth {
  id: string;
  merchant: string;
  items: { desc: string; price: Cents }[];
  subtotal: Cents;
  tax: Cents;
  tip: Cents;
  total: Cents;
  /** What was done to the image to make it harder. "clean" for the baseline. */
  variant: string;
  /**
   * The receipt's text in reading order, EXCLUDING the dashed divider rows.
   * The dividers are printed and the parser must cope with them, but they carry
   * no data and OCR is right to drop them — scoring them as missed characters
   * made a flawless read register as 70% accurate.
   */
  fullText: string;
}

/** Cents -> "12.34". No currency symbol; callers add one if they want it. */
export const formatCents = (c: Cents): string =>
  `${Math.trunc(Math.abs(c) / 100)}.${String(Math.abs(c) % 100).padStart(2, '0')}`;

/** "12.34" / "$12.34" / "12,34" -> 1234. Returns null if not a money token. */
export const parseCents = (raw: string): Cents | null => {
  const m = raw.trim().replace(/[$\s]/g, '').replace(',', '.').match(/^(\d+)\.(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 100 + Number(m[2]);
};

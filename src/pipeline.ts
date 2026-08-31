import type { ParsedReceipt } from './parse/receipt';
import { reconcile, type Reconciliation } from './parse/reconcile';
import { ReceiptConsensus } from './ocr/consensus';

/**
 * How a frame becomes a settled bill, and in which ORDER.
 *
 * The order is the whole content of this file, and it was measured rather than
 * reasoned. Three policies over the same real receipts:
 *
 *   single frame only    1/4 correct, 0 wrong
 *   confirmation streak  1/4 correct, 0 wrong   (gains one, LOSES another)
 *   single, then streak  2/4 correct, 0 wrong
 *
 * Requiring confirmation before accepting anything costs acceptance — MHLHUB
 * measured the same effect on barcodes, 154/220 accepted falling to 108/220.
 * They took that trade because it moved wrong reads from 9 to 0. We cannot make
 * that trade, because we are ALREADY at zero wrong: a receipt states its own
 * subtotal, tax and total, so the reconciler holds the line a barcode has
 * nothing to hold it with. Gating on the streak therefore paid the recall price
 * for a safety benefit already in hand — and a receipt that read perfectly in
 * one frame started being refused.
 *
 * So the streak is a FALLBACK, not a gate:
 *
 *   1. If this frame reconciles ON ITS OWN, accept it. The receipt's own
 *      arithmetic already vouches for it and a second frame adds nothing.
 *   2. Otherwise fall back to the accumulated view.
 *
 * WHAT THE FALLBACK ACTUALLY DOES, which is not what it looks like. Consensus
 * only ever reports values that REPEATED, so it cannot supply a field that
 * appeared in a single frame — it is not filling gaps. It is deleting noise.
 * On the QUI A4 receipt every frame carried spurious line items summing to
 * $642 against a printed $141 subtotal, so each frame contradicted itself and
 * was refused. Junk read off a table edge does not survive the hand moving, so
 * those items never confirm, the contradiction disappears, and what remains is
 * the stable core the receipt actually stated. That is the same suppression
 * MHLHUB gets against fabricated barcodes, showing up here as unstable items
 * rather than a wrong payload.
 *
 * Consensus can then only ever ADD settlements, never remove one.
 */
export type SettledVia = 'frame' | 'consensus';

export interface Settlement {
  result: Reconciliation;
  /** Which route settled it, or null when neither could. */
  via: SettledVia | null;
}

/**
 * Feed one frame's parse; get the best available answer.
 *
 * Always observe the frame, even when it settles on its own — the streak has to
 * keep building for the NEXT receipt, and a consensus fed only the failures
 * would carry a distorted history.
 */
export function settleFrame(parsed: ParsedReceipt, consensus: ReceiptConsensus): Settlement {
  const alone = reconcile(parsed);
  consensus.observe(parsed);

  if (alone.status !== 'unresolved') return { result: alone, via: 'frame' };

  const agreed = reconcile(consensus.asParsed(parsed));
  return agreed.status !== 'unresolved'
    ? { result: agreed, via: 'consensus' }
    : { result: alone, via: null };
}

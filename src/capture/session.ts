import type { Word } from '../types';
import { parseReceipt, type ParsedReceipt } from '../parse/receipt';
import { reconcile, type Reconciliation } from '../parse/reconcile';
import { settleFrame, type SettledVia } from '../pipeline';
import { ReceiptConsensus, type ConsensusSnapshot } from '../ocr/consensus';

/**
 * THE ACCEPT POLICY for a live camera session — what turns a stream of OCR'd
 * frames into "stop, we have the bill".
 *
 * `settleFrame` already encodes the measured ordering (a frame that reconciles
 * alone is accepted; otherwise consensus deletes the noise). This layer adds
 * the one rule that ordering left to the UI, from pipeline.ts:
 *
 *   "a settlement needing REPAIRS is where wrong single-frame answers come
 *    from, and invariant 2 already forbids displaying one before the user
 *    confirms the correction."
 *
 * So the three outcomes of a frame are treated differently:
 *
 *   reconciled  — the receipt's own arithmetic vouches for every number read.
 *                 Accept immediately. A second frame adds nothing.
 *   repaired    — the books close only after deriving one field. The derived
 *                 value is arithmetically forced, but the three it rests on came
 *                 from a single pose. It must REPEAT: the same repaired bill in
 *                 two consecutive frames, MHLHUB's streak applied to exactly the
 *                 class that produces wrong answers. A repair that arrived via
 *                 consensus has already been re-observed and is accepted at once.
 *   unresolved  — keep looking. The consensus keeps building underneath.
 *
 * A still photograph is one frame with no re-observation possible, so it gets a
 * plainer policy: accept what it proves, hand any repair straight to the user
 * for confirmation, refuse the rest. See `CaptureSession.still`.
 */

/** Consecutive identical repaired settlements before one is accepted. */
const REPAIRED_CONFIRMATIONS = 2;

export interface Settled {
  kind: 'settled';
  parsed: ParsedReceipt;
  result: Reconciliation;
  via: SettledVia;
  /** How many frames it took, for the write-up and the status line. */
  frames: number;
}

export interface Looking {
  kind: 'looking';
  snapshot: ConsensusSnapshot;
  /** Why the LAST frame did not settle, in the reconciler's words. */
  problems: string[];
  /** The frame carried money-shaped text at all — distinguishes "aiming" from "unreadable". */
  sawMoney: boolean;
  /** A repaired bill has been seen once and is waiting for a repeat. */
  awaitingRepeat: boolean;
}

export type SessionState = Settled | Looking;

/** Order-independent identity of a settled bill, for the repeat check. */
const settlementKey = (parsed: ParsedReceipt, result: Reconciliation): string => {
  const fields = (['subtotal', 'tax', 'tip', 'total'] as const).map((f) => result.values[f] ?? 'x').join('/');
  const items = parsed.items.map((i) => i.price).sort((a, b) => a - b).join(',');
  return `${fields}|${items}`;
};

const sawMoney = (parsed: ParsedReceipt): boolean =>
  parsed.items.length > 0 || Object.values(parsed.fields).some((v) => v !== null);

export class CaptureSession {
  #consensus = new ReceiptConsensus();
  #repaired: { key: string; count: number } = { key: '', count: 0 };
  #frames = 0;

  /** Feed one frame's OCR output. */
  observeWords(words: Word[]): SessionState {
    return this.observe(parseReceipt(words));
  }

  observe(parsed: ParsedReceipt): SessionState {
    this.#frames += 1;
    const { result, via } = settleFrame(parsed, this.#consensus);

    if (via !== null && result.status === 'reconciled') {
      this.#repaired = { key: '', count: 0 };
      return { kind: 'settled', parsed, result, via, frames: this.#frames };
    }

    if (via !== null && result.status === 'repaired') {
      // Already survived the hand moving — the streak did the confirming.
      if (via === 'consensus') {
        return { kind: 'settled', parsed, result, via, frames: this.#frames };
      }
      const key = settlementKey(parsed, result);
      const count = key === this.#repaired.key ? this.#repaired.count + 1 : 1;
      this.#repaired = { key, count };
      if (count >= REPAIRED_CONFIRMATIONS) {
        return { kind: 'settled', parsed, result, via, frames: this.#frames };
      }
      return {
        kind: 'looking',
        snapshot: this.#consensus.snapshot(),
        problems: [],
        sawMoney: true,
        awaitingRepeat: true,
      };
    }

    // A frame that did not settle breaks the repaired streak too — same rule as
    // the consensus: a gap is a gap.
    this.#repaired = { key: '', count: 0 };
    return {
      kind: 'looking',
      snapshot: this.#consensus.snapshot(),
      problems: result.problems,
      sawMoney: sawMoney(parsed),
      awaitingRepeat: false,
    };
  }

  /**
   * One photograph, no second look. Repairs go straight to the user — the UI
   * shows them as proposals to confirm, never as a split (invariant 2).
   */
  static still(words: Word[]): SessionState {
    const parsed = parseReceipt(words);
    const result = reconcile(parsed);
    if (result.status !== 'unresolved') {
      return { kind: 'settled', parsed, result, via: 'frame', frames: 1 };
    }
    return {
      kind: 'looking',
      snapshot: new ReceiptConsensus().snapshot(),
      problems: result.problems,
      sawMoney: sawMoney(parsed),
      awaitingRepeat: false,
    };
  }

  reset(): void {
    this.#consensus.reset();
    this.#repaired = { key: '', count: 0 };
    this.#frames = 0;
  }
}

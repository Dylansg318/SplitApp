import type { Cents } from '../types';
import type { FieldName, LineItem, ParsedReceipt } from '../parse/receipt';

/**
 * CONFIRMATION STREAKS — ported from MHLHUB's <CameraScanner>.
 *
 * That scanner had the same problem in a smaller shape: a decoder called back
 * per frame, the surface accepted frame one, and one bad frame became the
 * answer. Measured over 220 simulated hand-held sessions on a real degraded
 * barcode:
 *
 *   accept policy       accepted   WRONG
 *   first frame wins    154/220    9  (5.8% of accepted)
 *   2 frames in a row   125/220    1  (0.8%)
 *   3 frames in a row   108/220    0  (0.0%)
 *
 * The premise, in their words: *a drifting hand cannot repeat a wrong read*.
 * A false decode is an artefact of one particular pose — the glare sitting just
 * so, the fold catching the light at one angle. Move a few millimetres and the
 * artefact is gone, while the true value is still there. So back-to-back
 * agreement separates signal from artefact in a way no single frame can, and no
 * confidence score even attempts.
 *
 * That is precisely our lost-decimal failure. A real receipt read `3.75` as
 * `35` and `$23.00` as `$2300`; both were refused as malformed and the fields
 * were simply lost. A decimal point missed at one angle is usually present at
 * another.
 *
 * FOUR RULES CARRIED OVER VERBATIM, because each was paid for in measurement:
 *
 * 1. CONSECUTIVE, not tallied. A running vote lets a value that appeared once
 *    in ten frames win a plurality. The claim being tested is specifically that
 *    a wrong read cannot survive the hand moving.
 * 2. A BLANK FRAME BREAKS THE STREAK, deliberately. MHLHUB measured the lenient
 *    variant (blanks ignored): it accepts ~10% more and leaves 1.5% wrong.
 * 3. THE WIDER THE CANDIDATE SET, THE MORE CONFIRMATION IT NEEDS. There, a
 *    format allow-list; here, how many money-shaped tokens the page carries. A
 *    till report with sixty amounts on it can produce a balancing triple by
 *    coincidence — we already saw exactly that — so it must pay another frame.
 * 4. DO NOT SAMPLE TOO FAST. Adjacent frames become more alike, which weakens
 *    the independence the whole thing rests on. OCR takes 200 ms to 2 s per
 *    frame, so we get this free — but do not "optimise" it away.
 *
 * WHAT IS DIFFERENT HERE. A barcode is one atomic payload; a receipt is a dozen
 * numbers that fail independently, and demanding the whole receipt repeat
 * exactly would almost never fire. So each field keeps its own streak, and the
 * reconciler still has to agree afterwards. That is a second, independent check
 * a barcode never had: a value must both survive the hand moving AND make the
 * receipt add up.
 */

const FIELDS: FieldName[] = ['subtotal', 'tax', 'tip', 'total'];

/** Above this many money tokens on a page, coincidence gets cheap. */
const DENSE_PAGE_TOKENS = 25;

export interface ConsensusOptions {
  /**
   * Frames that must agree back to back. Derived from page density when
   * omitted, mirroring MHLHUB deriving it from the format set rather than
   * fixing it — so a denser page cannot silently inherit the weaker setting.
   */
  confirmations?: number;
  /** Consecutive parsed-but-disagreeing frames before we call it unsteady. */
  unsteadyAfter?: number;
}

export interface ConsensusSnapshot {
  /** Values that have held across `confirmations` consecutive frames. */
  confirmed: Record<FieldName, Cents | null>;
  /** Items, once the same set of prices has repeated. */
  items: LineItem[] | null;
  framesSeen: number;
  /** How long each field's current streak is, for a progress indicator. */
  streaks: Record<FieldName, number>;
  confirmationsNeeded: number;
  /**
   * Frames keep parsing but nothing agrees. The receipt is readable enough to
   * decode and not stable enough to trust — say so, rather than leaving the
   * viewfinder looking merely slow.
   */
  unsteady: boolean;
}

interface Streak<T> {
  value: T | null;
  count: number;
}

/** Canonical key for a set of line items: prices, sorted, order-independent. */
const itemsKey = (items: LineItem[]): string =>
  items.map((i) => i.price).sort((a, b) => a - b).join(',');

export class ReceiptConsensus {
  readonly #unsteadyAfter: number;
  #configured: number | undefined;
  #needed = 2;
  #fields: Record<FieldName, Streak<Cents>>;
  #items: Streak<{ key: string; items: LineItem[] }>;
  #frames = 0;
  #disagreements = 0;

  constructor(options: ConsensusOptions = {}) {
    this.#configured = options.confirmations;
    this.#unsteadyAfter = options.unsteadyAfter ?? 6;
    this.#needed = options.confirmations ?? 2;
    this.#fields = this.#blankFields();
    this.#items = { value: null, count: 0 };
  }

  #blankFields(): Record<FieldName, Streak<Cents>> {
    return {
      subtotal: { value: null, count: 0 },
      tax: { value: null, count: 0 },
      tip: { value: null, count: 0 },
      total: { value: null, count: 0 },
    };
  }

  /** Feed one frame's parse. Returns the state after it. */
  observe(parsed: ParsedReceipt): ConsensusSnapshot {
    this.#frames += 1;

    // Rule 3: a page carrying many money tokens has more ways to coincide.
    if (this.#configured === undefined) {
      const moneyTokens = parsed.items.length + FIELDS.filter((f) => parsed.fields[f] !== null).length;
      if (moneyTokens >= DENSE_PAGE_TOKENS) this.#needed = Math.max(this.#needed, 3);
    }

    let agreedSomething = false;
    let sawSomething = false;

    for (const field of FIELDS) {
      const seen = parsed.fields[field];
      const streak = this.#fields[field];

      // Rule 2: not read this frame is a break, not a pass.
      if (seen === null) {
        this.#fields[field] = { value: null, count: 0 };
        continue;
      }
      sawSomething = true;
      if (seen === streak.value) {
        this.#fields[field] = { value: seen, count: streak.count + 1 };
        agreedSomething = true;
      } else {
        this.#fields[field] = { value: seen, count: 1 };
      }
    }

    if (parsed.items.length === 0) {
      this.#items = { value: null, count: 0 };
    } else {
      const key = itemsKey(parsed.items);
      sawSomething = true;
      if (this.#items.value?.key === key) {
        this.#items = { value: { key, items: parsed.items }, count: this.#items.count + 1 };
        agreedSomething = true;
      } else {
        this.#items = { value: { key, items: parsed.items }, count: 1 };
      }
    }

    // Decoding steadily but never twice the same is its own failure, and a
    // different message from "still looking".
    this.#disagreements = sawSomething && !agreedSomething ? this.#disagreements + 1 : 0;

    return this.snapshot();
  }

  snapshot(): ConsensusSnapshot {
    const confirmed = {} as Record<FieldName, Cents | null>;
    const streaks = {} as Record<FieldName, number>;
    for (const field of FIELDS) {
      const streak = this.#fields[field];
      streaks[field] = streak.count;
      confirmed[field] = streak.count >= this.#needed ? streak.value : null;
    }
    return {
      confirmed,
      items: this.#items.count >= this.#needed ? (this.#items.value?.items ?? null) : null,
      framesSeen: this.#frames,
      streaks,
      confirmationsNeeded: this.#needed,
      unsteady: this.#disagreements >= this.#unsteadyAfter,
    };
  }

  /**
   * The confirmed view, shaped as a ParsedReceipt so the existing reconciler
   * and splitter consume it unchanged — consensus is a filter in front of the
   * pipeline, not a second pipeline.
   */
  asParsed(source: ParsedReceipt): ParsedReceipt {
    const snap = this.snapshot();
    return {
      ...source,
      items: snap.items ?? [],
      fields: snap.confirmed,
      unreadable: FIELDS.filter((f) => snap.confirmed[f] === null),
    };
  }

  reset(): void {
    this.#fields = this.#blankFields();
    this.#items = { value: null, count: 0 };
    this.#frames = 0;
    this.#disagreements = 0;
    if (this.#configured === undefined) this.#needed = 2;
  }
}

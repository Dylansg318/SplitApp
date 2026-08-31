import type { Cents } from '../types';
import type { FieldName, ParsedReceipt } from './receipt';

/**
 * THE RECONCILER — where confidence actually comes from.
 *
 * OCR engines report a confidence score about themselves. It is not evidence:
 * a fading receipt made Tesseract read "TAX 1.69" as "TAX 19.169" while
 * reporting perfectly healthy confidence. What cannot lie is that a receipt
 * prints its own answer key. Subtotal, tax, tip and total are four numbers
 * describing the same bill, so they constrain each other:
 *
 *     sum(line items) == subtotal
 *     subtotal + tax + tip == total
 *
 * If those hold, the read is *proved* correct, not merely believed. If they do
 * not, the residual says which number is wrong — and when exactly one field is
 * bad, the other three determine its true value outright.
 *
 * Nothing here mutates a bill silently. Repairs are PROPOSED and the UI must
 * confirm them (invariants 2 and 4). A confident wrong split is the single
 * failure this project exists to prevent.
 */

export type ReconcileStatus = 'reconciled' | 'repaired' | 'unresolved';

export interface Repair {
  field: FieldName;
  from: Cents | null;
  to: Cents;
  reason: string;
}

export interface Reconciliation {
  status: ReconcileStatus;
  /** Field values after applying `repairs`. Null where still unknown. */
  values: Record<FieldName, Cents | null>;
  /** Proposed, NOT applied. The user confirms before any split is shown. */
  repairs: Repair[];
  problems: string[];
  itemsSum: Cents;
  /** True when the line items independently corroborate the printed subtotal. */
  itemsCorroborateSubtotal: boolean;
}

type Values = Record<FieldName, Cents | null>;

const FIELDS: FieldName[] = ['subtotal', 'tax', 'tip', 'total'];

/**
 * Sanity bounds. These reject an arithmetically valid but nonsensical repair —
 * without them, "repair the total to 212.10" balances the books just as well as
 * "repair the tax to 1.69" and the wrong one gets picked.
 */
const MAX_TAX_RATE = 0.3;
const MAX_TIP_RATE = 1.0;

function isPlausible(v: Values): boolean {
  const { subtotal, tax, tip, total } = v;
  if (subtotal === null || subtotal <= 0) return false;
  if (total === null || total <= 0) return false;
  // No discount modelling yet, so a total below the subtotal means a misread
  // rather than a comp. Revisit when discount lines are supported.
  if (total < subtotal) return false;
  if (tax !== null && (tax < 0 || tax > subtotal * MAX_TAX_RATE)) return false;
  if (tip !== null && (tip < 0 || tip > subtotal * MAX_TIP_RATE)) return false;
  return true;
}

const balances = (v: Values): boolean =>
  v.subtotal !== null &&
  v.tax !== null &&
  v.tip !== null &&
  v.total !== null &&
  v.subtotal + v.tax + v.tip === v.total;

/** Derive one field from the other three, or null if they are not all known. */
function solveFor(field: FieldName, v: Values): Cents | null {
  const { subtotal, tax, tip, total } = v;
  switch (field) {
    case 'subtotal':
      return total !== null && tax !== null && tip !== null ? total - tax - tip : null;
    case 'tax':
      return total !== null && subtotal !== null && tip !== null ? total - subtotal - tip : null;
    case 'tip':
      return total !== null && subtotal !== null && tax !== null ? total - subtotal - tax : null;
    case 'total':
      return subtotal !== null && tax !== null && tip !== null ? subtotal + tax + tip : null;
  }
}

const money = (c: Cents) => `${(c / 100).toFixed(2)}`;

export function reconcile(parsed: ParsedReceipt): Reconciliation {
  const itemsSum = parsed.items.reduce((sum, i) => sum + i.price, 0);
  const values: Values = { ...parsed.fields };
  const repairs: Repair[] = [];
  const problems: string[] = [];

  // 1. No printed subtotal is normal on short receipts. The items supply it.
  if (values.subtotal === null && parsed.items.length > 0) {
    values.subtotal = itemsSum;
    repairs.push({
      field: 'subtotal',
      from: null,
      to: itemsSum,
      reason: `no printed subtotal; summed ${parsed.items.length} line items`,
    });
  }

  /**
   * The line items are INDEPENDENT evidence about the subtotal, and the only
   * evidence the equations do not already contain.
   *
   * `subtotal + tax + tip == total` has many solutions. On sushi-dim, OCR read
   * the subtotal 59.75 as 70.51; because 70.51 + 4.18 happens to equal the
   * printed total exactly, the books balanced with tip = 0 and a confidently
   * wrong bill was produced. The true reading — subtotal 59.75, tip 10.76 —
   * balances just as well. Nothing inside the four totals can separate them.
   *
   * Six item prices summing to 59.75 can. When they contradict the printed
   * subtotal, the receipt is telling two incompatible stories and there is no
   * safe way to pick one, so the bill is not settled at any cost. This is
   * invariant 2 in its strongest form: refusing is always available, and a
   * plausible wrong total is the one outcome that is not.
   */
  const subtotalContradicted = (): boolean =>
    parsed.items.length > 0 && values.subtotal !== null && itemsSum !== values.subtotal;

  const itemsCorroborateSubtotal = parsed.items.length > 0 && values.subtotal === itemsSum;

  // 2. An unfilled tip line is the normal pre-tip state, not an error — but
  //    only when the subtotal it is inferred from is itself corroborated.
  if (
    values.tip === null &&
    values.subtotal !== null &&
    values.tax !== null &&
    values.total !== null &&
    !subtotalContradicted()
  ) {
    if (values.subtotal + values.tax === values.total) {
      values.tip = 0;
      repairs.push({ field: 'tip', from: null, to: 0, reason: 'no tip on the printed bill' });
    }
  }

  // 3. Exactly one field missing: the other three determine it — again only
  //    when the line items do not dispute the subtotal those three rest on.
  const missing = FIELDS.filter((f) => values[f] === null);
  if (missing.length === 1 && !subtotalContradicted()) {
    const field = missing[0]!;
    const derived = solveFor(field, values);
    if (derived !== null) {
      const trial: Values = { ...values, [field]: derived };
      if (isPlausible(trial)) {
        values[field] = derived;
        repairs.push({
          field,
          from: null,
          to: derived,
          reason: `not read from the receipt; the other three totals require ${money(derived)}`,
        });
      }
    }
  }

  if (balances(values) && !subtotalContradicted()) {
    return {
      status: repairs.length === 0 ? 'reconciled' : 'repaired',
      values,
      repairs,
      problems,
      itemsSum,
      itemsCorroborateSubtotal,
    };
  }

  // 4. Everything present but the books do not close: exactly one field is
  //    wrong. Re-derive each in turn and keep only candidates that both balance
  //    and leave every field plausible. A unique survivor is the misread.
  //    Skipped entirely when the items dispute the subtotal, because then more
  //    than one number is already known to be wrong.
  if (FIELDS.every((f) => values[f] !== null) && !subtotalContradicted()) {
    const candidates = FIELDS.flatMap((field) => {
      // Items independently confirming the subtotal rules it out as the culprit.
      if (field === 'subtotal' && itemsCorroborateSubtotal) return [];
      const derived = solveFor(field, values);
      if (derived === null || derived === values[field]) return [];
      const trial: Values = { ...values, [field]: derived };
      return balances(trial) && isPlausible(trial) ? [{ field, to: derived }] : [];
    });

    if (candidates.length === 1) {
      const { field, to } = candidates[0]!;
      const from = values[field];
      values[field] = to;
      repairs.push({
        field,
        from,
        to,
        reason:
          `the receipt did not add up; ${field} was the only field whose correction ` +
          `balances it (${from === null ? '?' : money(from)} → ${money(to)})`,
      });
      return { status: 'repaired', values, repairs, problems, itemsSum, itemsCorroborateSubtotal };
    }

    problems.push(
      candidates.length === 0
        ? 'The printed totals do not add up and no single correction fixes them — more than one number is likely misread.'
        : `The printed totals do not add up, and ${candidates.length} different corrections would each fix them (${candidates
            .map((c) => c.field)
            .join(', ')}). Cannot choose safely.`,
    );
  } else if (!subtotalContradicted()) {
    problems.push(
      `Could not read ${FIELDS.filter((f) => values[f] === null).join(', ')} from the receipt, ` +
        'and too little is known to derive the missing values.',
    );
  }

  if (parsed.items.length > 0 && values.subtotal !== null && !itemsCorroborateSubtotal) {
    problems.push(
      `The line items add to ${money(itemsSum)} but the receipt says the subtotal is ` +
        `${money(values.subtotal)} — some items were missed or misread.`,
    );
  }

  return { status: 'unresolved', values, repairs, problems, itemsSum, itemsCorroborateSubtotal };
}

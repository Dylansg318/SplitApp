import type { Cents } from '../types';
import type { ParsedReceipt } from '../parse/receipt';
import { reconcile, type Reconciliation } from '../parse/reconcile';
import { splitBill, splitEvenly, SplitError, type BillItem, type Person, type Split } from '../split/split';

/**
 * THE EDITABLE BILL — what the review screen renders and edits.
 *
 * Every number OCR produced is a first draft (invariant 4), so this holds the
 * RAW values and re-derives everything else on each render:
 *
 *   - `reconcile()` over the current values is the reconciliation banner. The
 *     same function that judged the camera frame judges the user's edits, so
 *     there is one definition of "adds up" in the app rather than two that can
 *     drift. Repairs it proposes are shown as proposals, and applied only when
 *     the user says so.
 *   - The split exists only while the bill reconciles with NO outstanding
 *     repair (invariant 2). Edit a total so the books stop closing and the
 *     split disappears the same render, with the banner saying why.
 *
 * Nothing in here touches the DOM, so it is tested as plain functions.
 */
export interface EditableBill {
  people: Person[];
  items: BillItem[];
  subtotal: Cents | null;
  tax: Cents | null;
  tip: Cents | null;
  total: Cents | null;
}

export type TotalsField = 'subtotal' | 'tax' | 'tip' | 'total';

let nextId = 1;
const id = (prefix: string): string => `${prefix}${nextId++}`;

export const person = (name: string): Person => ({ id: id('p'), name });

export const emptyBill = (people: Person[]): EditableBill => ({
  people,
  items: [],
  subtotal: null,
  tax: null,
  tip: null,
  total: null,
});

/** The camera's reading, verbatim. Repairs are NOT pre-applied — the banner asks. */
export function billFromParsed(parsed: ParsedReceipt, people: Person[]): EditableBill {
  return {
    people,
    items: parsed.items.map((i) => ({ id: id('i'), desc: i.desc, price: i.price, assignees: [] })),
    subtotal: parsed.fields.subtotal,
    tax: parsed.fields.tax,
    tip: parsed.fields.tip,
    total: parsed.fields.total,
  };
}

/** Run the reconciler over the bill as it currently stands. */
export function judge(bill: EditableBill): Reconciliation {
  return reconcile({
    items: bill.items.map((i, rowIndex) => ({ desc: i.desc, price: i.price, rowIndex })),
    fields: { subtotal: bill.subtotal, tax: bill.tax, tip: bill.tip, total: bill.total },
    unreadable: [],
    fieldRows: {},
    rows: [],
    priceColumnX: null,
  });
}

export interface Verdict {
  reconciliation: Reconciliation;
  /** Present only when the bill reconciles outright. */
  split: Split | null;
  /** The split had to fall back to the total alone because there are no items. */
  evenly: boolean;
}

export function verdict(bill: EditableBill): Verdict {
  const reconciliation = judge(bill);
  if (reconciliation.status !== 'reconciled') return { reconciliation, split: null, evenly: false };

  const { subtotal, tax, tip, total } = reconciliation.values;
  if (subtotal === null || tax === null || tip === null || total === null) {
    return { reconciliation, split: null, evenly: false };
  }
  if (bill.people.length === 0) return { reconciliation, split: null, evenly: false };

  if (bill.items.length === 0) {
    return { reconciliation, split: splitEvenly(bill.people, total), evenly: true };
  }
  try {
    return {
      reconciliation,
      split: splitBill({ people: bill.people, items: bill.items, subtotal, tax, tip, total }),
      evenly: false,
    };
  } catch (err) {
    if (err instanceof SplitError) return { reconciliation, split: null, evenly: false };
    throw err;
  }
}

/** Write the reconciler's proposed values in. The user pressed the button. */
export function applyRepairs(bill: EditableBill, reconciliation: Reconciliation): EditableBill {
  const next = { ...bill };
  for (const repair of reconciliation.repairs) next[repair.field] = repair.to;
  return next;
}

export const setField = (bill: EditableBill, field: TotalsField, value: Cents | null): EditableBill => ({
  ...bill,
  [field]: value,
});

export const setItemPrice = (bill: EditableBill, itemId: string, price: Cents): EditableBill => ({
  ...bill,
  items: bill.items.map((i) => (i.id === itemId ? { ...i, price } : i)),
});

export const setItemDesc = (bill: EditableBill, itemId: string, desc: string): EditableBill => ({
  ...bill,
  items: bill.items.map((i) => (i.id === itemId ? { ...i, desc } : i)),
});

export const addItem = (bill: EditableBill, desc = '', price: Cents = 0): EditableBill => ({
  ...bill,
  items: [...bill.items, { id: id('i'), desc, price, assignees: [] }],
});

export const removeItem = (bill: EditableBill, itemId: string): EditableBill => ({
  ...bill,
  items: bill.items.filter((i) => i.id !== itemId),
});

/**
 * Tap a person on an item. Nobody assigned means everyone (invariant 5), so
 * the first tap narrows from "the table" to one person, and un-tapping the
 * last name widens back to the table rather than to nobody.
 */
export const toggleAssignee = (bill: EditableBill, itemId: string, personId: string): EditableBill => ({
  ...bill,
  items: bill.items.map((i) => {
    if (i.id !== itemId) return i;
    const has = i.assignees.includes(personId);
    return { ...i, assignees: has ? i.assignees.filter((p) => p !== personId) : [...i.assignees, personId] };
  }),
});

export const addPerson = (bill: EditableBill, name: string): EditableBill => ({
  ...bill,
  people: [...bill.people, person(name)],
});

/**
 * A placeholder name nobody at the table already has. "Friend", then
 * "Friend 2", "Friend 3"… skipping any that are taken — two people both called
 * "Friend 2" made the item chips ambiguous.
 */
export function nextPlaceholderName(people: Person[]): string {
  const taken = new Set(people.map((p) => p.name.trim().toLowerCase()));
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? 'Friend' : `Friend ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

export const renamePerson = (bill: EditableBill, personId: string, name: string): EditableBill => ({
  ...bill,
  people: bill.people.map((p) => (p.id === personId ? { ...p, name } : p)),
});

/** Removing someone also removes them from every item; the money goes back to the table. */
export const removePerson = (bill: EditableBill, personId: string): EditableBill => ({
  ...bill,
  people: bill.people.filter((p) => p.id !== personId),
  items: bill.items.map((i) => ({ ...i, assignees: i.assignees.filter((p) => p !== personId) })),
});

/** Same shape as parseCents but forgiving of what people type: "12", "12.5", "$12.50". */
export function parseTyped(raw: string): Cents | null {
  const s = raw.trim().replace(/[$,\s]/g, '');
  if (s === '') return null;
  const m = s.match(/^(\d+)(?:\.(\d{0,2}))?$/);
  if (!m) return null;
  const cents = (m[2] ?? '').padEnd(2, '0');
  return Number(m[1]) * 100 + Number(cents);
}

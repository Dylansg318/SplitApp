import type { Cents } from '../types';
import { apportion } from './apportion';

/**
 * THE SPLIT MODEL.
 *
 * One shape covers both ways people actually eat. Every item carries a set of
 * people sharing it: one name is a dish that is yours, several names is family
 * style, and everyone is the default. There is no mode switch, because a real
 * table is both at once — you ordered your own entree and shared the appetisers.
 *
 * Assignment only ever MOVES money (invariant 5). An item with nobody assigned
 * belongs to the whole table, so the bill reconciles the instant it is read and
 * stays reconciled no matter how it is tapped. There is no arrangement of taps
 * that can make the total wrong; the worst you can do is attribute the wrong
 * dish to the wrong friend, which is visible and one tap from fixed.
 */
export interface Person {
  id: string;
  name: string;
}

export interface BillItem {
  id: string;
  desc: string;
  price: Cents;
  /** Empty means the whole table — see invariant 5. */
  assignees: string[];
}

export interface Bill {
  people: Person[];
  items: BillItem[];
  /** Reconciled values, post-confirmation. Never raw OCR output. */
  subtotal: Cents;
  tax: Cents;
  tip: Cents;
  total: Cents;
}

export interface PersonShare {
  personId: string;
  name: string;
  items: Cents;
  tax: Cents;
  tip: Cents;
  total: Cents;
}

export interface Split {
  shares: PersonShare[];
  /** Always equals bill.total. Asserted, not hoped for. */
  total: Cents;
}

export class SplitError extends Error {}

/**
 * Split a reconciled bill.
 *
 * Tax and tip follow each person's share of the subtotal rather than a head
 * count: the person who had a salad should not subsidise the tax on someone
 * else's steak. Both are apportioned exactly, so the pennies land somewhere
 * rather than nowhere.
 */
export function splitBill(bill: Bill): Split {
  const { people, items, subtotal, tax, tip, total } = bill;
  if (people.length === 0) throw new SplitError('Nobody to split between.');

  const itemsSum = items.reduce((s, i) => s + i.price, 0);
  if (itemsSum !== subtotal) {
    // Refusing is the point. A split built on line items that disagree with the
    // receipt's own subtotal is exactly the confident wrong answer invariant 2
    // exists to prevent; the caller should fall back to splitting the total.
    throw new SplitError(
      `Line items add to ${itemsSum} but the subtotal is ${subtotal}. ` +
        'Reconcile the receipt before splitting it.',
    );
  }
  if (subtotal + tax + tip !== total) {
    throw new SplitError(`Bill does not balance: ${subtotal} + ${tax} + ${tip} != ${total}.`);
  }

  const index = new Map(people.map((p, i) => [p.id, i]));
  const perPersonItems = people.map(() => 0);

  for (const item of items) {
    const named = item.assignees.filter((id) => index.has(id));
    // Unassigned, or assigned only to people since removed, falls to the table.
    const sharers = named.length > 0 ? named : people.map((p) => p.id);
    const shares = apportion(item.price, sharers.map(() => 1));
    sharers.forEach((id, i) => {
      const at = index.get(id)!;
      perPersonItems[at] = perPersonItems[at]! + shares[i]!;
    });
  }

  // Weight by what each person actually ate. When nobody ate anything priced,
  // apportion falls back to an even split, which is still exact.
  const taxShares = apportion(tax, perPersonItems);
  const tipShares = apportion(tip, perPersonItems);

  const shares: PersonShare[] = people.map((person, i) => ({
    personId: person.id,
    name: person.name,
    items: perPersonItems[i]!,
    tax: taxShares[i]!,
    tip: tipShares[i]!,
    total: perPersonItems[i]! + taxShares[i]! + tipShares[i]!,
  }));

  const sum = shares.reduce((s, p) => s + p.total, 0);
  if (sum !== total) {
    // Unreachable if apportion holds its contract. Kept as a hard stop because
    // silently shipping a split that does not add up is the whole failure mode.
    throw new SplitError(`Split does not sum to the total: ${sum} != ${total}.`);
  }

  return { shares, total };
}

/**
 * Split when the line items could not be trusted — only the total is known.
 * Everyone pays an equal share, to the penny.
 */
export function splitEvenly(people: Person[], total: Cents): Split {
  if (people.length === 0) throw new SplitError('Nobody to split between.');
  const amounts = apportion(total, people.map(() => 1));
  return {
    shares: people.map((person, i) => ({
      personId: person.id,
      name: person.name,
      items: amounts[i]!,
      tax: 0,
      tip: 0,
      total: amounts[i]!,
    })),
    total,
  };
}

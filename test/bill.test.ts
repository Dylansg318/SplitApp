import { describe, it, expect } from 'vitest';
import {
  addItem,
  addPerson,
  adoptIds,
  applyRepairs,
  billFromParsed,
  emptyBill,
  nextPlaceholderName,
  parseTyped,
  person,
  removePerson,
  setAddedTip,
  setField,
  setItemPrice,
  toggleAssignee,
  verdict,
} from '../src/app/bill';
import type { ParsedReceipt } from '../src/parse/receipt';

const people = () => [person('Alex'), person('Blake'), person('Casey')];

const parsed: ParsedReceipt = {
  items: [
    { desc: 'BURGER', price: 1200, rowIndex: 0 },
    { desc: 'SALAD', price: 1450, rowIndex: 1 },
    { desc: 'FRIES', price: 700, rowIndex: 2 },
    { desc: 'BEER', price: 1100, rowIndex: 3 },
  ],
  fields: { subtotal: 4450, tax: 367, tip: 890, total: 5707 },
  fieldRows: {},
  unreadable: [],
  rows: [],
  priceColumnX: null,
};

describe('the editable bill', () => {
  it('reconciles from first render and splits the whole table evenly', () => {
    const bill = billFromParsed(parsed, people());
    const v = verdict(bill);
    expect(v.reconciliation.status).toBe('reconciled');
    expect(v.split).not.toBeNull();
    expect(v.split!.total).toBe(5707);
    expect(v.split!.shares.reduce((s, p) => s + p.total, 0)).toBe(5707);
  });

  it('assignment moves money without changing the total (invariant 5)', () => {
    let bill = billFromParsed(parsed, people());
    const [alex] = bill.people;
    const [burger] = bill.items;
    bill = toggleAssignee(bill, burger!.id, alex!.id);
    const v = verdict(bill);
    expect(v.split!.total).toBe(5707);
    const alexShare = v.split!.shares.find((s) => s.personId === alex!.id)!;
    // Burger is all Alex's now, plus a third of everything else.
    expect(alexShare.items).toBeGreaterThan(1200);
    // Un-tapping the last name returns the item to the table, not to nobody.
    bill = toggleAssignee(bill, burger!.id, alex!.id);
    expect(bill.items[0]!.assignees).toEqual([]);
    expect(verdict(bill).split!.total).toBe(5707);
  });

  it('withdraws the split the moment the books stop closing (invariant 2)', () => {
    let bill = billFromParsed(parsed, people());
    bill = setField(bill, 'total', 5700);
    const v = verdict(bill);
    expect(v.split).toBeNull();
    // Three different single-field corrections would each close these books
    // (tax, tip or total), so the reconciler refuses to pick — and says so.
    expect(v.reconciliation.status).toBe('unresolved');
    expect(v.reconciliation.problems.join(' ')).toMatch(/different corrections/);
    expect(bill.total).toBe(5700);
  });

  it('splits a receipt with no tip printed as it stands — nothing was misread', () => {
    let bill = billFromParsed(parsed, people());
    bill = setField(bill, 'tip', null);
    bill = setField(bill, 'total', 4817);
    const v = verdict(bill);
    expect(v.noTipPrinted).toBe(true);
    expect(v.split!.total).toBe(4817);
    expect(bill.tip).toBeNull();
  });

  it('applying repairs writes the proposed values in and restores the split', () => {
    let bill = billFromParsed(parsed, people());
    bill = setField(bill, 'tax', null);
    const before = verdict(bill);
    expect(before.split).toBeNull();
    expect(before.reconciliation.repairs[0]).toMatchObject({ field: 'tax', to: 367 });
    bill = applyRepairs(bill, before.reconciliation);
    expect(bill.tax).toBe(367);
    expect(verdict(bill).split!.total).toBe(5707);
  });

  it('adds a tip on top of the printed total, shared like the food', () => {
    let bill = billFromParsed(parsed, people());
    bill = setField(bill, 'tip', null);
    bill = setField(bill, 'total', 4817);
    const [alex] = bill.people;
    bill = toggleAssignee(bill, bill.items[0]!.id, alex!.id);
    bill = setAddedTip(bill, { percent: 20 });
    const v = verdict(bill);
    // 20% of the 44.50 subtotal; the receipt's own numbers are untouched.
    expect(v.addedTip).toBe(890);
    expect(v.reconciliation.values.total).toBe(4817);
    expect(v.split!.total).toBe(4817 + 890);
    expect(v.split!.shares.reduce((s, p) => s + p.total, 0)).toBe(4817 + 890);
    expect(v.split!.shares.reduce((s, p) => s + p.tip, 0)).toBe(890);
    // Alex had the burger as well as a third of the rest, so Alex tips the most.
    const alexTip = v.split!.shares.find((s) => s.personId === alex!.id)!.tip;
    expect(alexTip).toBe(Math.max(...v.split!.shares.map((s) => s.tip)));
  });

  it('a typed tip amount is used as typed, and none means none', () => {
    let bill = billFromParsed(parsed, people());
    bill = setAddedTip(bill, { cents: 1000 });
    expect(verdict(bill).split!.total).toBe(5707 + 1000);
    bill = setAddedTip(bill, null);
    expect(verdict(bill).split!.total).toBe(5707);
  });

  it('adds no tip while the printed numbers do not close', () => {
    let bill = billFromParsed(parsed, people());
    bill = setAddedTip(bill, { percent: 20 });
    bill = setField(bill, 'total', 5700);
    const v = verdict(bill);
    expect(v.split).toBeNull();
    expect(v.addedTip).toBe(0);
  });

  it('editing an item price so items disagree with the subtotal refuses the split', () => {
    let bill = billFromParsed(parsed, people());
    bill = setItemPrice(bill, bill.items[0]!.id, 1300);
    const v = verdict(bill);
    expect(v.split).toBeNull();
    expect(v.reconciliation.status).toBe('unresolved');
    expect(v.reconciliation.problems.join(' ')).toMatch(/line items add to/i);
  });

  it('a bill with no items splits the total evenly, to the penny', () => {
    let bill = emptyBill(people());
    bill = setField(bill, 'subtotal', 1000);
    bill = setField(bill, 'tax', 0);
    bill = setField(bill, 'tip', 0);
    bill = setField(bill, 'total', 1000);
    const v = verdict(bill);
    expect(v.evenly).toBe(true);
    expect(v.split!.shares.map((s) => s.total)).toEqual([334, 333, 333]);
  });

  it('removing a person returns their items to the table', () => {
    let bill = billFromParsed(parsed, people());
    const [alex] = bill.people;
    bill = toggleAssignee(bill, bill.items[0]!.id, alex!.id);
    bill = removePerson(bill, alex!.id);
    expect(bill.people).toHaveLength(2);
    expect(bill.items[0]!.assignees).toEqual([]);
    expect(verdict(bill).split!.total).toBe(5707);
  });

  it('adding people and items keeps ids unique', () => {
    let bill = emptyBill([]);
    bill = addPerson(bill, 'A');
    bill = addPerson(bill, 'B');
    bill = addItem(bill, 'X', 100);
    bill = addItem(bill, 'Y', 200);
    const ids = [...bill.people.map((p) => p.id), ...bill.items.map((i) => i.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('nextPlaceholderName', () => {
  it('skips names already at the table', () => {
    expect(nextPlaceholderName([person('You'), person('Friend')])).toBe('Friend 2');
    expect(nextPlaceholderName([person('You'), person('Friend'), person('Friend 2')])).toBe('Friend 3');
    expect(nextPlaceholderName([person('You'), person('friend 2')])).toBe('Friend');
    expect(nextPlaceholderName([])).toBe('Friend');
  });
});

describe('adoptIds', () => {
  it('keeps ids made after a reload clear of the restored bill', () => {
    // As a reloaded page sees it: ids from an earlier page, well past this counter.
    const restored = {
      ...emptyBill([{ id: 'p900', name: 'Alex' }]),
      items: [{ id: 'i901', desc: 'TEA', price: 300, assignees: [] }],
    };
    adoptIds(restored);
    const added = addItem(restored).items.at(-1)!;
    expect(Number(added.id.slice(1))).toBeGreaterThan(901);
  });
});

describe('parseTyped', () => {
  it.each([
    ['12.34', 1234],
    ['$12.34', 1234],
    ['12', 1200],
    ['12.5', 1250],
    ['1,234.00', 123400],
    [' 0.07 ', 7],
    // A comma-decimal keypad: "12,50" used to read as $1,250.00 and "12,5" as $125.00.
    ['12,50', 1250],
    ['12,5', 1250],
    ['1,234', 123400],
  ])('%s -> %i', (raw, cents) => expect(parseTyped(raw)).toBe(cents));

  it.each(['', 'abc', '12.345', '-3', '1.2.3'])('rejects %j', (raw) =>
    expect(parseTyped(raw)).toBeNull(),
  );
});

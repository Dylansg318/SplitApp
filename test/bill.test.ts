import { describe, it, expect } from 'vitest';
import {
  addItem,
  addPerson,
  applyRepairs,
  billFromParsed,
  emptyBill,
  parseTyped,
  person,
  removePerson,
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

  it('applying repairs writes the proposed values in and restores the split', () => {
    let bill = billFromParsed(parsed, people());
    bill = setField(bill, 'tip', null);
    bill = setField(bill, 'total', 4817);
    const before = verdict(bill);
    expect(before.split).toBeNull();
    expect(before.reconciliation.repairs[0]).toMatchObject({ field: 'tip', to: 0 });
    bill = applyRepairs(bill, before.reconciliation);
    expect(bill.tip).toBe(0);
    expect(verdict(bill).split!.total).toBe(4817);
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

describe('parseTyped', () => {
  it.each([
    ['12.34', 1234],
    ['$12.34', 1234],
    ['12', 1200],
    ['12.5', 1250],
    ['1,234.00', 123400],
    [' 0.07 ', 7],
  ])('%s -> %i', (raw, cents) => expect(parseTyped(raw)).toBe(cents));

  it.each(['', 'abc', '12.345', '-3', '1.2.3'])('rejects %j', (raw) =>
    expect(parseTyped(raw)).toBeNull(),
  );
});

import { describe, it, expect } from 'vitest';
import { apportion } from '../src/split/apportion';
import { splitBill, splitEvenly, SplitError, type Bill, type Person } from '../src/split/split';

const people = (n: number): Person[] =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `Person ${i}` }));

describe('apportion', () => {
  it('never loses or invents a penny', () => {
    expect(apportion(700, [1, 1, 1])).toEqual([234, 233, 233]);
    expect(apportion(700, [1, 1, 1]).reduce((a, b) => a + b, 0)).toBe(700);
  });

  it('weights by share rather than by head', () => {
    expect(apportion(1000, [3, 1])).toEqual([750, 250]);
  });

  it('splits evenly when every weight is zero', () => {
    expect(apportion(300, [0, 0, 0])).toEqual([100, 100, 100]);
    expect(apportion(100, [0, 0, 0])).toEqual([34, 33, 33]);
  });

  it('is deterministic — the same input always splits the same way', () => {
    const once = apportion(1001, [1, 1, 1, 1, 1, 1, 1]);
    for (let i = 0; i < 50; i++) expect(apportion(1001, [1, 1, 1, 1, 1, 1, 1])).toEqual(once);
  });

  it('handles a refund without leaking a penny', () => {
    const shares = apportion(-700, [1, 1, 1]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(-700);
  });

  // The invariant, hammered. Any drift here is money quietly appearing or
  // vanishing on a real bill, which no amount of UI polish would reveal.
  it('sums exactly across 20,000 random apportionments', () => {
    let seed = 1234567;
    const rand = (max: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % max;
    };
    for (let i = 0; i < 20_000; i++) {
      const amount = rand(500_00);
      const weights = Array.from({ length: 1 + rand(9) }, () => rand(5000));
      expect(apportion(amount, weights).reduce((a, b) => a + b, 0)).toBe(amount);
    }
  });
});

describe('splitBill', () => {
  const bill = (items: Bill['items'], n = 3, tax = 367, tip = 890): Bill => {
    const subtotal = items.reduce((s, i) => s + i.price, 0);
    return { people: people(n), items, subtotal, tax, tip, total: subtotal + tax + tip };
  };

  it('splits dish-per-person and family style in the same bill', () => {
    const split = splitBill(
      bill([
        { id: 'a', desc: 'CHEESEBURGER', price: 1200, assignees: ['p0'] },
        { id: 'b', desc: 'PAD THAI', price: 1450, assignees: ['p1'] },
        { id: 'c', desc: 'CALAMARI', price: 1100, assignees: ['p0', 'p1', 'p2'] },
        { id: 'd', desc: 'DRAFT BEER', price: 700, assignees: ['p0', 'p1'] },
      ]),
    );
    expect(split.shares.reduce((s, p) => s + p.total, 0)).toBe(split.total);
    // p2 shared only the calamari: 1100/3 = 367 (largest remainder gives the
    // extra penny to p0), so p2 pays for a third of one dish plus its tax/tip.
    expect(split.shares[2]!.items).toBe(366);
  });

  // Invariant 5: an untouched bill is already correct.
  it('gives an unassigned item to the whole table', () => {
    const split = splitBill(bill([{ id: 'a', desc: 'PIZZA', price: 2100, assignees: [] }], 3, 0, 0));
    expect(split.shares.map((s) => s.items)).toEqual([700, 700, 700]);
  });

  it('reassignment moves money without changing the total', () => {
    const items = [
      { id: 'a', desc: 'STEAK', price: 4000, assignees: [] as string[] },
      { id: 'b', desc: 'SALAD', price: 1000, assignees: [] as string[] },
    ];
    const before = splitBill(bill(items));
    const after = splitBill(bill([{ ...items[0]!, assignees: ['p0'] }, { ...items[1]!, assignees: ['p1'] }]));
    expect(after.total).toBe(before.total);
    expect(after.shares.reduce((s, p) => s + p.total, 0)).toBe(before.total);
    expect(after.shares[0]!.items).toBeGreaterThan(before.shares[0]!.items);
  });

  it('charges tax and tip in proportion to what each person ate', () => {
    const split = splitBill(
      bill(
        [
          { id: 'a', desc: 'STEAK', price: 9000, assignees: ['p0'] },
          { id: 'b', desc: 'SALAD', price: 1000, assignees: ['p1'] },
        ],
        2,
        1000,
        2000,
      ),
    );
    // 90/10 of the subtotal, so 90/10 of the tax and tip — not half each.
    expect(split.shares[0]!.tax).toBe(900);
    expect(split.shares[1]!.tax).toBe(100);
    expect(split.shares[0]!.tip).toBe(1800);
  });

  it('refuses to split a bill whose items disagree with its subtotal', () => {
    expect(() =>
      splitBill({
        people: people(2),
        items: [{ id: 'a', desc: 'X', price: 500, assignees: [] }],
        subtotal: 1775,
        tax: 0,
        tip: 0,
        total: 1775,
      }),
    ).toThrow(SplitError);
  });

  it('refuses to split a bill that does not balance', () => {
    expect(() =>
      splitBill({
        people: people(2),
        items: [{ id: 'a', desc: 'X', price: 500, assignees: [] }],
        subtotal: 500,
        tax: 100,
        tip: 0,
        total: 999,
      }),
    ).toThrow(/does not balance/);
  });

  it('ignores assignees who have left the table', () => {
    const split = splitBill(bill([{ id: 'a', desc: 'WINE', price: 3000, assignees: ['ghost'] }], 3, 0, 0));
    expect(split.shares.map((s) => s.items)).toEqual([1000, 1000, 1000]);
  });

  // Invariant 3, end to end, over the whole model rather than just apportion.
  it('sums to the printed total across 5,000 random bills', () => {
    let seed = 987654321;
    const rand = (max: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % max;
    };
    for (let i = 0; i < 5_000; i++) {
      const crowd = people(1 + rand(6));
      const items = Array.from({ length: 1 + rand(12) }, (_, n) => ({
        id: `i${n}`,
        desc: `ITEM ${n}`,
        price: 1 + rand(9000),
        assignees: crowd.filter(() => rand(2) === 0).map((p) => p.id),
      }));
      const subtotal = items.reduce((s, it) => s + it.price, 0);
      const tax = rand(Math.max(1, Math.floor(subtotal * 0.1)));
      const tip = rand(Math.max(1, Math.floor(subtotal * 0.25)));
      const split = splitBill({ people: crowd, items, subtotal, tax, tip, total: subtotal + tax + tip });
      expect(split.shares.reduce((s, p) => s + p.total, 0)).toBe(subtotal + tax + tip);
    }
  });
});

describe('splitEvenly', () => {
  it('divides a total with no items to the penny', () => {
    const split = splitEvenly(people(3), 5707);
    expect(split.shares.map((s) => s.total)).toEqual([1903, 1902, 1902]);
    expect(split.shares.reduce((s, p) => s + p.total, 0)).toBe(5707);
  });
});

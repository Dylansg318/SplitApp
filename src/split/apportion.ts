import type { Cents } from '../types';

/**
 * Divide an exact number of cents by weights, losing nothing.
 *
 * Three people splitting $7.00 is $2.3333 each. Rounding each share
 * independently gives $2.33 x 3 = $6.99 and a penny evaporates; rounding up
 * gives $7.02 and two pennies appear from nowhere. Either way the split no
 * longer equals the printed total, which is the one thing invariant 3 forbids.
 *
 * The largest-remainder method fixes this: floor every share, then hand the
 * leftover pennies to whoever was rounded down hardest. The result always sums
 * to `amount` exactly, by construction rather than by luck.
 *
 * Ties break toward the earlier index so the same bill always splits the same
 * way (invariant 6) — someone has to get the extra penny, and it must not be
 * decided by iteration order that could change between renders.
 */
export function apportion(amount: Cents, weights: number[]): Cents[] {
  const n = weights.length;
  if (n === 0) return [];
  if (weights.some((w) => w < 0)) throw new Error('apportion: negative weight');

  const totalWeight = weights.reduce((s, w) => s + w, 0);
  // Nothing to weigh by — an all-zero bill, or people who ordered nothing yet.
  // Splitting evenly is the only defensible reading, and still exact.
  const effective = totalWeight === 0 ? weights.map(() => 1) : weights;
  const effectiveTotal = totalWeight === 0 ? n : totalWeight;

  const exact = effective.map((w) => (amount * w) / effectiveTotal);
  const shares = exact.map(Math.floor);
  let remainder = amount - shares.reduce((s, v) => s + v, 0);

  const order = exact
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort((a, b) => b.frac - a.frac || a.index - b.index);

  // `remainder` is always in [0, n) for non-negative inputs, so this terminates
  // without wrapping. Negative amounts (a refund) walk the order backwards.
  const step = remainder >= 0 ? 1 : -1;
  for (let i = 0; remainder !== 0; i++) {
    const target = order[step > 0 ? i % n : n - 1 - (i % n)]!;
    shares[target.index] = shares[target.index]! + step;
    remainder -= step;
  }

  return shares;
}

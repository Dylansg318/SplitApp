import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { TesseractEngine } from '../src/ocr/tesseract';
import { parseReceipt } from '../src/parse/receipt';
import { reconcile } from '../src/parse/reconcile';
import type { ReceiptGroundTruth } from '../src/types';

/**
 * End-to-end over real OCR output: photo -> words -> rows -> fields -> proof.
 *
 * The unit tests hand the reconciler clean numbers. This one hands it whatever
 * Tesseract actually produces, which is the only way to know the geometry holds
 * up. Requires `npm run fixtures`; skipped rather than failed when absent, so a
 * fresh clone does not fail on generated files that are deliberately gitignored.
 */
const DIR = join(import.meta.dirname, '..', 'fixtures', 'receipts', 'synthetic');
const available = existsSync(DIR);

describe.skipIf(!available)('pipeline over synthetic fixtures', () => {
  const engine = new TesseractEngine();
  let fixtures: { gt: ReceiptGroundTruth; image: string }[] = [];

  beforeAll(async () => {
    await engine.init();
    const files = (await readdir(DIR)).filter((f) => f.endsWith('.json'));
    fixtures = await Promise.all(
      files.map(async (f) => ({
        gt: JSON.parse(await readFile(join(DIR, f), 'utf8')) as ReceiptGroundTruth,
        image: join(DIR, `${basename(f, '.json')}.png`),
      })),
    );
    expect(fixtures.length).toBeGreaterThan(0);
  }, 120_000);

  afterAll(async () => {
    await engine.dispose();
  });

  it('reads, parses and proves every fixture', { timeout: 300_000 }, async () => {
    const failures: string[] = [];

    for (const { gt, image } of fixtures) {
      const { words } = await engine.recognize(image);
      const parsed = parseReceipt(words);
      const result = reconcile(parsed);

      if (result.status === 'unresolved') {
        failures.push(`${gt.id}: unresolved — ${result.problems.join('; ')}`);
        continue;
      }
      // The point of reconciliation: whatever OCR did, the numbers it settles on
      // must be the receipt's true numbers.
      for (const field of ['subtotal', 'tax', 'tip', 'total'] as const) {
        if (result.values[field] !== gt[field]) {
          failures.push(
            `${gt.id}: ${field} resolved to ${result.values[field]} but the receipt says ${gt[field]}`,
          );
        }
      }
    }

    expect(failures).toEqual([]);
  });

  // The fixture where OCR demonstrably lied: fade turned TAX 1.69 into 19.169.
  it('recovers the true value of a field OCR misread', { timeout: 120_000 }, async () => {
    const fx = fixtures.find((f) => f.gt.id === 'taqueria-faded');
    expect(fx, 'taqueria-faded fixture missing').toBeDefined();

    const { words } = await engine.recognize(fx!.image);
    const parsed = parseReceipt(words);

    // Two defences, in order. First: OCR reads "1.69" as "19.169", and
    // parseCents refuses it outright — a malformed money token never becomes a
    // number the app will spend. So the field arrives as null, not as garbage.
    expect(parsed.fields.tax, 'expected the OCR misread to still reproduce').toBeNull();

    // Second: with tax the only unknown, the other three fields determine it.
    const result = reconcile(parsed);
    expect(result.status).toBe('repaired');
    expect(result.values.tax).toBe(169);
    expect(result.values.total).toBe(2210);
    expect(result.repairs[0]!.field).toBe('tax');
  });

  it('finds every line item on a clean receipt', { timeout: 120_000 }, async () => {
    const fx = fixtures.find((f) => f.gt.id === 'sushi-clean')!;
    const { words } = await engine.recognize(fx.image);
    const parsed = parseReceipt(words);

    // Prices must be exact — they are the arithmetic.
    expect(parsed.items.map((i) => i.price)).toEqual(fx.gt.items.map((i) => i.price));
    // Descriptions only have to be recognisable to a human deciding who ate
    // what, and are editable anyway. Tesseract reads GYOZA as GY0ZA; nobody is
    // confused by that, and failing the build over it would be theatre.
    expect(parsed.items).toHaveLength(fx.gt.items.length);
    const looksLike = (a: string, b: string) =>
      a.replace(/0/g, 'O').replace(/1/g, 'I') === b.replace(/0/g, 'O').replace(/1/g, 'I');
    parsed.items.forEach((item, i) => {
      expect(looksLike(item.desc, fx.gt.items[i]!.desc), `${item.desc} vs ${fx.gt.items[i]!.desc}`).toBe(true);
    });
  });
});

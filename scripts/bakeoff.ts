/**
 * The bake-off: measure the OCR engine honestly, before building on top of it.
 *
 * This exists so the engine choice is decided by evidence rather than by a
 * benchmark blog post. The number that matters is not character accuracy —
 * it is whether the four numbers the receipt prints about itself (subtotal,
 * tax, tip, total) come back intact, because those are what the reconciler
 * checks the split against. A receipt whose items are mangled but whose totals
 * are clean is still usable; the reverse is not.
 *
 *   npm run fixtures && npm run bakeoff
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { existsSync } from 'node:fs';
import { TesseractEngine } from '../src/ocr/tesseract';
import { preparePng } from '../src/ocr/node';
import type { OcrEngine } from '../src/ocr/engine';
import type { ReceiptGroundTruth, Word, Cents } from '../src/types';
import { parseCents } from '../src/types';

const ROOT = join(import.meta.dirname, '..', 'fixtures', 'receipts');
/**
 * Parallel OCR engines. Two, not one-per-core: each worker holds its own WASM
 * engine and ~15MB of language data, and MHLHUB's Jest suites exhausted memory
 * on this machine by taking the default. Override deliberately when the machine
 * has room — the point is that the number is a decision.
 */
const POOL_SIZE = Number(process.env.BAKEOFF_WORKERS || 2);
/** `npm run bakeoff -- --raw` measures without preprocessing, for comparison. */
const PREPROCESS = !process.argv.includes('--raw');

interface Fixture {
  gt: ReceiptGroundTruth;
  imagePath: string;
  set: 'synthetic' | 'real';
}

interface Measurement {
  id: string;
  set: string;
  variant: string;
  /** Of the receipt's own subtotal/tax/tip/total, how many survived OCR. */
  fieldsFound: number;
  fieldsTotal: number;
  missingFields: string[];
  /** Of the line-item prices, how many survived (multiset match). */
  itemsFound: number;
  itemsTotal: number;
  charAccuracy: number;
  words: number;
  ms: number;
}

async function discover(): Promise<Fixture[]> {
  const out: Fixture[] = [];
  for (const set of ['synthetic', 'real'] as const) {
    const dir = join(ROOT, set);
    if (!existsSync(dir)) continue;
    for (const file of (await readdir(dir)).filter((f) => f.endsWith('.json'))) {
      const gt = JSON.parse(await readFile(join(dir, file), 'utf8')) as ReceiptGroundTruth;
      const stem = basename(file, '.json');
      const image = ['.png', '.jpg', '.jpeg', '.webp']
        .map((ext) => join(dir, stem + ext))
        .find((p) => existsSync(p));
      if (!image) {
        console.warn(`  ! ${set}/${stem}: ground truth with no image, skipped`);
        continue;
      }
      out.push({ gt, imagePath: image, set });
    }
  }
  return out;
}

/** Every money-looking token the engine returned, as cents, with repeats kept. */
const moneyTokens = (words: Word[]): Cents[] =>
  words.map((w) => parseCents(w.text)).filter((c): c is Cents => c !== null);

/** Multiset intersection size: how many of `expected` appear in `got`. */
function multisetHits(expected: Cents[], got: Cents[]): number {
  const pool = new Map<Cents, number>();
  for (const c of got) pool.set(c, (pool.get(c) ?? 0) + 1);
  let hits = 0;
  for (const c of expected) {
    const left = pool.get(c) ?? 0;
    if (left > 0) {
      pool.set(c, left - 1);
      hits++;
    }
  }
  return hits;
}

const normalise = (s: string) => s.toUpperCase().replace(/\s+/g, ' ').trim();

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    prev = row;
  }
  return prev[b.length]!;
}

async function measure(engine: OcrEngine, fx: Fixture): Promise<Measurement> {
  const input = PREPROCESS ? await preparePng(fx.imagePath) : fx.imagePath;
  const result = await engine.recognize(input);
  const got = moneyTokens(result.words);

  const fields: [string, Cents][] = [
    ['subtotal', fx.gt.subtotal],
    ['tax', fx.gt.tax],
    ['tip', fx.gt.tip],
    ['total', fx.gt.total],
  ];
  const missingFields = fields.filter(([, v]) => !got.includes(v)).map(([k]) => k);

  const itemPrices = fx.gt.items.map((i) => i.price);
  const ocrText = normalise(result.words.map((w) => w.text).join(' '));
  const expected = normalise(fx.gt.fullText);

  return {
    id: fx.gt.id,
    set: fx.set,
    variant: fx.gt.variant,
    fieldsFound: fields.length - missingFields.length,
    fieldsTotal: fields.length,
    missingFields,
    itemsFound: multisetHits(itemPrices, got),
    itemsTotal: itemPrices.length,
    charAccuracy: Math.max(0, 1 - levenshtein(ocrText, expected) / Math.max(1, expected.length)),
    words: result.words.length,
    ms: Math.round(result.ms),
  };
}

const pct = (n: number, d: number) => (d === 0 ? '  n/a' : `${((n / d) * 100).toFixed(0).padStart(4)}%`);

async function main(): Promise<void> {
  const fixtures = await discover();
  if (fixtures.length === 0) {
    console.error('No fixtures. Run `npm run fixtures` first.');
    process.exitCode = 1;
    return;
  }
  console.log(
    `Bake-off over ${fixtures.length} fixtures (${POOL_SIZE} workers, ` +
      `preprocessing ${PREPROCESS ? 'ON' : 'OFF'})\n`,
  );

  const engines = Array.from({ length: POOL_SIZE }, () => new TesseractEngine());
  await Promise.all(engines.map((e) => e.init()));

  const queue = [...fixtures];
  const results: Measurement[] = [];
  await Promise.all(
    engines.map(async (engine) => {
      for (;;) {
        const fx = queue.shift();
        if (!fx) return;
        results.push(await measure(engine, fx));
      }
    }),
  );
  await Promise.all(engines.map((e) => e.dispose()));

  results.sort((a, b) => a.id.localeCompare(b.id));

  console.log('fixture                set        totals  items   chars   words   ms');
  console.log('─'.repeat(74));
  for (const r of results) {
    console.log(
      `${r.id.padEnd(22)} ${r.set.padEnd(10)} ${pct(r.fieldsFound, r.fieldsTotal)}  ` +
        `${pct(r.itemsFound, r.itemsTotal)}  ${pct(r.charAccuracy, 1)}  ` +
        `${String(r.words).padStart(5)}  ${String(r.ms).padStart(5)}` +
        (r.missingFields.length ? `   missing: ${r.missingFields.join(',')}` : ''),
    );
  }

  const by = (key: (m: Measurement) => string) => {
    const groups = new Map<string, Measurement[]>();
    for (const r of results) {
      const k = key(r);
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    return groups;
  };

  console.log('\nBy variant');
  console.log('─'.repeat(74));
  for (const [variant, rows] of [...by((r) => r.variant)].sort()) {
    const f = rows.reduce((s, r) => s + r.fieldsFound, 0);
    const ft = rows.reduce((s, r) => s + r.fieldsTotal, 0);
    const i = rows.reduce((s, r) => s + r.itemsFound, 0);
    const it = rows.reduce((s, r) => s + r.itemsTotal, 0);
    const ca = rows.reduce((s, r) => s + r.charAccuracy, 0) / rows.length;
    console.log(
      `${variant.padEnd(22)} ${String(rows.length).padStart(2)} fixtures  ` +
        `totals ${pct(f, ft)}  items ${pct(i, it)}  chars ${pct(ca, 1)}`,
    );
  }

  const allFields = results.reduce((s, r) => s + r.fieldsFound, 0);
  const allFieldsT = results.reduce((s, r) => s + r.fieldsTotal, 0);
  const allItems = results.reduce((s, r) => s + r.itemsFound, 0);
  const allItemsT = results.reduce((s, r) => s + r.itemsTotal, 0);
  const perfect = results.filter((r) => r.missingFields.length === 0).length;

  console.log('\nHeadline');
  console.log('─'.repeat(74));
  console.log(`  Receipts with all four totals intact : ${perfect}/${results.length} (${pct(perfect, results.length).trim()})`);
  console.log(`  Total-field recall                   : ${pct(allFields, allFieldsT).trim()}`);
  console.log(`  Line-item price recall               : ${pct(allItems, allItemsT).trim()}`);
  console.log(
    '\n  Read this as: "all four totals intact" is the gate for reconciliation.\n' +
      '  Item recall below it only costs the user taps, not correctness.',
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

/**
 * Run the whole pipeline against one image and explain what it did.
 *
 * The automated tests prove the system to a machine. This is for proving it to
 * a person: photograph a receipt, point this at it, and read what the parser saw
 * and why it did or did not settle the bill. It is also how a real photograph
 * becomes a fixture — `--fixture <id>` writes the ground-truth scaffold beside
 * the image so only the true amounts need filling in.
 *
 *   npm run try -- ~/Desktop/receipt.jpg
 *   npm run try -- receipt.jpg --people Dylan,Sam,Alex
 *   npm run try -- receipt.jpg --raw          # skip preprocessing, to compare
 *   npm run try -- receipt.jpg --fixture dinner-aug31
 */
import { copyFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import sharp from 'sharp';
import { TesseractEngine } from '../src/ocr/tesseract';
import { readGray, grayToPng } from '../src/ocr/node';
import { preprocess } from '../src/ocr/preprocess';
import { parseReceipt } from '../src/parse/receipt';
import { reconcile } from '../src/parse/reconcile';
import { splitBill, splitEvenly, type Person, type BillItem } from '../src/split/split';
import { formatCents } from '../src/types';

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};
const has = (name: string) => argv.includes(`--${name}`);

const imagePath = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1]?.startsWith('--') !== true);
const names = (flag('people') ?? 'Alex,Blake,Casey').split(',').map((n) => n.trim()).filter(Boolean);
const usePreprocessing = !has('raw');

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const money = (c: number | null) => (c === null ? '—' : formatCents(c).padStart(9));

async function main(): Promise<void> {
  if (!imagePath || !existsSync(imagePath)) {
    console.error('Usage: npm run try -- <image> [--people A,B,C] [--raw] [--fixture <id>]');
    process.exitCode = 1;
    return;
  }

  const meta = await sharp(imagePath).metadata();
  console.log(
    `\n${bold(basename(imagePath))}  ${dim(`${meta.width}x${meta.height}, preprocessing ${usePreprocessing ? 'on' : 'OFF'}`)}\n`,
  );

  const engine = new TesseractEngine();
  const input = usePreprocessing ? await grayToPng(preprocess(await readGray(imagePath))) : imagePath;

  const started = Date.now();
  const { words } = await engine.recognize(input);
  const ocrMs = Date.now() - started;
  await engine.dispose();

  console.log(`${bold('What the camera read')} ${dim(`(${words.length} words, ${(ocrMs / 1000).toFixed(1)}s)`)}`);
  console.log(dim('  ' + words.map((w) => w.text).join(' ').slice(0, 400)) + '\n');

  const parsed = parseReceipt(words);

  console.log(bold('What it understood'));
  if (parsed.items.length === 0) {
    console.log(yellow('  no line items found'));
  }
  for (const item of parsed.items) {
    console.log(`  ${item.desc.slice(0, 40).padEnd(42)}${money(item.price)}`);
  }
  const itemsSum = parsed.items.reduce((s, i) => s + i.price, 0);
  if (parsed.items.length) console.log(dim(`  ${'items add to'.padEnd(42)}${money(itemsSum)}`));
  console.log();
  for (const field of ['subtotal', 'tax', 'tip', 'total'] as const) {
    const value = parsed.fields[field];
    const note = value === null ? (parsed.unreadable.includes(field) ? dim('  line found, value unreadable') : dim('  not found')) : '';
    console.log(`  ${field.toUpperCase().padEnd(42)}${money(value)}${note}`);
  }

  const result = reconcile(parsed);
  console.log(`\n${bold('Does it add up?')}`);
  const { subtotal, tax, tip, total } = result.values;

  if (result.status === 'unresolved') {
    console.log(red('  NO — refusing to show a split.'));
    for (const problem of result.problems) console.log(red(`    • ${problem}`));
    console.log(dim('\n  This is the intended behaviour: a wrong split is worse than no split.'));
    console.log(dim('  Re-shoot flatter, in better light, with the whole receipt in frame.'));
  } else {
    const label = result.status === 'reconciled' ? green('YES — verified against the printed total.') : yellow('YES, after correcting a misread.');
    console.log(`  ${label}`);
    console.log(dim(`    ${formatCents(subtotal!)} + ${formatCents(tax!)} + ${formatCents(tip!)} = ${formatCents(total!)}`));
    for (const repair of result.repairs) {
      console.log(yellow(`    • ${repair.field}: ${repair.reason}`));
    }
    if (result.repairs.length) console.log(dim('      (the app will ask you to confirm each correction)'));
  }

  if (result.status !== 'unresolved') {
    const people: Person[] = names.map((name, i) => ({ id: `p${i}`, name }));
    console.log(`\n${bold(`Split between ${names.join(', ')}`)} ${dim('(nothing assigned yet — shared by everyone)')}`);

    let split;
    try {
      const items: BillItem[] = parsed.items.map((i, n) => ({ id: `i${n}`, desc: i.desc, price: i.price, assignees: [] }));
      split = splitBill({ people, items, subtotal: subtotal!, tax: tax!, tip: tip!, total: total! });
    } catch {
      // Items could not carry the split; the total still can.
      split = splitEvenly(people, total!);
      console.log(dim('  (line items unusable — splitting the total evenly instead)'));
    }
    for (const share of split.shares) console.log(`  ${share.name.padEnd(42)}${money(share.total)}`);
    const sum = split.shares.reduce((s, p) => s + p.total, 0);
    console.log(dim('  ' + '─'.repeat(51)));
    console.log(
      `  ${'adds up to'.padEnd(42)}${money(sum)}  ` +
        (sum === total ? green('✓ matches the printed total') : red('✗ MISMATCH')),
    );
  }

  const fixtureId = flag('fixture');
  if (fixtureId) {
    const dir = join(import.meta.dirname, '..', 'fixtures', 'receipts', 'real');
    await mkdir(dir, { recursive: true });
    const ext = extname(imagePath) || '.jpg';
    await copyFile(imagePath, join(dir, `${fixtureId}${ext}`));
    await writeFile(
      join(dir, `${fixtureId}.json`),
      JSON.stringify(
        {
          id: fixtureId,
          merchant: 'FILL IN',
          items: parsed.items.map((i) => ({ desc: i.desc, price: i.price })),
          subtotal: parsed.fields.subtotal ?? 0,
          tax: parsed.fields.tax ?? 0,
          tip: parsed.fields.tip ?? 0,
          total: parsed.fields.total ?? 0,
          variant: 'real',
          fullText: words.map((w) => w.text).join(' '),
        },
        null,
        2,
      ),
    );
    console.log(
      `\n${bold('Fixture written')} to fixtures/receipts/real/${fixtureId}.json\n` +
        yellow('  These are what the app READ, not the truth. Correct every number by hand\n') +
        yellow('  against the paper receipt — a fixture that agrees with a misread proves nothing.'),
    );
  }
  console.log();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

/**
 * Compare preprocessing recipes on the hard fixtures.
 *
 * The point is to check the browser-bound implementation in src/ocr/preprocess.ts
 * against sharp's native equivalent. sharp cannot ship to a phone, so if the
 * hand-written version does not reach the same recall the measurement that
 * justified this whole approach does not transfer.
 *
 *   npm run fixtures && npm run bench:preprocess
 */
import sharp from 'sharp';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { TesseractEngine } from '../src/ocr/tesseract';
import { preprocess, type Gray } from '../src/ocr/preprocess';
import { parseCents, type ReceiptGroundTruth } from '../src/types';

const DIR = join(import.meta.dirname, '..', 'fixtures', 'receipts', 'synthetic');
const HARD = /-(dim|defocused|handheld)\.json$/;

/** PNG -> single-channel grayscale pixels. */
async function readGray(path: string): Promise<Gray> {
  const { data, info } = await sharp(path).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data), width: info.width, height: info.height };
}

/** Grayscale pixels -> PNG, so tesseract.js can take it. */
const toPng = (img: Gray): Promise<Buffer> =>
  sharp(Buffer.from(img.data), { raw: { width: img.width, height: img.height, channels: 1 } })
    .withMetadata({ density: 144 })
    .png()
    .toBuffer();

const RECIPES: Record<string, (path: string) => Promise<Buffer>> = {
  raw: (p) => sharp(p).greyscale().png().toBuffer(),
  'sharp clahe only': (p) => sharp(p).greyscale().clahe({ width: 64, height: 64 }).png().toBuffer(),
  'sharp sharpen only': (p) => sharp(p).greyscale().sharpen({ sigma: 1.5 }).png().toBuffer(),
  'sharp clahe+sharpen': (p) =>
    sharp(p).greyscale().clahe({ width: 64, height: 64 }).sharpen({ sigma: 1.5 }).png().toBuffer(),
  'ours clahe only': async (p) => toPng(preprocess(await readGray(p), { sharpen: false })),
  'ours sharpen only': async (p) => toPng(preprocess(await readGray(p), { clahe: false })),
  'ours clahe+sharpen': async (p) => toPng(preprocess(await readGray(p))),
};

async function main(): Promise<void> {
  const files = (await readdir(DIR)).filter((f) => HARD.test(f));
  if (files.length === 0) {
    console.error('No hard fixtures. Run `npm run fixtures` first.');
    process.exitCode = 1;
    return;
  }

  const engine = new TesseractEngine();
  await engine.init();

  const scores: Record<string, { hit: number; total: number; ms: number }> = {};
  for (const name of Object.keys(RECIPES)) scores[name] = { hit: 0, total: 0, ms: 0 };

  for (const file of files) {
    const gt = JSON.parse(await readFile(join(DIR, file), 'utf8')) as ReceiptGroundTruth;
    const image = join(DIR, file.replace('.json', '.png'));
    const fields = [gt.subtotal, gt.tax, gt.tip, gt.total];

    for (const [name, recipe] of Object.entries(RECIPES)) {
      const started = performance.now();
      const prepared = await recipe(image);
      const prepMs = performance.now() - started;

      const { words } = await engine.recognize(prepared);
      const got = words.map((w) => parseCents(w.text)).filter((c) => c !== null);

      const score = scores[name]!;
      score.hit += fields.filter((f) => got.includes(f)).length;
      score.total += fields.length;
      score.ms += prepMs;
    }
  }
  await engine.dispose();

  console.log(`\nTotal-field recall over ${files.length} hard fixtures (dim / defocused / handheld)\n`);
  console.log('  recipe                    recall        prep');
  console.log('  ' + '─'.repeat(46));
  for (const [name, s] of Object.entries(scores)) {
    const pct = ((s.hit / s.total) * 100).toFixed(0).padStart(3);
    console.log(
      `  ${name.padEnd(24)} ${pct}%  (${String(s.hit).padStart(2)}/${s.total})  ${(s.ms / files.length).toFixed(0).padStart(4)}ms`,
    );
  }
  console.log(
    '\n  "ours" must match "sharp" — sharp cannot ship to a phone, so a gap here\n' +
      '  means the measurement that justified this approach does not transfer.',
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

/**
 * Does the confirmation streak recover receipts a single frame cannot?
 *
 * Simulates a hand holding a phone: each frame is the same receipt at a
 * slightly different angle, framing and exposure. That is the condition the
 * whole idea rests on — a false read is an artefact of one pose, so moving a
 * few millimetres should kill it while leaving the true value intact.
 *
 * Deliberately mirrors how MHLHUB justified the same policy: simulate many
 * hand-held sessions, then read the WRONG column before the accepted one.
 *
 *   npx tsx scripts/handheld-bench.ts
 */
import sharp from 'sharp';
import { TesseractEngine } from '../src/ocr/tesseract';
import { grayToPng } from '../src/ocr/node';
import { preprocess } from '../src/ocr/preprocess';
import { parseReceipt } from '../src/parse/receipt';
import { reconcile } from '../src/parse/reconcile';
import { ReceiptConsensus } from '../src/ocr/consensus';
import { formatCents, type Cents } from '../src/types';

const DL = '/Users/dylansg/Downloads/';

interface Case {
  file: string;
  name: string;
  truth: { subtotal: Cents; tax: Cents; tip: Cents | null; total: Cents };
}

/** Ground truth read by hand off the photographs. */
const CASES: Case[] = [
  { file: 'B8E7C624-A60F-4D56-9A87-BFBF1FFC452F.JPG', name: 'QUI A4', truth: { subtotal: 14100, tax: 846, tip: null, total: 14946 } },
  { file: '7EBD9619-952A-4453-B27F-A1639C4FAD9A.JPG', name: 'QUI D7', truth: { subtotal: 163700, tax: 9822, tip: 49110, total: 222632 } },
  { file: '735F28D2-2B82-4F30-B26A-0A37403AB159.JPG', name: 'QUI C7', truth: { subtotal: 107900, tax: 6474, tip: 47580, total: 161954 } },
  { file: '6827A3F2-A5BC-434A-A41D-D3AE9E49A5E3.JPG', name: 'THAI', truth: { subtotal: 6080, tax: 365, tip: 1289, total: 7734 } },
];

const FRAMES = 8;

/** Deterministic jitter, so a run is reproducible and comparable. */
function rng(seed: number): () => number {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

/**
 * One frame of a hand holding a phone: angle, framing and exposure all drift.
 *
 * Takes an ALREADY EXIF-rotated buffer. Reading metadata() straight from the
 * file gives the pre-rotation dimensions, so on a photograph whose EXIF says
 * "turn me 90 degrees" the width and height are swapped relative to the image
 * extract() actually operates on, and the crop box lands outside it —
 * "extract_area: bad extract area". Rotating once up front also stops a 6MB
 * JPEG being decoded again for every frame.
 */
async function frame(base: Buffer, W: number, H: number, rand: () => number): Promise<Buffer> {
  const inset = 0.02 + rand() * 0.02;
  const dx = (rand() - 0.5) * 0.02;
  const dy = (rand() - 0.5) * 0.02;

  const left = Math.min(W - 1, Math.max(0, Math.round((inset + dx) * W)));
  const top = Math.min(H - 1, Math.max(0, Math.round((inset + dy) * H)));
  const width = Math.max(1, Math.min(W - left, Math.round(W * (1 - inset * 2))));
  const height = Math.max(1, Math.min(H - top, Math.round(H * (1 - inset * 2))));

  const { data, info } = await sharp(base)
    .extract({ left, top, width, height })
    .rotate((rand() - 0.5) * 3, { background: '#ffffff' })
    .greyscale()
    .linear(0.92 + rand() * 0.16, (rand() - 0.5) * 14)
    .raw()
    .toBuffer({ resolveWithObject: true });

  return grayToPng(preprocess({ data: new Uint8ClampedArray(data), width: info.width, height: info.height }));
}

const matches = (got: Record<string, Cents | null>, truth: Case['truth']): boolean =>
  got['subtotal'] === truth.subtotal &&
  got['tax'] === truth.tax &&
  got['total'] === truth.total &&
  (truth.tip === null || got['tip'] === truth.tip);

async function main(): Promise<void> {
  const engine = new TesseractEngine();
  await engine.init();

  console.log(`\n${FRAMES} simulated hand-held frames per receipt\n`);
  console.log('  receipt   single-frame            confirmation streak');
  console.log('  ' + '─'.repeat(68));

  let singleOk = 0;
  let singleWrong = 0;
  let streakOk = 0;
  let streakWrong = 0;

  for (const testCase of CASES) {
    const rand = rng(20260831);
    const consensus = new ReceiptConsensus();
    // Decode and EXIF-rotate once; every frame is a crop of this.
    const base = await sharp(DL + testCase.file).rotate().toBuffer();
    const baseMeta = await sharp(base).metadata();
    const W = baseMeta.width ?? 0;
    const H = baseMeta.height ?? 0;
    let firstSingle = '';
    let settled = '';

    for (let n = 1; n <= FRAMES; n++) {
      const { words } = await engine.recognize(await frame(base, W, H, rand));
      const parsed = parseReceipt(words);

      // Baseline: what this one frame alone would have concluded.
      const alone = reconcile(parsed);
      if (n === 1) {
        if (alone.status === 'unresolved') firstSingle = 'refused';
        else if (matches(alone.values, testCase.truth)) { firstSingle = 'CORRECT'; singleOk++; }
        else { firstSingle = 'WRONG'; singleWrong++; }
      }

      consensus.observe(parsed);
      if (settled) continue;
      const agreed = reconcile(consensus.asParsed(parsed));
      if (agreed.status !== 'unresolved') {
        settled = matches(agreed.values, testCase.truth)
          ? `CORRECT at frame ${n}`
          : `WRONG at frame ${n} (${formatCents(agreed.values.total ?? 0)})`;
        if (settled.startsWith('CORRECT')) streakOk++; else streakWrong++;
      }
    }

    console.log(`  ${testCase.name.padEnd(9)} ${(firstSingle || 'refused').padEnd(23)} ${settled || 'refused'}`);
  }

  await engine.dispose();
  console.log('\n  ' + '─'.repeat(68));
  console.log(`  single frame        correct ${singleOk}/${CASES.length}   WRONG ${singleWrong}`);
  console.log(`  confirmation streak correct ${streakOk}/${CASES.length}   WRONG ${streakWrong}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

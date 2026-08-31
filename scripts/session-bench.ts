/**
 * Sessions of INDEPENDENTLY degraded frames — the honest multi-frame benchmark.
 *
 * The earlier hand-held bench was wrong in a way Dylan spotted: every frame was
 * a re-jitter of ONE photograph, so a decimal point lost in that capture was
 * lost in all eight. Rotating the same pixels models hand tremor but not
 * RE-OBSERVATION. A live camera re-samples the actual paper — fresh autofocus,
 * different parallax, specular highlights that move, flash — and that is where
 * the new information comes from. So that bench measured something worse than
 * MHLHUB's own pessimistic case, and understated consensus accordingly.
 *
 * This one follows MHLHUB's scan-bench instead: render CLEAN once, then degrade
 * every frame independently, with neighbour-to-neighbour similarity controlled
 * by an AR(1) walk:
 *
 *     d_n  = rho * d_(n-1) + sqrt(1 - rho^2) * draw
 *     rho  = exp(-spacingMs / TREMOR_TAU_MS)
 *
 * The sqrt(1 - rho^2) term keeps the MARGINAL degradation identical at every
 * spacing, so frame quality does not improve as frames spread out — only their
 * similarity changes. That separation is the entire point: without it, widening
 * the spacing would quietly make each frame easier and the streak would look
 * good for the wrong reason.
 *
 *   npx tsx scripts/session-bench.ts --frames 6 --spacingMs 400
 *   npx tsx scripts/session-bench.ts --spacingMs 0      # frozen pose, worst case
 */
import sharp from 'sharp';
import { TesseractEngine } from '../src/ocr/tesseract';
import { grayToPng } from '../src/ocr/node';
import { preprocess } from '../src/ocr/preprocess';
import { parseReceipt } from '../src/parse/receipt';
import { reconcile } from '../src/parse/reconcile';
import { ReceiptConsensus } from '../src/ocr/consensus';
import { SPECS, renderClean } from './lib/synthetic';
import type { Cents } from '../src/types';

const arg = (name: string, fallback: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
};

const FRAMES = arg('frames', 6);
const SPACING_MS = arg('spacingMs', 400);
const SESSIONS = arg('sessions', 4);
/**
 * How near the cliff to sit. At the default degradation every policy settled
 * every session — a saturated bench distinguishes nothing, which is MHLHUB's
 * own note: if everything answers, move the fixture nearer the cliff. The
 * policies only differ where a single frame is MARGINAL, so difficulty is swept
 * rather than fixed.
 */
const DIFFICULTIES = process.argv.includes('--difficulty')
  ? [arg('difficulty', 1)]
  : [0.8, 1.1, 1.4];

/** One period of ~10 Hz physiological tremor, as MHLHUB's decorrelation constant. */
const TREMOR_TAU_MS = 100;
const rho = SPACING_MS <= 0 ? 1 : Math.exp(-SPACING_MS / TREMOR_TAU_MS);
const ar1 = (prev: number, draw: number) => rho * prev + Math.sqrt(1 - rho * rho) * draw;

function rng(seed: number): () => number {
  let s = seed || 1;
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

interface Walk { rotate: number; blur: number; gain: number; bias: number }

/** Degrade the clean render as one frame of a hand-held session would be. */
async function renderFrame(clean: Buffer, walk: Walk, rand: () => number, hard: number): Promise<Buffer> {
  const spread = (lo: number, hi: number) => lo + rand() * (hi - lo);
  walk.rotate = ar1(walk.rotate, spread(-3, 3));
  walk.blur = ar1(walk.blur, spread(-0.8, 0.8));
  walk.gain = ar1(walk.gain, spread(-0.12, 0.12));
  walk.bias = ar1(walk.bias, spread(-35, 35));

  let img = sharp(clean).rotate(walk.rotate, { background: '#ffffff' }).greyscale();
  const blur = 0.7 + hard * 1.5 + walk.blur;
  if (blur > 0.35) img = img.blur(blur);
  // Crush contrast toward mid-grey and lose resolution, the two things that
  // actually kill a receipt in dim light.
  img = img.linear(Math.max(0.18, 0.72 - hard * 0.34) + walk.gain, 60 + hard * 30 + walk.bias);

  const meta = await sharp(clean).metadata();
  const width = Math.max(280, Math.round((meta.width ?? 900) * Math.max(0.35, 1 - hard * 0.42)));
  const { data, info } = await img.resize({ width }).raw().toBuffer({ resolveWithObject: true });
  return grayToPng(preprocess({ data: new Uint8ClampedArray(data), width: info.width, height: info.height }));
}

const FIELDS = ['subtotal', 'tax', 'tip', 'total'] as const;
const correct = (got: Record<string, Cents | null>, truth: Record<string, Cents>): boolean =>
  FIELDS.every((f) => got[f] === truth[f]);

async function main(): Promise<void> {
  const engine = new TesseractEngine();
  await engine.init();

  console.log(
    `\n${SESSIONS} sessions x ${SPECS.length} receipts x ${FRAMES} frames  ` +
      `(spacing ${SPACING_MS}ms, rho ${rho.toFixed(2)}${rho >= 0.99 ? ' — frozen pose' : ''})\n`,
  );
  console.log('  difficulty  policy               settled   correct   WRONG');
  console.log('  ' + '─'.repeat(58));

 for (const HARD of DIFFICULTIES) {
  const tally = {
    single: { ok: 0, wrong: 0 },
    streak: { ok: 0, wrong: 0 },
    combined: { ok: 0, wrong: 0 },
  };
  let sessions = 0;

  for (const spec of SPECS) {
    const { png, truth } = await renderClean(spec, 'session');
    const truthMap = { subtotal: truth.subtotal, tax: truth.tax, tip: truth.tip, total: truth.total };
    const row = { single: '', streak: '', combined: '' };

    for (let session = 0; session < SESSIONS; session++) {
      sessions++;
      const rand = rng(20260831 + session * 7919 + spec.id.length);
      const walk: Walk = { rotate: 0, blur: 0, gain: 0, bias: 0 };
      const consensus = new ReceiptConsensus();
      let singleDone = false;
      let streakDone = false;
      let combinedDone = false;

      for (let n = 1; n <= FRAMES; n++) {
        const { words } = await engine.recognize(await renderFrame(png, walk, rand, HARD));
        const parsed = parseReceipt(words);
        const alone = reconcile(parsed);

        // Single-frame policy: first frame that settles, wins.
        if (!singleDone && alone.status !== 'unresolved') {
          singleDone = true;
          if (correct(alone.values, truthMap)) tally.single.ok++; else tally.single.wrong++;
        }

        consensus.observe(parsed);
        const agreed = reconcile(consensus.asParsed(parsed));

        if (!streakDone && agreed.status !== 'unresolved') {
          streakDone = true;
          if (correct(agreed.values, truthMap)) tally.streak.ok++; else tally.streak.wrong++;
        }

        // A frame that reconciles on its own already carries the receipt's own
        // arithmetic; consensus is the fallback that fills what one pose lost.
        if (!combinedDone) {
          const winner = alone.status !== 'unresolved' ? alone : agreed;
          if (winner.status !== 'unresolved') {
            combinedDone = true;
            if (correct(winner.values, truthMap)) tally.combined.ok++; else tally.combined.wrong++;
          }
        }
      }
      row.single += singleDone ? '.' : 'x';
      row.streak += streakDone ? '.' : 'x';
      row.combined += combinedDone ? '.' : 'x';
    }
    void row;
  }

  for (const [name, t] of Object.entries(tally)) {
    const settled = t.ok + t.wrong;
    console.log(
      `  ${HARD.toFixed(1).padEnd(11)} ${name.padEnd(20)} ${String(settled).padStart(4)}/${sessions}   ` +
        `${String(t.ok).padStart(7)}   ${String(t.wrong).padStart(5)}`,
    );
  }
  console.log('  ' + '─'.repeat(58));
 }

  await engine.dispose();
  console.log('\n  Read the WRONG column first. Policies only differ where a single');
  console.log('  frame is marginal, so the middle difficulty is the informative row.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

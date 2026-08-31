/**
 * Synthetic receipt fixtures with exact ground truth.
 *
 * Real receipts are the test set — that is the lesson v1 wrote down and then
 * failed to act on. But real photos cannot be committed, are slow to collect,
 * and give you no ground truth you did not type by hand. So there are two sets:
 *
 *   synthetic/  generated here, exact ground truth, regenerated on demand,
 *               gitignored. Fast, repeatable, and the regression suite.
 *   real/       photographs of actual receipts, ground truth written by hand.
 *               The honest set. Thermal fade, folds and stains live here.
 *
 * Synthetic alone would be self-congratulatory: clean glyphs at a known angle
 * are the case OCR already wins. The degradation variants below exist to drag
 * the synthetic set toward the real one — reduced contrast for thermal fade, a
 * few degrees of skew for a photo taken by a human hand, blur for a phone that
 * focused on the tablecloth.
 */
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import sharp, { type Sharp } from 'sharp';
import type { Cents, ReceiptGroundTruth } from '../src/types';
import { formatCents } from '../src/types';

const OUT = join(import.meta.dirname, '..', 'fixtures', 'receipts', 'synthetic');

interface ReceiptSpec {
  id: string;
  merchant: string;
  address: string;
  items: { desc: string; price: Cents }[];
  taxRate: number;
  tipRate: number;
}

const SPECS: ReceiptSpec[] = [
  {
    id: 'diner',
    merchant: 'THE BLUE PLATE',
    address: '118 MAIN ST',
    items: [
      { desc: 'CHEESEBURGER', price: 1200 },
      { desc: 'PAD THAI', price: 1450 },
      { desc: 'DRAFT BEER', price: 700 },
      { desc: 'CALAMARI', price: 1100 },
    ],
    taxRate: 0.0825,
    tipRate: 0.2,
  },
  {
    id: 'sushi',
    merchant: 'KURO SUSHI BAR',
    address: '9 HARBOR WALK',
    items: [
      { desc: 'SALMON NIGIRI', price: 900 },
      { desc: 'SPICY TUNA ROLL', price: 1350 },
      { desc: 'EDAMAME', price: 650 },
      { desc: 'GYOZA', price: 875 },
      { desc: 'GREEN TEA', price: 400 },
      { desc: 'SAKE CARAFE', price: 1800 },
    ],
    taxRate: 0.07,
    tipRate: 0.18,
  },
  {
    id: 'taqueria',
    merchant: 'TAQUERIA EL SOL',
    address: '2214 CESAR CHAVEZ',
    items: [
      { desc: 'AL PASTOR TACO', price: 425 },
      { desc: 'CARNITAS TACO', price: 425 },
      { desc: 'CHIPS AND SALSA', price: 550 },
      { desc: 'HORCHATA', price: 375 },
    ],
    taxRate: 0.095,
    tipRate: 0.15,
  },
  {
    id: 'pizzeria',
    merchant: "GIANNI'S PIZZERIA",
    address: '77 FEDERAL HILL',
    items: [
      { desc: 'LARGE MARGHERITA', price: 2200 },
      { desc: 'GARLIC KNOTS', price: 800 },
      { desc: 'CAESAR SALAD', price: 1050 },
      { desc: 'SODA', price: 300 },
      { desc: 'SODA', price: 300 },
    ],
    taxRate: 0.07,
    tipRate: 0.2,
  },
  {
    id: 'brunch',
    merchant: 'MORNING GLORY CAFE',
    address: '410 ELM STREET',
    items: [
      { desc: 'AVOCADO TOAST', price: 1400 },
      { desc: 'HUEVOS RANCHEROS', price: 1650 },
      { desc: 'COLD BREW', price: 550 },
      { desc: 'MIMOSA', price: 1200 },
      { desc: 'SIDE BACON', price: 600 },
    ],
    taxRate: 0.0625,
    tipRate: 0.22,
  },
];

/**
 * Degradations, roughly ordered by how much they hurt.
 *
 * The first four are gentle and the parser clears them easily; they are kept
 * because `taqueria-faded` is a pinned regression case. The last four try to be
 * an actual photograph: a hand-held phone under restaurant lighting, paper that
 * has been folded into a pocket, a lens that focused on the tablecloth.
 *
 * Synthetic degradation is still a model of reality rather than reality. It gets
 * the optics roughly right — defocus, shear, falloff, sensor noise, JPEG — and
 * cannot reproduce a coffee ring or the way thermal print dies unevenly. Real
 * photographs in ../real/ remain the honest gate.
 */
type Degrade = (img: Sharp, w: number, h: number) => Sharp;

/**
 * Rasterise an overlay to exactly w x h.
 *
 * librsvg rounds an SVG's canvas, so an overlay declared at the page size can
 * come out a pixel larger — and sharp refuses to composite an input bigger than
 * its target. Forcing the size here is the difference between a working
 * pipeline and an error that surfaces on an unrelated line, because composites
 * are lazy and only fail when the chain is finally drained.
 */
const exact = (svg: Buffer, w: number, h: number): Promise<Buffer> =>
  sharp(svg).resize(w, h, { fit: 'fill' }).png().toBuffer();

/** Uneven illumination: a bright spot with falloff, multiplied over the page. */
const lighting = (w: number, h: number, strength: number, cx = 0.35, cy = 0.25): Buffer =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
      <defs><radialGradient id="g" cx="${cx * 100}%" cy="${cy * 100}%" r="95%">
        <stop offset="0%" stop-color="#fff"/>
        <stop offset="100%" stop-color="rgb(${Math.round(255 - strength)},${Math.round(255 - strength)},${Math.round(255 - strength)})"/>
      </radialGradient></defs>
      <rect width="100%" height="100%" fill="url(#g)"/>
    </svg>`,
  );

/** Soft dark bands where the paper was folded, plus the crease highlight. */
const folds = (w: number, h: number, at: number[]): Buffer =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
      <defs>${at
        .map(
          (y, i) => `<linearGradient id="f${i}" x1="0" y1="${Math.max(0, y - 0.05) * 100}%" x2="0" y2="${Math.min(1, y + 0.05) * 100}%">
            <stop offset="0%" stop-color="#fff"/>
            <stop offset="45%" stop-color="#b8b8b8"/>
            <stop offset="55%" stop-color="#f4f4f4"/>
            <stop offset="100%" stop-color="#fff"/>
          </linearGradient>`,
        )
        .join('')}</defs>
      <rect width="100%" height="100%" fill="#fff"/>
      ${at.map((_, i) => `<rect width="100%" height="100%" fill="url(#f${i})" opacity="0.85"/>`).join('')}
    </svg>`,
  );

/** Gaussian sensor noise, screened over the page. */
const grain = (w: number, h: number, sigma: number) =>
  sharp({ create: { width: w, height: h, channels: 3, background: '#808080', noise: { type: 'gaussian', mean: 128, sigma } } })
    .png()
    .toBuffer();

/**
 * A variant is split in two because rotation changes the canvas size: overlays
 * have to be built against the geometry's OUTPUT dimensions, not the input's.
 */
interface Variant {
  name: string;
  /** Rotation / shear. Changes the image's dimensions. */
  geometry?: (img: Sharp) => Sharp;
  /** Lighting, folds, levels. Sized to the post-geometry canvas. */
  surface?: (img: Sharp, w: number, h: number) => Promise<Sharp>;
  /** What the camera itself adds on the way out. */
  capture?: { sigma: number; quality: number; scale: number };
}

const VARIANTS: Variant[] = [
  { name: 'clean' },
  // Thermal paper that has been in a wallet: blacks lift toward grey.
  { name: 'faded', surface: async (s) => s.linear(0.45, 110) },
  // Photographed by a human, not a scanner.
  { name: 'skewed', geometry: (s) => s.rotate(2.4, { background: '#ffffff' }) },
  { name: 'worn', surface: async (s) => s.linear(0.55, 95).blur(1.1) },

  // --- the ones that are meant to be hard ---

  // A normal phone snap: off-axis, uneven light, a little grain.
  {
    name: 'handheld',
    geometry: (s) => s.rotate(-3.1, { background: '#ffffff' }).affine([1, 0.045, 0.02, 1], { background: '#ffffff' }),
    surface: async (s, w, h) =>
      s.composite([{ input: await exact(lighting(w, h, 70), w, h), blend: 'multiply' }]).linear(0.9, 12),
    capture: { sigma: 7, quality: 82, scale: 1 },
  },
  // Folded into a pocket, then flattened badly on the table.
  {
    name: 'folded',
    geometry: (s) => s.rotate(1.8, { background: '#ffffff' }),
    surface: async (s, w, h) =>
      s
        .composite([
          { input: await exact(folds(w, h, [0.34, 0.66]), w, h), blend: 'multiply' },
          { input: await exact(lighting(w, h, 55, 0.6, 0.2), w, h), blend: 'multiply' },
        ])
        .linear(0.7, 70),
    capture: { sigma: 9, quality: 74, scale: 0.85 },
  },
  // Dim restaurant light: heavy falloff, real grain, lossy capture.
  {
    name: 'dim',
    geometry: (s) => s.rotate(-1.4, { background: '#ffffff' }),
    surface: async (s, w, h) =>
      s.composite([{ input: await exact(lighting(w, h, 135, 0.4, 0.15), w, h), blend: 'multiply' }]).linear(0.5, 90),
    capture: { sigma: 16, quality: 62, scale: 0.8 },
  },
  // The lens focused on the tablecloth. Soft, small, and JPEG-mangled.
  {
    name: 'defocused',
    geometry: (s) => s.rotate(2.0, { background: '#ffffff' }).affine([1, 0.03, 0.015, 1], { background: '#ffffff' }),
    surface: async (s, w, h) =>
      s.composite([{ input: await exact(lighting(w, h, 90, 0.5, 0.3), w, h), blend: 'multiply' }]).blur(2.6).linear(0.65, 80),
    capture: { sigma: 12, quality: 48, scale: 0.55 },
  },
];

const WIDTH = 620;
const LINE = 30;
const LEFT = 45;
const RIGHT = 575;

function buildReceipt(spec: ReceiptSpec, gt: ReceiptGroundTruth): { svg: string; text: string } {
  const rows: string[] = [];
  const lines: string[] = [];
  let y = 60;
  const text = (content: string, x: number, anchor: 'start' | 'middle' | 'end', size = 21, weight = 'normal') =>
    `<text x="${x}" y="${y}" font-family="Menlo, DejaVu Sans Mono, Courier New, monospace" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" fill="#111">${escapeXml(content)}</text>`;

  rows.push(text(spec.merchant, WIDTH / 2, 'middle', 24, 'bold'));
  lines.push(spec.merchant);
  y += LINE;
  rows.push(text(spec.address, WIDTH / 2, 'middle', 18));
  lines.push(spec.address);
  y += LINE;
  rows.push(text('-'.repeat(34), WIDTH / 2, 'middle', 18));
  y += LINE;

  // Item rows: description left, price right-aligned. The right-alignment is
  // the whole point — the parser finds prices by x-position, not by regex.
  for (const item of spec.items) {
    rows.push(text(item.desc, LEFT, 'start'));
    rows.push(text(formatCents(item.price), RIGHT, 'end'));
    lines.push(`${item.desc} ${formatCents(item.price)}`);
    y += LINE;
  }

  rows.push(text('-'.repeat(34), WIDTH / 2, 'middle', 18));
  y += LINE;

  for (const [label, value] of [
    ['SUBTOTAL', gt.subtotal],
    ['TAX', gt.tax],
    ['TIP', gt.tip],
  ] as const) {
    rows.push(text(label, LEFT, 'start'));
    rows.push(text(formatCents(value), RIGHT, 'end'));
    lines.push(`${label} ${formatCents(value)}`);
    y += LINE;
  }

  rows.push(text('TOTAL', LEFT, 'start', 23, 'bold'));
  rows.push(text(formatCents(gt.total), RIGHT, 'end', 23, 'bold'));
  lines.push(`TOTAL ${formatCents(gt.total)}`);
  y += LINE + 10;
  rows.push(text('THANK YOU', WIDTH / 2, 'middle', 18));
  lines.push('THANK YOU');
  y += LINE;

  const height = y + 30;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}"><rect width="100%" height="100%" fill="#fff"/>${rows.join('')}</svg>`;
  return { svg, text: lines.join(' ') };
}

const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&apos;');

function groundTruth(spec: ReceiptSpec, variant: string): ReceiptGroundTruth {
  const subtotal = spec.items.reduce((sum, i) => sum + i.price, 0);
  const tax = Math.round(subtotal * spec.taxRate);
  const tip = Math.round(subtotal * spec.tipRate);
  return {
    id: `${spec.id}-${variant}`,
    merchant: spec.merchant,
    items: spec.items,
    subtotal,
    tax,
    tip,
    total: subtotal + tax + tip,
    variant,
    fullText: '',
  };
}

async function main(): Promise<void> {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  let count = 0;
  for (const spec of SPECS) {
    for (const variant of VARIANTS) {
      const gt = groundTruth(spec, variant.name);
      const { svg, text } = buildReceipt(spec, gt);
      gt.fullText = text;

      // Render at 2x then downsample: closer to a phone photo than rendering
      // small, and it stops the degradations from acting on crisp vector edges.
      let buf = await sharp(Buffer.from(svg), { density: 144 }).resize({ width: 900 }).png().toBuffer();

      if (variant.geometry) buf = await variant.geometry(sharp(buf)).png().toBuffer();

      const meta = await sharp(buf).metadata();
      const w = meta.width ?? 900;
      const h = meta.height ?? 900;

      let img = variant.surface ? await variant.surface(sharp(buf), w, h) : sharp(buf);
      img = img.greyscale();

      // Everything a phone adds on the way out: grain, a lossy encode, and the
      // fact that nobody's crop is full resolution.
      if (variant.capture) {
        // Two passes, deliberately. sharp applies its operations in a fixed
        // order — resize runs BEFORE composite no matter how they are chained —
        // so doing both in one pass shrinks the page first and then rejects the
        // full-size grain as "larger than the target". Drain the composite,
        // then resize.
        const grained = await sharp(await img.png().toBuffer())
          .composite([{ input: await grain(w, h, variant.capture.sigma), blend: 'overlay' }])
          .png()
          .toBuffer();

        buf = await sharp(grained)
          .resize({ width: Math.max(200, Math.round(w * variant.capture.scale)) })
          .jpeg({ quality: variant.capture.quality })
          .toBuffer();
        img = sharp(buf);
      }

      await img.png().toFile(join(OUT, `${gt.id}.png`));
      await writeFile(join(OUT, `${gt.id}.json`), JSON.stringify(gt, null, 2));
      count++;
    }
  }
  console.log(`Wrote ${count} synthetic fixtures to ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

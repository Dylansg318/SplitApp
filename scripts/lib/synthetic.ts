/**
 * The synthetic receipts, and how one is drawn.
 *
 * Shared by make-fixtures (which writes a degraded PNG per variant) and
 * session-bench (which renders many independently-degraded frames of the SAME
 * receipt). Both need the clean render and the exact ground truth; only the
 * degradation differs.
 */
import sharp from 'sharp';
import type { Cents, ReceiptGroundTruth } from '../../src/types';
import { formatCents } from '../../src/types';

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


/** Clean render, before anything is done to it. */
export async function renderClean(spec: ReceiptSpec, variant: string): Promise<{ png: Buffer; truth: ReceiptGroundTruth }> {
  const truth = groundTruth(spec, variant);
  const { svg, text } = buildReceipt(spec, truth);
  truth.fullText = text;
  const png = await sharp(Buffer.from(svg), { density: 144 }).resize({ width: 900 }).png().toBuffer();
  return { png, truth };
}

export type { ReceiptSpec };
export { SPECS, buildReceipt, groundTruth };

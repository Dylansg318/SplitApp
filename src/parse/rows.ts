import type { Word, BBox } from '../types';

/**
 * Turn a bag of located words into rows.
 *
 * v1 asked a model to read flattened OCR text. That threw away the only
 * structure a receipt reliably has: it is two columns, description on the left
 * and price right-aligned, and the alignment survives fading, creasing and skew
 * far better than any character does. Working in geometry rather than in text is
 * what makes the parser deterministic (invariant 6) — there is no pattern to
 * match ambiguously, only boxes to compare.
 */
export interface Row {
  words: Word[];
  /** Vertical centre on the real image, for pointing the UI at a line. */
  y: number;
  /** De-skewed vertical position; what grouping and ordering actually use. */
  flatY: number;
  bbox: BBox;
  text: string;
}

const centreY = (w: Word) => (w.bbox.y0 + w.bbox.y1) / 2;
const centreX = (w: Word) => (w.bbox.x0 + w.bbox.x1) / 2;
const height = (w: Word) => w.bbox.y1 - w.bbox.y0;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Estimate the slope of the text baselines (dy/dx).
 *
 * Nobody photographs a receipt square. A couple of degrees of rotation moves the
 * right-hand end of a line tens of pixels away from its left-hand end, which is
 * more than a line height — so grouping on raw vertical position shreds every
 * row into fragments. Measured on the fixtures, 2.4 degrees of skew was enough
 * to break every one of them while OCR itself read them perfectly.
 *
 * The slope is taken as the median over adjacent word pairs rather than a fit
 * across the whole page: a median ignores the outliers created by column gaps
 * and stray marks, where a least-squares fit would chase them.
 */
function estimateSlope(words: Word[], lineHeight: number): number {
  const byX = [...words].sort((a, b) => a.bbox.x0 - b.bbox.x0);
  const slopes: number[] = [];

  for (const word of words) {
    let nearest: Word | null = null;
    let nearestGap = Infinity;
    for (const other of byX) {
      if (other === word) continue;
      const gap = other.bbox.x0 - word.bbox.x1;
      // Only true neighbours: skipping the wide gap to the price column keeps
      // the column's alignment from being mistaken for a baseline.
      if (gap < 0 || gap > lineHeight * 3) continue;
      if (Math.abs(centreY(other) - centreY(word)) > lineHeight * 1.5) continue;
      if (gap < nearestGap) {
        nearestGap = gap;
        nearest = other;
      }
    }
    if (!nearest) continue;
    const dx = centreX(nearest) - centreX(word);
    if (Math.abs(dx) < 1) continue;
    slopes.push((centreY(nearest) - centreY(word)) / dx);
  }

  const slope = slopes.length ? median(slopes) : 0;
  // Beyond ~17 degrees the estimate is more likely noise than skew, and the
  // capture step should be asking for a better photo rather than compensating.
  return Math.abs(slope) > 0.3 ? 0 : slope;
}

/**
 * Group words into rows, compensating for page skew.
 *
 * Grouping happens on a de-skewed vertical coordinate, y - slope*x, so a line
 * that drifts downward across the page still reads as one row. The tolerance is
 * derived from the median glyph height rather than fixed in pixels, so the same
 * code works on a 900px crop and a 4000px photo.
 */
export function clusterRows(words: Word[], tolerance = 0.6): Row[] {
  if (words.length === 0) return [];

  const lineHeight = median(words.map(height)) || 1;
  const maxGap = lineHeight * tolerance;
  const slope = estimateSlope(words, lineHeight);
  /** Vertical position with the page's rotation taken out. */
  const flatY = (w: Word) => centreY(w) - slope * centreX(w);

  const sorted = [...words].sort((a, b) => flatY(a) - flatY(b));
  const groups: Word[][] = [];
  let current: Word[] = [];
  let runningCentre = 0;

  for (const word of sorted) {
    if (current.length === 0 || Math.abs(flatY(word) - runningCentre) <= maxGap) {
      current.push(word);
      runningCentre = current.reduce((s, w) => s + flatY(w), 0) / current.length;
    } else {
      groups.push(current);
      current = [word];
      runningCentre = flatY(word);
    }
  }
  if (current.length) groups.push(current);

  return groups
    .map((group) => {
      const ordered = [...group].sort((a, b) => a.bbox.x0 - b.bbox.x0);
      return {
        words: ordered,
        // Ordering uses the de-skewed coordinate; the reported y stays the real
        // one so the UI can point at the right place on the actual image.
        y: ordered.reduce((s, w) => s + centreY(w), 0) / ordered.length,
        flatY: ordered.reduce((s, w) => s + flatY(w), 0) / ordered.length,
        bbox: {
          x0: Math.min(...ordered.map((w) => w.bbox.x0)),
          y0: Math.min(...ordered.map((w) => w.bbox.y0)),
          x1: Math.max(...ordered.map((w) => w.bbox.x1)),
          y1: Math.max(...ordered.map((w) => w.bbox.y1)),
        },
        text: ordered.map((w) => w.text).join(' '),
      };
    })
    .sort((a, b) => a.flatY - b.flatY);
}

/**
 * Image preparation for OCR — the highest-leverage code in the project.
 *
 * Measured over the hard fixtures, total-field recall went 33% raw -> 85% with
 * the pipeline below. Nothing else available comes close for the effort.
 *
 * Two findings shaped this. A global contrast stretch does NOTHING (33% -> 32%)
 * because the problem is a lighting *gradient* — one side of a photographed
 * receipt is simply darker than the other, and a global mapping cannot see
 * that. Adaptive equalisation, which computes a separate mapping per tile, is
 * exactly the tool for it. And upscaling actively hurts (85% -> 50%): it
 * invents no detail while giving Tesseract more soft edges to misread.
 *
 * Written against raw grayscale pixels rather than a library because it has to
 * run in the browser, where sharp does not exist. OpenCV.js would do it, but
 * pulling megabytes of WASM for two operations is a poor trade when the whole
 * bundle sits behind a click.
 */

export interface Gray {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Rec. 601 luma. Matches what sharp's greyscale does closely enough to compare. */
export function toGray(rgba: Uint8ClampedArray, width: number, height: number): Gray {
  const out = new Uint8ClampedArray(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = (rgba[p]! * 299 + rgba[p + 1]! * 587 + rgba[p + 2]! * 114) / 1000;
  }
  return { data: out, width, height };
}

export interface ClaheOptions {
  /** Tile edge in pixels. Matches sharp's clahe({width,height}). */
  tile?: number;
  /**
   * Histogram ceiling as a multiple of the flat average. Without it, a tile of
   * near-uniform paper amplifies its own sensor noise into visible texture,
   * which costs more than the contrast gains.
   */
  clipLimit?: number;
}

/**
 * Contrast Limited Adaptive Histogram Equalisation.
 *
 * Equalise each tile independently, then bilinearly blend between neighbouring
 * tile mappings so no tile boundary shows. The blend is not cosmetic: without
 * it, tile edges become hard steps that OCR reads as strokes.
 */
export function clahe(img: Gray, { tile = 64, clipLimit = 3 }: ClaheOptions = {}): Gray {
  const { data, width, height } = img;
  const tilesX = Math.max(1, Math.round(width / tile));
  const tilesY = Math.max(1, Math.round(height / tile));
  const tileW = width / tilesX;
  const tileH = height / tilesY;

  // One 256-entry mapping per tile.
  const maps: Uint8Array[] = [];
  const hist = new Uint32Array(256);

  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      hist.fill(0);
      const x0 = Math.floor(tx * tileW);
      const x1 = Math.min(width, Math.floor((tx + 1) * tileW));
      const y0 = Math.floor(ty * tileH);
      const y1 = Math.min(height, Math.floor((ty + 1) * tileH));

      let count = 0;
      for (let y = y0; y < y1; y++) {
        const row = y * width;
        for (let x = x0; x < x1; x++) {
          hist[data[row + x]!]! ++;
          count++;
        }
      }
      if (count === 0) {
        maps.push(new Uint8Array(256).map((_, i) => i));
        continue;
      }

      // Clip, then hand the clipped mass back out evenly. Redistribution can
      // push bins back over the limit; one pass is the standard compromise and
      // the residual is not visible.
      const limit = Math.max(1, Math.floor((clipLimit * count) / 256));
      let excess = 0;
      for (let i = 0; i < 256; i++) {
        if (hist[i]! > limit) {
          excess += hist[i]! - limit;
          hist[i] = limit;
        }
      }
      const share = Math.floor(excess / 256);
      let remainder = excess - share * 256;
      for (let i = 0; i < 256; i++) {
        hist[i] = hist[i]! + share + (remainder-- > 0 ? 1 : 0);
      }

      const map = new Uint8Array(256);
      let cumulative = 0;
      for (let i = 0; i < 256; i++) {
        cumulative += hist[i]!;
        map[i] = Math.round((cumulative / count) * 255);
      }
      maps.push(map);
    }
  }

  const out = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y++) {
    // Position relative to tile CENTRES, which is what makes the interpolation
    // symmetric; using tile corners shifts the whole image by half a tile.
    const fy = y / tileH - 0.5;
    const ty0 = Math.min(tilesY - 1, Math.max(0, Math.floor(fy)));
    const ty1 = Math.min(tilesY - 1, ty0 + 1);
    const wy = Math.min(1, Math.max(0, fy - ty0));

    for (let x = 0; x < width; x++) {
      const fx = x / tileW - 0.5;
      const tx0 = Math.min(tilesX - 1, Math.max(0, Math.floor(fx)));
      const tx1 = Math.min(tilesX - 1, tx0 + 1);
      const wx = Math.min(1, Math.max(0, fx - tx0));

      const v = data[y * width + x]!;
      const a = maps[ty0 * tilesX + tx0]![v]!;
      const b = maps[ty0 * tilesX + tx1]![v]!;
      const c = maps[ty1 * tilesX + tx0]![v]!;
      const d = maps[ty1 * tilesX + tx1]![v]!;

      out[y * width + x] =
        a * (1 - wx) * (1 - wy) + b * wx * (1 - wy) + c * (1 - wx) * wy + d * wx * wy;
    }
  }

  return { data: out, width, height };
}

/** Separable gaussian kernel, radius 3 sigma. */
function gaussianKernel(sigma: number): Float32Array {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(radius * 2 + 1);
  const denom = 2 * sigma * sigma;
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / denom);
    kernel[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] = kernel[i]! / sum;
  return kernel;
}

/** Gaussian blur, separated into two 1D passes. Edges clamp rather than wrap. */
function blur(img: Gray, sigma: number): Gray {
  const { data, width, height } = img;
  const kernel = gaussianKernel(sigma);
  const radius = (kernel.length - 1) / 2;
  const pass = new Float32Array(width * height);
  const out = new Uint8ClampedArray(width * height);

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const sx = Math.min(width - 1, Math.max(0, x + k));
        acc += data[row + sx]! * kernel[k + radius]!;
      }
      pass[row + x] = acc;
    }
  }
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const sy = Math.min(height - 1, Math.max(0, y + k));
        acc += pass[sy * width + x]! * kernel[k + radius]!;
      }
      out[y * width + x] = acc;
    }
  }
  return { data: out, width, height };
}

/**
 * Width the sharpen radius was tuned against. A blur radius is only meaningful
 * relative to stroke width, and a phone photograph is four times this wide, so
 * a fixed sigma barely touches its strokes. Scaling with the image is what made
 * a real 4032px receipt parse its subtotal, tax and tip correctly.
 */
const REFERENCE_WIDTH = 900;
const REFERENCE_SIGMA = 1.5;

/**
 * Scales UP with image width and never below the tuned baseline.
 *
 * Letting it scale down as well cost the synthetic set two receipts (32/40 ->
 * 30/40): those fixtures sit at or below the reference width, so scaling only
 * ever weakened them. The measured problem is the opposite one — a 4032px
 * photograph whose strokes are four times wider than anything this was tuned
 * against, where a fixed 1.5 barely touches them.
 */
export const sigmaFor = (width: number): number =>
  Math.min(6, Math.max(REFERENCE_SIGMA, (width / REFERENCE_WIDTH) * REFERENCE_SIGMA));

export interface SharpenOptions {
  /** Omit to scale with image width, which is almost always what you want. */
  sigma?: number;
  /** Slope applied below the threshold — gentle, so paper grain stays quiet. */
  flatSlope?: number;
  /** Slope applied to the part of the difference ABOVE the threshold. */
  edgeSlope?: number;
  /** Difference, in 0-255 levels, above which a pixel reads as an edge. */
  threshold?: number;
  /** Caps on how far one pixel may be pushed, in 0-255 levels. */
  maxBrighten?: number;
  maxDarken?: number;
}

/**
 * Thresholded unsharp mask, as a continuous piecewise-linear response.
 *
 * A plain unsharp mask measured WORSE than nothing once CLAHE was in front of
 * it (62% alone, 50% with naive sharpening): adaptive equalisation necessarily
 * amplifies grain in flat regions, and a plain unsharp amplifies that grain a
 * second time until Tesseract reads texture as strokes.
 *
 * Two details matter, and getting either wrong costs most of the benefit.
 *
 * CONTINUITY. The gentle and steep slopes must meet at the threshold, with the
 * steep slope applied only to the EXCESS above it. Switching multiplier on the
 * whole difference puts a step in the response curve, and a step in a sharpening
 * operator is itself an edge — it manufactures exactly the artefacts the
 * threshold exists to avoid.
 *
 * SCALE. libvips does this in LAB, where L runs 0-100, so its documented caps of
 * 10 and 20 are ~25 and ~51 levels once expressed on a 0-255 channel. Reading
 * them as raw levels clamps roughly twice as hard as intended and throws away
 * most of the sharpening.
 */
export function unsharp(img: Gray, options: SharpenOptions = {}): Gray {
  const {
    sigma = sigmaFor(img.width),
    flatSlope = 1,
    // 1.5 rather than libvips' 2.0. Swept end-to-end over all 40 fixtures by
    // receipts actually settled, not by character recall: 1.5 settles 33,
    // 2.0 and 2.5 settle 32, and no setting ever produced a wrong answer.
    // Stronger sharpening buys nothing on hard images and costs a line item
    // here and there on decent ones.
    edgeSlope = 1.5,
    // The libvips defaults (x1=2, y2=10, y3=20), converted from L's 0-100 range.
    threshold = (2 / 100) * 255,
    maxBrighten = (10 / 100) * 255,
    maxDarken = (20 / 100) * 255,
  } = options;

  const blurred = blur(img, sigma);
  const out = new Uint8ClampedArray(img.data.length);

  for (let i = 0; i < out.length; i++) {
    const original = img.data[i]!;
    const difference = original - blurred.data[i]!;
    const magnitude = Math.abs(difference);

    // Gentle up to the threshold, then steep on the excess only — continuous.
    let response =
      magnitude <= threshold
        ? magnitude * flatSlope
        : threshold * flatSlope + (magnitude - threshold) * edgeSlope;

    if (response > maxBrighten && difference > 0) response = maxBrighten;
    if (response > maxDarken && difference < 0) response = maxDarken;

    out[i] = original + Math.sign(difference) * response;
  }

  return { data: out, width: img.width, height: img.height };
}

export interface PreprocessOptions {
  /** Off by default — measured worse in combination. See preprocess(). */
  clahe?: ClaheOptions | false;
  sharpen?: SharpenOptions | false;
}

/**
 * The pipeline, as the measurements left it: sharpen only.
 *
 * CLAHE is implemented, tested and exported, and it is NOT in the default path.
 * Total-field recall over the hard fixtures:
 *
 *   raw                                33%
 *   CLAHE alone                        62%
 *   sharpen alone                      85%   <- shipped
 *   CLAHE + sharpen, clip 3 / tile 64  53%
 *   CLAHE + sharpen, clip 1 / tile 128 63%   <- gentlest of eight swept
 *
 * Sharpening alone beat every CLAHE combination at every clip limit and tile
 * size tried. Equalisation and sharpening both amplify grain, and stacking them
 * amplifies it twice; the second pass costs more in false strokes than the
 * first gains in contrast.
 *
 * CLAHE is kept rather than deleted for one specific reason: this was measured
 * against SYNTHETIC gaussian grain, and real photographs carry different noise
 * and genuinely non-uniform illumination. It is a pending experiment against
 * fixtures/receipts/real/, not speculative code — and if that experiment does
 * not happen, it should be deleted.
 *
 * Deliberately does NOT resize: upscaling measured 85% -> 50%.
 */
export function preprocess(img: Gray, options: PreprocessOptions = {}): Gray {
  const { clahe: claheOpts = false, sharpen = {} } = options;
  let out = img;
  if (claheOpts !== false) out = clahe(out, claheOpts);
  if (sharpen !== false) out = unsharp(out, sharpen);
  return out;
}

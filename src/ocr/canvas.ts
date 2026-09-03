import type { Gray } from './preprocess';
import { toGray } from './preprocess';

/**
 * Browser glue between an image source and the pure pixel code.
 *
 * Kept apart from preprocess.ts so the maths stays environment-free and can be
 * exercised in Node by the bake-off. Nothing here runs under Node; nothing in
 * preprocess.ts touches a DOM API.
 */

type Source = HTMLImageElement | HTMLVideoElement | HTMLCanvasElement | ImageBitmap;

const sizeOf = (source: Source): { width: number; height: number } =>
  source instanceof HTMLVideoElement
    ? { width: source.videoWidth, height: source.videoHeight }
    : { width: source.width, height: source.height };

/**
 * Draw a frame and hand back its luma plane.
 *
 * `maxEdge` caps the long side. Preprocessing deliberately never UPSCALES
 * (measured 85% -> 50%), but a phone camera-app photo is 4000+ px wide and a
 * 12-megapixel OCR pass takes tens of seconds on a phone; MHLHUB caps its
 * still-photo path at 3000 px for the same reason. Scaling DOWN mildly keeps
 * the stroke widths the sharpen was tuned against, since the sigma tracks
 * image width.
 */
export function sourceToGray(source: Source, { maxEdge }: { maxEdge?: number } = {}): Gray {
  const natural = sizeOf(source);
  if (natural.width === 0 || natural.height === 0) throw new Error('sourceToGray: source has no dimensions yet');
  const scale = maxEdge ? Math.min(1, maxEdge / Math.max(natural.width, natural.height)) : 1;
  const width = Math.max(1, Math.round(natural.width * scale));
  const height = Math.max(1, Math.round(natural.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('sourceToGray: 2D context unavailable');

  context.drawImage(source, 0, 0, width, height);
  return toGray(context.getImageData(0, 0, width, height).data, width, height);
}

/** Back to a canvas, which is one of the inputs tesseract.js accepts directly. */
export function grayToCanvas(img: Gray): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('grayToCanvas: 2D context unavailable');

  const rgba = context.createImageData(img.width, img.height);
  for (let i = 0, p = 0; i < img.data.length; i++, p += 4) {
    const v = img.data[i]!;
    rgba.data[p] = v;
    rgba.data[p + 1] = v;
    rgba.data[p + 2] = v;
    rgba.data[p + 3] = 255;
  }
  context.putImageData(rgba, 0, 0);
  return canvas;
}

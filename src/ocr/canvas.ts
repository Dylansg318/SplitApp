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

/** Draw a frame and hand back its luma plane. */
export function sourceToGray(source: Source): Gray {
  const { width, height } = sizeOf(source);
  if (width === 0 || height === 0) throw new Error('sourceToGray: source has no dimensions yet');

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

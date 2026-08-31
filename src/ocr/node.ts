import sharp from 'sharp';
import type { Gray } from './preprocess';
import { preprocess, type PreprocessOptions } from './preprocess';

/**
 * Node-side glue, mirroring canvas.ts. Used by the bake-off and the tests so
 * they exercise the SAME pixel code that ships to the browser — a preprocessing
 * result measured with sharp's operators would not transfer to a phone.
 *
 * Only scripts and tests import this. Nothing the app bundles reaches sharp.
 */

export async function readGray(path: string | Buffer): Promise<Gray> {
  const { data, info } = await sharp(path).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data), width: info.width, height: info.height };
}

export const grayToPng = (img: Gray): Promise<Buffer> =>
  sharp(Buffer.from(img.data), { raw: { width: img.width, height: img.height, channels: 1 } })
    // Leptonica warns and substitutes a default when the density is missing.
    .withMetadata({ density: 144 })
    .png()
    .toBuffer();

/** Read, prepare, and encode — what the bake-off hands to the engine. */
export async function preparePng(path: string, options?: PreprocessOptions): Promise<Buffer> {
  return grayToPng(preprocess(await readGray(path), options));
}

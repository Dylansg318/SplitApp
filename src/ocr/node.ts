import sharp from 'sharp';
import type { Gray } from './preprocess';
import { preprocess, type PreprocessOptions } from './preprocess';

/**
 * Node-side glue, mirroring canvas.ts. Used by the bake-off and the tests so
 * they exercise the SAME pixel code that ships to the browser — a preprocessing
 * result measured with sharp's operators would not transfer to a phone. Both
 * sides then hand the engine the same luma plane, encoded the same way.
 *
 * Only scripts and tests import this. Nothing the app bundles reaches sharp.
 */

export async function readGray(path: string | Buffer): Promise<Gray> {
  const { data, info } = await sharp(path).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data), width: info.width, height: info.height };
}

/** Read and prepare — what the bake-off hands to the engine. */
export async function prepare(path: string, options?: PreprocessOptions): Promise<Gray> {
  return preprocess(await readGray(path), options);
}

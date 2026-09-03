/**
 * Stage the OCR engine beside the app so the built site serves it itself.
 *
 * tesseract.js fetches its worker, its WASM core and its language data from
 * CDNs by default. The app must not (invariant 1: nothing leaves the device;
 * and a demo must not go dark because jsdelivr did). This copies exactly what
 * the browser worker will ask for into public/tesseract/, which Vite ships
 * verbatim in dist/:
 *
 *   worker.min.js                          the worker script
 *   tesseract-core-*-lstm.wasm.js          all three LSTM cores — the worker
 *                                          picks relaxed-SIMD, SIMD or plain
 *                                          at runtime by feature detection,
 *                                          so a missing variant is a broken
 *                                          phone, not a fallback. Each .wasm.js
 *                                          EMBEDS its binary (measured: the
 *                                          bare .wasm beside it is never
 *                                          fetched), so only the .js ships.
 *   eng.traineddata.gz                     language data (gzip, ~3MB)
 *
 * Runs before `dev` and `build`. Output is gitignored; the sizes are why.
 */
import { copyFile, mkdir, readdir, readFile, writeFile, access } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const out = join(root, 'public', 'tesseract');
const LANG_URL = 'https://tessdata.projectnaptha.com/4.0.0/eng.traineddata.gz';

const exists = (p: string) => access(p).then(() => true, () => false);

async function main(): Promise<void> {
  await mkdir(out, { recursive: true });

  await copyFile(join(root, 'node_modules/tesseract.js/dist/worker.min.js'), join(out, 'worker.min.js'));

  const coreDir = join(root, 'node_modules/tesseract.js-core');
  const cores = (await readdir(coreDir)).filter((f) => /-lstm\.wasm\.js$/.test(f));
  for (const f of cores) await copyFile(join(coreDir, f), join(out, f));

  const langOut = join(out, 'eng.traineddata.gz');
  if (!(await exists(langOut))) {
    // The Node bake-off has usually already cached the uncompressed file at
    // the repo root; reuse it rather than downloading 5MB again.
    const cached = join(root, 'eng.traineddata');
    if (await exists(cached)) {
      await writeFile(langOut, gzipSync(await readFile(cached)));
    } else {
      const res = await fetch(LANG_URL);
      if (!res.ok) throw new Error(`fetch ${LANG_URL}: ${res.status}`);
      await writeFile(langOut, Buffer.from(await res.arrayBuffer()));
    }
  }

  const listing = await readdir(out);
  console.log(`public/tesseract/: ${listing.length} files (${cores.length} core files)`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

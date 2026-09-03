import { createWorker, type Worker } from 'tesseract.js';
import type { OcrEngine, ImageLike } from './engine';
import type { OcrResult, Word } from '../types';

/**
 * Tesseract.js v7 behind the OcrEngine seam.
 *
 * The one non-obvious thing: since v6 every output format except `text` is
 * disabled by default, so `recognize(img)` returns a string and NO geometry.
 * The whole parsing strategy depends on word boxes — receipts are two columns,
 * description left, price right-aligned, and we find prices by x-position
 * rather than by pattern-matching flattened text (which is what v1 did, and why
 * a newline in the OCR output was enough to break it). Hence the explicit
 * `{ blocks: true }` third argument; drop it and the parser silently gets
 * nothing to work with.
 */
/**
 * Where the worker script, the WASM core and the language data live.
 *
 * tesseract.js defaults every one of these to a CDN (jsdelivr for code,
 * projectnaptha for language data). The Node bake-off is happy with that. The
 * app is not: invariant 1 is "nothing leaves the device", and a demo that goes
 * dark when a third party does is not a demo. The app passes its own origin —
 * see `scripts/vendor-tesseract.ts`, which stages the files under public/.
 *
 * Absolute URLs, deliberately. The worker is spawned from a blob URL, so a
 * relative `corePath` would resolve against the blob and 404.
 */
export interface TesseractPaths {
  workerPath?: string;
  corePath?: string;
  langPath?: string;
}

export class TesseractEngine implements OcrEngine {
  readonly name = 'tesseract.js@7';
  #worker: Worker | null = null;
  #paths: TesseractPaths;
  #initPromise: Promise<void> | null = null;

  constructor(paths: TesseractPaths = {}) {
    this.#paths = paths;
  }

  /** Idempotent AND concurrent-safe: two callers racing get one worker. */
  init(): Promise<void> {
    if (this.#worker) return Promise.resolve();
    if (!this.#initPromise) {
      this.#initPromise = createWorker('eng', undefined, { ...this.#paths, gzip: true })
        .then((worker) => {
          this.#worker = worker;
        })
        .finally(() => {
          this.#initPromise = null;
        });
    }
    return this.#initPromise;
  }

  async recognize(image: ImageLike): Promise<OcrResult> {
    await this.init();
    const worker = this.#worker;
    if (!worker) throw new Error('TesseractEngine: worker missing after init()');

    const started = performance.now();
    // Third argument is the output selector; without `blocks` there is no geometry.
    const { data } = await worker.recognize(image as never, {}, { blocks: true });
    const ms = performance.now() - started;

    const words = flattenWords(data.blocks);
    return {
      words,
      width: extent(words, 'x1'),
      height: extent(words, 'y1'),
      engine: this.name,
      ms,
    };
  }

  async dispose(): Promise<void> {
    await this.#worker?.terminate();
    this.#worker = null;
  }
}

/**
 * Walk whatever nesting the engine returns and collect the word level.
 *
 * Structural rather than typed against tesseract's exported shapes on purpose:
 * v6 changed the `blocks` object layout, and a recursive search for nodes that
 * carry a `words` array survives that kind of churn. Anything without text or a
 * box is dropped rather than trusted.
 */
function flattenWords(root: unknown): Word[] {
  const out: Word[] = [];

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const rec = node as Record<string, unknown>;

    if (Array.isArray(rec['words'])) {
      for (const w of rec['words'] as Record<string, unknown>[]) {
        const text = typeof w['text'] === 'string' ? w['text'].trim() : '';
        const bbox = w['bbox'] as Record<string, number> | undefined;
        if (!text || !bbox) continue;
        out.push({
          text,
          bbox: { x0: bbox['x0']!, y0: bbox['y0']!, x1: bbox['x1']!, y1: bbox['y1']! },
          confidence: typeof w['confidence'] === 'number' ? w['confidence'] : 0,
        });
      }
      return;
    }

    for (const key of ['blocks', 'paragraphs', 'lines', 'children']) {
      if (key in rec) visit(rec[key]);
    }
  };

  visit(root);
  return out;
}

const extent = (words: Word[], axis: 'x1' | 'y1'): number =>
  words.reduce((max, w) => Math.max(max, w.bbox[axis]), 0);

import { defineConfig } from 'vitest/config';

/**
 * Worker counts are pinned, not defaulted — the discipline MHLHUB arrived at
 * after its Jest suites exhausted memory on this same machine (client and
 * server pin maxWorkers: 2, the DB suites pin 1, and workers are recycled after
 * every file). Its note is the right one: pinning makes the blast radius a
 * decision instead of a default.
 *
 * It matters more here than in a normal test suite. Every tesseract.js worker
 * loads its own WASM engine plus ~15MB of language data, and the pipeline tests
 * OCR 40 fixtures. Vitest's default is a pool sized to the CPU count, so an
 * unpinned run can hold a dozen independent OCR engines at once for no gain —
 * the work is bounded by decode time inside each file, not by file count.
 */
export default defineConfig({
  test: {
    // OCR suites are memory-bound, not CPU-bound. Two is measured-enough here
    // and mirrors MHLHUB's client config.
    maxWorkers: 2,
    minWorkers: 1,
    // Long by unit-test standards because a single fixture can take seconds to
    // decode; the pipeline suite deliberately walks all 40.
    testTimeout: 600_000,
    hookTimeout: 120_000,
  },
});

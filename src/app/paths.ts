/**
 * Where this build's copy of the OCR engine lives: beside index.html, whatever
 * that URL is. Works at the Vite root, under /demos/receipt-splitter/ inside
 * the portfolio, or anywhere else the dist folder is dropped — `base: './'`
 * in vite.config.ts and `document.baseURI` here are the same decision.
 */
export function tesseractPaths() {
  const root = new URL('tesseract/', document.baseURI).href;
  return {
    workerPath: `${root}worker.min.js`,
    corePath: root,
    langPath: root.replace(/\/$/, ''),
  };
}

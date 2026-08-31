import type { OcrResult } from '../types';

/**
 * Anything tesseract.js will accept: a path or URL (Node + browser), a Buffer /
 * TypedArray, a Blob, or a canvas/image element. Kept deliberately wide so the
 * bake-off harness can pass file paths and the app can pass a captured frame.
 */
export type ImageLike =
  | string
  | Buffer
  | Uint8Array
  | Blob
  | HTMLCanvasElement
  | HTMLImageElement
  | ImageBitmap;

/**
 * THE ENGINE SEAM.
 *
 * The parser downstream consumes `Word[]` with pixel boxes and nothing else, so
 * swapping the OCR engine is a change to one file. This exists because the
 * engine choice is provisional: Tesseract ships first for reach (10.7M
 * downloads/month, works on every phone including iPhone), while PaddleOCR /
 * PP-OCRv5 is more accurate on receipts but currently unsafe on iOS — WebGPU
 * only landed in iOS 26, and onnxruntime-web has an open bug pinning Safari at
 * 400% CPU with runaway memory. If the bake-off says Tesseract cannot recover
 * prices reliably enough, a second implementation drops in here without the
 * parser, the reconciler, or the UI noticing.
 */
export interface OcrEngine {
  readonly name: string;
  /** Load models. Safe to call repeatedly; implementations must be idempotent. */
  init(): Promise<void>;
  recognize(image: ImageLike): Promise<OcrResult>;
  dispose(): Promise<void>;
}

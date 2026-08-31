import { describe, it, expect } from 'vitest';
import { clahe, unsharp, preprocess, toGray, type Gray } from '../src/ocr/preprocess';

const make = (width: number, height: number, fn: (x: number, y: number) => number): Gray => {
  const data = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = fn(x, y);
  return { data, width, height };
};

const variance = (img: Gray): number => {
  const mean = [...img.data].reduce((a, b) => a + b, 0) / img.data.length;
  return [...img.data].reduce((a, b) => a + (b - mean) ** 2, 0) / img.data.length;
};

describe('toGray', () => {
  it('collapses RGBA to one luma plane', () => {
    const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]);
    const gray = toGray(rgba, 2, 1);
    expect(gray.width).toBe(2);
    expect([...gray.data]).toEqual([255, 0]);
  });
});

describe('clahe', () => {
  it('preserves dimensions', () => {
    const out = clahe(make(64, 48, (x) => x * 2));
    expect(out.width).toBe(64);
    expect(out.height).toBe(48);
  });

  it('is deterministic', () => {
    const img = make(80, 80, (x, y) => (x * 7 + y * 13) % 256);
    expect([...clahe(img).data]).toEqual([...clahe(img).data]);
  });

  // The reason CLAHE exists here: one side of a photographed receipt is darker
  // than the other, and a global stretch cannot see a gradient.
  it('lifts local contrast under a brightness gradient', () => {
    const img = make(128, 128, (x, y) => {
      const gradient = (x / 128) * 120; // one side much darker than the other
      const texture = (x + y) % 8 < 4 ? 12 : 0;
      return 60 + gradient + texture;
    });
    expect(variance(clahe(img))).toBeGreaterThan(variance(img));
  });

  it('leaves a flat field flat rather than amplifying nothing into noise', () => {
    const out = clahe(make(64, 64, () => 128));
    expect(Math.max(...out.data) - Math.min(...out.data)).toBe(0);
  });
});

describe('unsharp', () => {
  it('preserves dimensions and is deterministic', () => {
    const img = make(40, 40, (x) => (x < 20 ? 40 : 200));
    const once = unsharp(img);
    expect(once.width).toBe(40);
    expect([...once.data]).toEqual([...unsharp(img).data]);
  });

  // Must be a soft STEP, not a linear ramp. Unsharp masking works on curvature:
  // a blur leaves a straight ramp unchanged, so the difference is exactly zero
  // and nothing is sharpened. Defocus produces this sigmoid shape, not a ramp.
  it('steepens a soft edge', () => {
    const soft = (x: number) => 128 + 100 * Math.tanh((x - 20) / 3);
    const img = make(40, 8, (x) => soft(x));
    const out = unsharp(img);

    const maxGradient = (g: Gray) => {
      let max = 0;
      for (let x = 0; x < 39; x++) {
        max = Math.max(max, Math.abs(g.data[4 * 40 + x + 1]! - g.data[4 * 40 + x]!));
      }
      return max;
    };
    expect(maxGradient(out)).toBeGreaterThan(maxGradient(img));
  });

  // The bug that cost 35 points of recall: a plain unsharp amplifies grain as
  // eagerly as it amplifies glyphs, and Tesseract reads amplified grain as
  // strokes. Below the threshold the response must stay gentle.
  it('barely touches low-amplitude grain', () => {
    const flat = make(64, 64, (x, y) => 128 + ((x * 31 + y * 17) % 3) - 1);
    const out = unsharp(flat);
    const before = Math.max(...flat.data) - Math.min(...flat.data);
    const after = Math.max(...out.data) - Math.min(...out.data);
    expect(after).toBeLessThanOrEqual(before * 2);
  });

  it('never pushes a pixel outside 0-255', () => {
    const img = make(32, 32, (x) => (x % 2 ? 255 : 0));
    for (const v of unsharp(img, { edgeSlope: 8 }).data) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(255);
    }
  });
});

describe('preprocess', () => {
  // Measured: sharpening alone beat every CLAHE combination on the fixtures.
  it('sharpens but does not equalise by default', () => {
    const img = make(64, 64, (x, y) => (x * 5 + y * 3) % 256);
    expect([...preprocess(img).data]).toEqual([...unsharp(img).data]);
  });

  it('applies CLAHE only when asked', () => {
    const img = make(64, 64, (x) => 40 + (x / 64) * 100);
    expect([...preprocess(img, { clahe: {} }).data]).not.toEqual([...preprocess(img).data]);
  });

  it('does not resize — upscaling measured worse than doing nothing', () => {
    const out = preprocess(make(100, 70, (x) => x));
    expect(out.width).toBe(100);
    expect(out.height).toBe(70);
  });
});

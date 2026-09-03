# Receipt Splitter

Photograph a receipt, say who had what, get the split. On-device OCR, no language
model, no network after first load, no cost.

Confidence does not come from the OCR engine reporting on itself — it reports
healthy confidence while misreading `TAX 1.69` as `19.169`. It comes from the
fact that a receipt prints its own answer key:

```
sum(line items)        == subtotal
subtotal + tax + tip   == total
```

If those hold, the read is proved. If they do not, the residual says which
number is wrong, and when exactly one field is bad the other three determine its
true value. **A split that does not reconcile is never shown.**

`legacy-java/` is v1 from February 2025, which asked GPT-3.5 to do this. It is
kept as history.

## Setup

```bash
npm install
npm run fixtures     # generate the synthetic test receipts (gitignored)
npm run dev          # the app, at http://localhost:5173 — stages the OCR engine first
```

`npm run dev` and `npm run build` first run `scripts/vendor-tesseract.ts`, which
copies the Tesseract worker, WASM core and language data into `public/tesseract/`
(gitignored, ~12MB). The built app serves its own engine and makes no other
network request — a demo that goes dark when a CDN does is not a demo, and the
photo never leaves the phone.

## The app

Opens with the camera closed. **Open camera** asks for permission only then,
frames the receipt in a portrait guide, and OCRs the guide's pixels frame by
frame until the bill settles: a frame that reconciles on its own is accepted at
once; one that needs a correction must repeat; otherwise the multi-frame
consensus deletes noise until the printed totals agree. **Use a photo** hands
one camera-app photograph to the same parser. **Type it in** skips OCR.

The review screen is the reconciler's verdict on the bill *as edited*: every
number is a field, the banner re-judges on each edit, and the split exists only
while the books close. Tap a name on an item to assign it; nobody assigned
means everyone.

Camera access needs HTTPS (or localhost), so the phone test is the deployed
copy: `https://<portfolio>/demos/receipt-splitter/`.

## Try it on a photo

```bash
npm run try -- ~/Desktop/receipt.jpg
npm run try -- receipt.jpg --people Dylan,Sam,Alex
npm run try -- receipt.jpg --raw                    # skip preprocessing, to compare
npm run try -- receipt.jpg --fixture dinner-aug31   # save it as a test case
```

Prints what the camera read, what the parser understood, whether the numbers
reconcile, and a worked split. When it cannot read a receipt it says so and
refuses — that is the intended behaviour, not a bug.

`--raw` is the demonstration worth seeing: on `fixtures/receipts/synthetic/sushi-dim.png`
preprocessing is the difference between a correct bill and an honest refusal.

## Checks

```bash
npm run typecheck    # tsc --noEmit
npm test             # vitest
npm run bakeoff      # OCR accuracy across every fixture
npm run bakeoff -- --raw
npm run bench:preprocess
```

The test suite separates two different things:

- **Safety** — whenever the reconciler settles a bill, its numbers are the
  receipt's real numbers. Asserted over every fixture including the unreadable
  ones. This must never regress.
- **Capability** — how often a receipt can be read at all. Allowed to fail;
  the bake-off measures it. Known-unreadable fixtures are listed with reasons
  rather than excluded, so an improvement is noticed as loudly as a regression.

## Adding real receipts

The synthetic fixtures are generated and too easy. `fixtures/receipts/real/` is
the honest set — see the README there. `npm run try -- <image> --fixture <id>`
writes the scaffold; **correct every number by hand against the paper**, because
a fixture that agrees with a misread proves nothing.

## Layout

```
src/ocr/         engine seam, preprocessing, Node + browser glue
src/parse/       geometry -> rows -> fields -> reconciliation
src/split/       assignment and exact penny arithmetic
src/capture/     camera glue (ported from MHLHUB) and the accept policy
src/app/         Preact UI: capture screen, review screen, editable bill
scripts/         fixtures, bake-off, benchmarks, try, vendor-tesseract
docs/plans/      the change record: decisions, measurements, and why
legacy-java/     v1, the version with the language model
```

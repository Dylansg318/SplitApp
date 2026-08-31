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
```

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
scripts/         fixtures, bake-off, benchmarks, try
docs/plans/      the change record: decisions, measurements, and why
legacy-java/     v1, the version with the language model
```

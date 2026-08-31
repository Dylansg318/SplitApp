# Receipt Splitter v2 — replace the model with a proof
<!-- Decision record + scope ledger + verification contract. Slice detail added JIT. -->

## Decision

**Problem:** Splitting a restaurant bill is arithmetic nobody wants to do at the table. v1
(Java, Feb 2025) reached for an LLM and failed at the step *before* the LLM — reading crumpled
thermal paper — then presented whatever it got back with no way to tell right from wrong.

**Approach:** A static, offline-capable web app. Camera → multi-frame capture → on-device
Tesseract OCR → geometric parse (cluster words into rows by y, find the right-aligned price
column by x) → **reconcile against the receipt's own printed subtotal/tax/tip/total** → mobile
assignment UI → proportional tax and tip → share via URL fragment. No backend, no accounts, no
API keys, no network after first load. Confidence comes from arithmetic, not from a model.

**Rejected:**
- **LLM parsing** — the thing being removed. Unauditable, costs money, hallucinates totals.
- **Cloud OCR (Vision/Textract)** — accurate and not an LLM, but reintroduces the bill, the key,
  the backend, and the privacy loss. Fails the whole premise.
- **PaddleOCR / PP-OCRv5 primary** — ~99.2% char accuracy on receipts vs Tesseract's, but
  onnxruntime-web is unsafe on iPhone today: WebGPU only landed in iOS 26, ORT issue #26827 has
  Safari pinning 400% CPU and climbing past 14GB RAM, and the WASM fallback OOMs on iPhone.
  Wrong risk profile for a tool used at a dinner table. Engine sits behind an interface so this
  is a later drop-in, gated on slice 2's measured reconcile rate.
- **Astro island lane for the portfolio demo** — a ~10MB WASM OCR bundle must not enter the
  site's build graph. `Demo.astro`'s iframe lane exists for exactly this.
- **A backend for sharing** — unnecessary. A URL fragment never reaches a server, so sharing
  works with zero infrastructure and the privacy invariant survives.
- **Standalone-mode PWA on iOS** — WebKit bug 185448: getUserMedia is broken in standalone and
  the permission grant isn't persisted. Ship without `apple-mobile-web-app-capable` so the
  home-screen icon opens in Safari, where the camera works. Android installs fully.

**Invariants that must hold:**
1. **Nothing leaves the device.** Zero network calls after first load. Product promise, not a detail.
2. **Never display a split that doesn't reconcile.** If assigned ≠ printed total, say so and
   highlight the suspect fields. (v1's write-up names this as its own biggest flaw.)
3. **Allocations sum to the total exactly.** Penny rounding distributes remainders; never invent
   or lose a cent. Property-tested, not eyeballed.
4. **Every OCR'd number is editable in one tap.** OCR is a first draft, never the last word.
5. **Assignment moves money, never creates it.** Items default to shared-by-everyone, so the
   bill reconciles from first render and tapping only redistributes.
6. **Deterministic.** Same photo → same parse, every time.
7. **The portfolio embed and the real app are the same build.** The demo cannot drift from the tool.
8. Portfolio rules stand: demo lane contract per `Demo.astro`; content schema per `content.config.ts`.
9. Dylan's rules stand: stage/commit by explicit path, one push per task, drafts for approval.

## Verification contract

| # | Slice | Proof command | Expected observable |
|---|---|---|---|
| 1 | Scaffold + OCR harness | `npm run typecheck && npm run bakeoff` | 0 errors; per-receipt char accuracy + price recall printed for every fixture |
| 2 | Geometric parser + reconcile | `npm test -- parser` | All fixtures parse; reconcile rate reported; ≥1 known-bad receipt correctly flagged as NOT reconciling |
| 3 | Capture + multi-frame vote | `npm test -- capture` + live phone check | Voting beats single-frame accuracy on burst fixtures; rear camera opens on a real phone |
| 4 | Split model + money math | `npm test -- split` | All pass incl. property test: allocations sum to total across 10k random bills, zero drift |
| 5 | Mobile UI | `npm run typecheck && npm test -- ui` + live phone check | 0 errors; assign/edit/reconcile-banner work by hand on a phone |
| 6 | Persistence + share | `npm test -- share` | encode→decode round-trips identically; state survives reload |
| 7 | PWA shell | `npm run build` + airplane-mode load | Loads and OCRs a fixture with networking off; no `apple-mobile-web-app-capable` in output |
| 8 | Portfolio embed | `npm run check && npm run build` *(in Portfolio)* | 0 errors; demo renders and runs in the iframe lane |

## Scope ledger

- [x] 1. Move Java to `legacy-java/`; Vite+Preact+TS app at root; Tesseract behind `OcrEngine`; bake-off harness   DONE ed4b007
- [x] 2. Geometric parser (row clustering, price column) + reconciliation engine                                   DONE eea7eff
- [x] 3a. Preprocessing on the OCR path — shipped as sharpen-only; CLAHE measured worse                            DONE
- [ ] 3b. Camera capture: rear cam, guide frame, multi-frame voting                                                 TODO (needs a device)
- [x] 4. Split model: assignee sets, family-style default, proportional tax/tip, exact penny rounding              DONE a4d219b
- [ ] 5. Mobile UI: item list, tap-to-assign, inline number editing, reconciliation banner                         TODO
- [ ] 6. Persistence (IndexedDB) + URL-fragment share + share image via Web Share API                              TODO
- [ ] 7. PWA shell: manifest, service worker, offline model cache, iOS-safe (no standalone)                        TODO
- [ ] 8. Portfolio embed via iframe lane + rewrite `receipt-splitter/index.mdx` (status, AI claims)                 TODO

## Slice detail — slice 1 only

### Slice 1: Scaffold, OCR harness, and an honest measurement

**Files:** `legacy-java/**` (moved), `package.json`, `vite.config.ts`, `tsconfig.json`,
`src/ocr/engine.ts`, `src/ocr/tesseract.ts`, `scripts/bakeoff.ts`, `fixtures/receipts/**`

**Change:**
- `git mv` pom.xml, mvnw, mvnw.cmd, .mvn, src → `legacy-java/`. Java stays runnable; the web app
  becomes the repo's primary artifact.
- Vite + Preact + TypeScript at root. Strict mode on.
- `OcrEngine` interface: `recognize(img) => Promise<Word[]>` where
  `Word = { text, bbox: {x0,y0,x1,y1}, confidence }`. Tesseract.js v7 is the first
  implementation — it must be swappable without touching the parser.
- Tesseract.js needs non-text output explicitly enabled (v6+ disables all but `text` by default);
  we need word-level boxes or the geometric parser in slice 2 has nothing to work with.
- Two fixture sets: **synthetic** thermal-style receipts rendered to PNG with exact ground-truth
  JSON (repeatable regression), and **real** photos from Dylan's wallet (honest about folds,
  fade, stains). Real receipts are the test set — that is v1's own stated lesson.
- `scripts/bakeoff.ts`: run every fixture through the engine, report character accuracy and
  price-token recall per receipt and in aggregate.

**Proves it:** `npm run typecheck && npm run bakeoff` → 0 type errors and a per-fixture table.
The aggregate price-token recall is the number that decides slice 2's design: if Tesseract
recovers prices reliably, geometric parsing is enough; if not, the PaddleOCR interface swap
gets pulled forward from "rejected" to slice 2a.

**Blocked on Dylan for:** ~10 real receipt photos. Synthetic fixtures unblock everything else,
so this does not stall the slice — but the go/no-go on the engine is not real until the real
photos are in.

## Slice 1 result — measured, not assumed

`npm run typecheck` clean. `npm run fixtures && npm run bakeoff` over 20 synthetic
fixtures (5 receipts x clean/faded/skewed/worn):

| metric | result |
|---|---|
| Receipts with all four totals intact | 19/20 (95%) |
| Total-field recall (subtotal/tax/tip/total) | 99% |
| Line-item price recall | 100% |
| Character accuracy | 100% |

**Engine decision: Tesseract stays.** PaddleOCR is not pulled forward. Nothing here
argues the engine is the bottleneck.

**Two honest caveats.**

1. These fixtures are too easy. 100% item recall on the "worn" variant is not a
   result a real thermal receipt will reproduce. Synthetic is the regression
   suite; `fixtures/receipts/real/` is the evidence, and it is still empty.
2. The char-accuracy metric was wrong on first run — it scored a flawless read at
   70% because it counted the dashed divider rows, which OCR correctly ignores, as
   missed characters. Fixed by excluding dividers from `fullText`. Worth recording
   because it is the exact failure this project exists to prevent: a plausible
   number that is silently meaningless.

**`taqueria-faded` is now a required regression case.** Fade caused a misread:

```
TRUE:  TAX 1.69
OCR:   TAX 19.169
```

Subtotal (17.75), tip (2.66) and total (22.10) all read correctly, so the receipt
fails its own arithmetic: 17.75 + 19.169 + 2.66 = 39.58, not 22.10. This validates
invariant 2 against a real misread rather than a hypothetical, and it sets slice 2's
bar higher than flagging: with exactly one bad field among four, the reconciler can
SOLVE for it — 22.10 - 17.75 - 2.66 = 1.69, the true value. Detect, then repair,
then ask the user to confirm the repair.

## Slice 2 result — the thesis holds

`npx tsc --noEmit` 0 errors. `npx vitest run` 14/14 pass. All 20 fixtures parse
and reconcile to **exactly** the ground-truth subtotal/tax/tip/total.

Three findings from execution, none of them predicted:

1. **Skew broke the parser, not the OCR.** All five `skewed` fixtures failed at
   first. The bake-off had already shown 100% OCR recall on them, so the fault
   was mine: at 2.4 degrees across a 900px page a line's ends differ by ~38px of
   vertical, well past a 0.6-line-height tolerance, so every row shattered.
   Fixed by estimating the baseline slope as the median over adjacent word pairs
   and grouping on the de-skewed coordinate `y - slope*x`. Median rather than a
   least-squares fit because column gaps and stray marks are outliers a fit
   would chase. This matters beyond the fixtures — no phone photo is square.

2. **The malformed-money guard fired before the reconciler did.** `taqueria-faded`
   was expected to surface tax as the misread 19169. It surfaces as `null`:
   `parseCents` requires exactly two decimal places, so "19.169" is refused as a
   money token and never becomes a number the app would spend. The reconciler
   then derives the true 169 via the single-missing-field path instead of the
   repair path. Two independent defences, reached by different routes — better
   than designed, and the test now pins both.

3. **Descriptions do not need to be exact.** Tesseract reads GYOZA as GY0ZA.
   Prices are asserted exactly because they are the arithmetic; descriptions are
   asserted only as human-recognisable, since they are cosmetic and editable
   under invariant 4. Failing a build over GY0ZA would be theatre.

Known limitation recorded, not fixed: discount and comp lines are unmodelled, so
`isPlausible` treats `total < subtotal` as a misread. Revisit when a real receipt
in `fixtures/receipts/real/` has a discount on it.

## Slice 4 result — the money math, taken out of order

Slice 3 needs a real phone to prove, so slice 4 ran first. Pure logic, fully
verifiable here, and it completes the correctness core.

`npx tsc --noEmit` 0 errors. `npx vitest run` 29/29 across three files.

**One model covers both ways people eat.** Every item carries a set of people
sharing it — one name is a dish that is yours, several is family style, empty is
the whole table. No mode switch, because a real table is both at once. This is
the union Dylan asked for rather than either option originally offered.

**Invariant 3 is now enforced by construction, not by hope.** Largest-remainder
apportionment: floor every share, then hand the leftover pennies to whoever was
rounded down hardest. Three people splitting $7.00 get 2.34 / 2.33 / 2.33, never
$6.99 or $7.02. Ties break toward the earlier index so the same bill always
splits the same way. Proven over 20,000 random apportionments and 5,000 random
whole bills, every one summing exactly.

**Tax and tip follow subtotal share, not head count** — the salad does not
subsidise the steak's tax.

**splitBill refuses rather than approximates.** If the line items disagree with
the subtotal, or the bill does not balance, it throws instead of returning a
plausible number. `splitEvenly` is the honest fallback when only the total could
be read.

## Correction — the fixtures were too easy, and the 95% was not real

Dylan asked whether any realistic photographs had been used. They had not: every
fixture was generated, crisp, flat-on and evenly lit. The reported 95% was a
measurement of the generator, not of the system.

Four photographic variants added — `handheld`, `folded`, `dim`, `defocused` —
with off-axis geometry, uneven illumination, fold shadows, gaussian sensor
grain, JPEG loss and reduced resolution. 40 fixtures now.

**The honest number is 65%, not 95%.**

| variant | totals intact |
|---|---|
| clean / skewed / worn / folded | 100% |
| faded | 95% |
| handheld — an ordinary phone snap | 80% |
| defocused | 20% |
| dim — restaurant lighting | 0% |

### The most valuable result so far: preprocessing is load-bearing

Measured over the 15 hard fixtures, total-field recall by preprocessing recipe:

| recipe | recall |
|---|---|
| raw | 33% |
| `normalize` | 32% — no help at all |
| CLAHE | 52% |
| **CLAHE + sharpen** | **85%** |
| upscale + CLAHE + sharpen | 50% — upscaling actively hurts |

Contrast-limited adaptive histogram equalisation plus a sharpen is a 2.6x
improvement for about two lines of processing. Global `normalize` does nothing,
because the problem is a lighting *gradient*, not overall contrast — which is
exactly what CLAHE is for and what a global stretch cannot see.

**Consequence: slice 3 splits.** Preprocessing (3a) is pulled forward and needs
no device. Camera capture (3b) still does. Note sharp is Node-only, so the
browser needs CLAHE over ImageData — roughly 60 lines, and preferable to pulling
in OpenCV.js for one operation given the bundle sits behind a click.

### The test suite now separates safety from capability

Reading a receipt is a capability and capabilities may fail; a receipt shot in
the dark can be genuinely unreadable, and the bake-off measures how often.
Answering *wrongly* is different, and is what invariant 2 forbids.

- **Safety, over all 40 fixtures including the unreadable ones:** whenever the
  reconciler settles a bill, its numbers are the receipt's real numbers.
  **This passes.** Not one wrong answer under any degradation. Guarded against
  passing vacuously by also requiring that over half of fixtures settle.
- **Capability, over the well-lit variants:** with `taqueria-folded` pinned as
  known-unreadable — the fold shadow destroys the TAX and TIP labels, so the
  receipt stops describing itself and is correctly refused. Listed rather than
  excluded, so a change in either direction is noticed.

`npx vitest run` 30/30.

## Slice 3a result — preprocessing, and a safety bug it exposed

`npx tsc --noEmit` 0 errors. `npx vitest run` 42/42. Bake-off headline
**26/40 -> 32/40**, total-field recall 74% -> 91%. Per variant, dim went 0% ->
80% and handheld 80% -> 100%.

### It shipped as sharpen-only, and CLAHE is off

The hypothesis from the earlier experiment was CLAHE + sharpen at 85%. Measuring
the two separately with a browser-bound implementation says otherwise:

| | CLAHE only | sharpen only | both |
|---|---|---|---|
| sharp (native) | 52% | 80% | 85% |
| ours (ships) | **62%** | **85%** | 53% |

Our CLAHE is better than sharp's and our sharpen is better than sharp's, but
stacking them is worse than either. Both operations amplify grain; doing both
amplifies it twice, and the second pass costs more in false strokes than the
first gains in contrast. Swept eight CLAHE settings (clip 1-3 x tile 64/128) and
sharpening alone beat all of them. CLAHE is kept, off by default, as a pending
experiment against real photographs — where the noise is not synthetic gaussian
and the illumination is genuinely non-uniform. If that experiment does not
happen, delete it.

Two implementation details carried most of the value, and getting either wrong
cost ~35 points of recall:

1. **The sharpen response must be continuous.** Switching multiplier on the
   whole difference at the threshold puts a step in the response curve, and a
   step in a sharpening operator manufactures the very artefacts the threshold
   exists to prevent. The steep slope applies to the EXCESS above the threshold.
2. **libvips works in LAB, where L is 0-100.** Its documented caps of 10 and 20
   are ~25 and ~51 levels on a 0-255 channel. Reading them as raw levels clamps
   twice as hard as intended and discards most of the sharpening.

Strength was then swept end-to-end over all 40 fixtures by receipts actually
settled rather than by character recall: edgeSlope 1.5 settles 33, 2.0 and 2.5
settle 32, no sharpening settles 26. **No setting, at any strength, ever
produced a wrong answer.**

### A confidently wrong bill, and the structural fix

Preprocessing raised recall and immediately broke the safety property. On
`sushi-dim`:

```
claimed:  subtotal 70.51  tax 4.18  tip 0      -> 74.69  balances
truth:    subtotal 59.75  tax 4.18  tip 10.76  -> 74.69  balances
```

Mechanism: OCR read `SUBTOTAL 59.75` as `59475`, which parseCents correctly
refused, leaving the subtotal unknown. It also read `TIP 10.76` as `SNIP 10.76`,
which matched no label and so became a LINE ITEM. The tip was thereby absorbed
into the item sum, that sum stood in for the missing subtotal, and
subtotal + tax then equalled the printed total exactly — so the "no tip printed"
rule fired and produced a wrong bill that balances perfectly.

Nothing in the arithmetic can catch this: adding the tip to the subtotal is
exactly what the equations expect. The first attempted fix — requiring line
items to corroborate the subtotal — could not fire either, because the subtotal
had been *derived from* those items and cannot contradict itself.

**The fix is structural, not arithmetic.** Receipts are ordered: line items,
then the totals block. A priced row at or after the first SUBTOTAL/TAX/TOTAL
label is a misread label or a payment line, never a dish. The block boundary is
detected from row TEXT rather than a parsed price, because on this very receipt
the SUBTOTAL line's own value was unreadable and only its label survived.

Both defences are kept: item corroboration now also gates the tip-zero
inference, the single-missing-field derivation, and the repair search.
`ParsedReceipt.unreadable` additionally records fields whose label was found but
whose value would not parse — "we could not read this" is a different and more
honest message than "the receipt does not state it".

### The known-failure list caught an improvement

`taqueria-folded` was pinned as unreadable because a fold shadow buried its TAX
and TIP labels. Sharpening recovers them, and the list flagged it as newly
passing rather than silently absorbing the win. `brunch-worn` replaces it:
sharpening costs that fixture one line item, so the items stop matching the
subtotal and the bill is correctly refused. A capability loss, not a safety one,
against dim receipts going 0% -> 80%.

## REAL PHOTOGRAPHS — the synthetic score does not transfer

Dylan supplied 13 photographs of real receipts. **1 of 13 parses correctly.**
The synthetic set scores 30/40. That gap is the whole finding, and it is the
reason real photographs were named as the gate from the beginning.

| outcome | n |
|---|---|
| correct | 1 (Thai Duong: sub 60.80, tax 3.65, tip 12.89, total 77.34 — exact) |
| settled on a non-receipt | 1 (an end-of-day POS sales report) |
| refused safely | 11 |

**No wrong answer was produced on any actual receipt.** The safety property
holds where it matters, and the honest headline is that capability is close to
zero on real input.

### Why real photographs are a different problem

1. **The receipt is ~30% of the frame.** Everything else — table, card reader,
   neighbouring papers, a menu — is OCR'd too. A real row came back as
   `RE | Subtotal $60.80`, where `RE |` is a table edge, and another as
   `CL RE eI RE a $77.34`, which is the word "Total" destroyed. Cropping to the
   paper cut one receipt from 311 words to 103 and recovered a tax line, so it
   helps materially, but on its own it did not settle either receipt tried.
2. **Decimal points are the fragile character.** `$23.00` read as `$2300`,
   `3.75` as `35`. parseCents refuses both, which is right — they never become
   money the app would spend — but the field is then simply lost.
3. **Price columns are not always aligned with their descriptions.** One QUI
   receipt prints prices offset roughly half a line above the dish they belong
   to, so geometric pairing attaches every price to the wrong item.
4. **Number-dense documents can balance by coincidence.** The POS sales report
   carries ~60 money values; three of them summed correctly and the bill
   settled. With enough candidates, `subtotal + tax + tip == total` stops being
   strong evidence on its own.

### Two changes, both measured

- **Totals-block detection is no longer `^`-anchored**, because real rows carry
  leading debris. Restricted to the long labels only: TAX, VAT and GST were
  tried and removed, since three characters match OCR noise readily and a false
  boundary discards every item below it. A totals row must also state a price.
- **Sharpen sigma scales with image width**, floored at the tuned baseline. A
  blur radius only means something relative to stroke width, and a 4032px
  photograph is four times wider than anything this was tuned against. Letting
  it scale DOWN as well cost the synthetic set two receipts, so it only ever
  scales up.

Together these took real receipts 0/13 -> 1/13 and synthetic 32/40 -> 30/40.

`taqueria-folded` is pinned again, with the cause now known exactly: the fold
shadow eats the decimal in `3.75`, OCR returns `35`, and the item loses its
price. It has flipped twice in a day; it is marginal and is pinned rather than
tuned for.

### What this implies for the plan

Cropping the receipt out of the photograph is the missing stage, and it belongs
in slice 3b rather than as an afterthought — the capture UI's guide frame solves
detection and orientation at source, which is what a guide frame is FOR. Photos
chosen from the library still need real detection.

Not attempted, and worth considering before more parser tuning: multi-frame
consensus from the live camera, which was always in the design and directly
attacks the lost-decimal failure, since a decimal point missed in one frame is
usually present in another.

### These photographs must not be committed

Several are merchant card slips carrying third-party customer names and
signatures. They are other people's data and must not enter a public repository,
whatever the licence position on the images themselves. Only itemised food
receipts with no personal details should become fixtures.

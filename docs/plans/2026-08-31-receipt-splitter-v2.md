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
- [ ] 3. Camera capture: rear cam, guide frame, multi-frame voting, preprocess (grey/deskew/threshold)             TODO
- [ ] 4. Split model: assignee sets, family-style default, proportional tax/tip, exact penny rounding              TODO
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

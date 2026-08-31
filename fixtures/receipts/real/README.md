# Real receipts — the set that actually counts

The synthetic fixtures next door are generated, exact, and **too easy**. They
score 100% on line-item prices even in the "worn" variant, which no real
thermal receipt will do. They exist as a fast regression suite, not as evidence.

This folder is the honest set. To add one:

1. Photograph a real receipt the way you actually would at a table — held in one
   hand, indoor light, no flattening, no cropping. Save it here as
   `<name>.jpg` (or `.png` / `.webp`).
2. Write `<name>.json` beside it with the true contents, **money in integer
   cents**:

   ```json
   {
     "id": "olive-garden-2026-08",
     "merchant": "OLIVE GARDEN",
     "items": [{ "desc": "CHICKEN PARM", "price": 2195 }],
     "subtotal": 2195,
     "tax": 181,
     "tip": 439,
     "total": 2815,
     "variant": "real",
     "fullText": "OLIVE GARDEN CHICKEN PARM 21.95 SUBTOTAL 21.95 TAX 1.81 TIP 4.39 TOTAL 28.15"
   }
   ```

   `fullText` excludes divider rows — see the note on `ReceiptGroundTruth`.

3. `npm run bakeoff` picks it up automatically.

Aim for ten, and deliberately include the bad ones: a fold through the middle, a
faded bottom, a coffee ring, a curled edge. The point of this set is to fail.

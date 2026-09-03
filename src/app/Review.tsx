import { useEffect, useState } from 'preact/hooks';
import { formatCents } from '../types';
import type { Cents } from '../types';
import {
  addItem,
  addPerson,
  applyRepairs,
  nextPlaceholderName,
  parseTyped,
  removeItem,
  removePerson,
  renamePerson,
  setField,
  setItemDesc,
  setItemPrice,
  toggleAssignee,
  verdict,
  type EditableBill,
  type TotalsField,
} from './bill';

/**
 * THE REVIEW SCREEN — slice 5.
 *
 * Everything on it is editable in one tap (invariant 4), the banner at the
 * top is the reconciler's verdict on the bill AS EDITED, and the split at the
 * bottom exists only while that verdict is clean (invariant 2). Tapping a name
 * on an item moves money between people and never changes the total
 * (invariant 5).
 */
export interface ReviewProps {
  bill: EditableBill;
  origin: string;
  /** The receipt the numbers came from, when there was one, so they can be checked against it. */
  image: string | null;
  onChange: (bill: EditableBill) => void;
  onRescan: () => void;
}

const FIELDS: { key: TotalsField; label: string }[] = [
  { key: 'subtotal', label: 'Subtotal' },
  { key: 'tax', label: 'Tax' },
  { key: 'tip', label: 'Tip' },
  { key: 'total', label: 'Total' },
];

export function Review({ bill, origin, image, onChange, onRescan }: ReviewProps) {
  const v = verdict(bill);
  const { reconciliation, split } = v;
  const suspect = new Set(reconciliation.repairs.map((r) => r.field));
  const itemsSum = bill.items.reduce((s, i) => s + i.price, 0);
  const [showImage, setShowImage] = useState(false);

  return (
    <main class="screen review">
      <header class="topbar">
        <button type="button" class="btn btn-link" onClick={onRescan}>
          ‹ Scan again
        </button>
        <span class="muted small">{origin}</span>
      </header>

      <Banner bill={bill} v={v} onApply={() => onChange(applyRepairs(bill, reconciliation))} />

      {image && (
        <div class="receipt-toggle">
          <button type="button" class="btn btn-link" onClick={() => setShowImage((s) => !s)} aria-expanded={showImage}>
            {showImage ? 'Hide the receipt' : 'Show the receipt'}
          </button>
          {showImage && (
            <figure class="receipt-image">
              <img src={image} alt="The receipt these numbers were read from" />
            </figure>
          )}
        </div>
      )}

      <section class="card">
        <h2>People</h2>
        <ul class="people">
          {bill.people.map((p) => (
            <li key={p.id} class="pill">
              <input
                class="name"
                value={p.name}
                aria-label="Name"
                onInput={(e) => onChange(renamePerson(bill, p.id, (e.currentTarget as HTMLInputElement).value))}
              />
              {bill.people.length > 1 && (
                <button
                  type="button"
                  class="remove"
                  aria-label={`Remove ${p.name}`}
                  title={`Remove ${p.name}`}
                  onClick={() => onChange(removePerson(bill, p.id))}
                >
                  ×
                </button>
              )}
            </li>
          ))}
          <li>
            <button type="button" class="btn btn-link" onClick={() => onChange(addPerson(bill, nextPlaceholderName(bill.people)))}>
              + Add person
            </button>
          </li>
        </ul>
      </section>

      <section class="card">
        <h2>
          Items <span class="muted small">tap a name to assign · nobody means everyone</span>
        </h2>
        {bill.items.length === 0 && <p class="muted">No line items. The total will be split evenly.</p>}
        <ul class="items">
          {bill.items.map((item) => (
            <li key={item.id} class="item">
              <div class="item-row">
                <input
                  class="desc"
                  value={item.desc}
                  placeholder="Item"
                  aria-label="Item description"
                  onInput={(e) => onChange(setItemDesc(bill, item.id, (e.currentTarget as HTMLInputElement).value))}
                />
                <Money value={item.price} onCommit={(c) => onChange(setItemPrice(bill, item.id, c ?? 0))} />
                <button type="button" class="remove" aria-label="Remove item" title="Remove item" onClick={() => onChange(removeItem(bill, item.id))}>
                  ×
                </button>
              </div>
              <div class="chips" role="group" aria-label="Shared by">
                {bill.people.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    class={`chip${item.assignees.includes(p.id) ? ' on' : ''}`}
                    aria-pressed={item.assignees.includes(p.id)}
                    onClick={() => onChange(toggleAssignee(bill, item.id, p.id))}
                  >
                    {p.name || '?'}
                  </button>
                ))}
                {item.assignees.length === 0 && <span class="muted small">everyone</span>}
              </div>
            </li>
          ))}
        </ul>
        <div class="row between">
          <button type="button" class="btn btn-link" onClick={() => onChange(addItem(bill))}>
            + Add item
          </button>
          {bill.items.length > 0 && (
            <span class={`muted small${bill.subtotal !== null && itemsSum !== bill.subtotal ? ' bad' : ''}`}>
              items add to {formatCents(itemsSum)}
            </span>
          )}
        </div>
      </section>

      <section class="card">
        <h2>Printed totals</h2>
        <ul class="totals">
          {FIELDS.map(({ key, label }) => (
            <li key={key} class={suspect.has(key) ? 'suspect' : ''}>
              <span>{label}</span>
              <Money value={bill[key]} allowEmpty onCommit={(c) => onChange(setField(bill, key, c))} />
            </li>
          ))}
        </ul>
      </section>

      {split && (
        <section class="card split">
          <h2>Each person owes</h2>
          {v.evenly && <p class="muted small">No line items, so the total is split evenly.</p>}
          <ul class="shares">
            {split.shares.map((s) => (
              <li key={s.personId}>
                <div class="share-head">
                  <span class="share-name">{s.name || '?'}</span>
                  <span class="amount">${formatCents(s.total)}</span>
                </div>
                {!v.evenly && (
                  <div class="muted small">
                    items {formatCents(s.items)} · tax {formatCents(s.tax)} · tip {formatCents(s.tip)}
                  </div>
                )}
              </li>
            ))}
          </ul>
          <p class="sum ok">
            <span class="check" aria-hidden="true">✓</span> ${formatCents(split.total)} — matches the printed total
          </p>
        </section>
      )}
    </main>
  );
}

function Banner({ bill, v, onApply }: { bill: EditableBill; v: ReturnType<typeof verdict>; onApply: () => void }) {
  const r = v.reconciliation;
  if (r.status === 'reconciled') {
    const proof =
      bill.items.length > 0
        ? `${bill.items.length} items add to the subtotal, and subtotal + tax + tip equals the total.`
        : 'Subtotal + tax + tip equals the total.';
    return (
      <div class="banner ok" role="status">
        <strong>Adds up.</strong> {proof}
      </div>
    );
  }
  if (r.status === 'repaired') {
    return (
      <div class="banner warn" role="status">
        <strong>One correction needed before the split shows.</strong>
        <ul>
          {r.repairs.map((rep) => (
            <li key={rep.field}>
              <b>{rep.field}</b> {rep.from === null ? 'not read' : `read as ${formatCents(rep.from)}`} → <b>{formatCents(rep.to)}</b>
              <span class="muted small"> — {rep.reason}</span>
            </li>
          ))}
        </ul>
        <div class="row">
          <button type="button" class="btn btn-primary" onClick={onApply}>
            Apply {r.repairs.length === 1 ? 'correction' : 'corrections'}
          </button>
          <span class="muted small">or fix the numbers yourself below</span>
        </div>
      </div>
    );
  }
  return (
    <div class="banner bad" role="alert">
      <strong>Doesn’t add up — no split until it does.</strong>
      <ul>
        {r.problems.map((p) => (
          <li key={p}>{p}</li>
        ))}
        {r.problems.length === 0 && <li>Fill in the printed totals.</li>}
      </ul>
    </div>
  );
}

/**
 * A money field that commits on blur or Enter, in cents, and refuses to hold
 * anything it cannot parse — the previous value stays and the field turns red
 * until the text is a number again.
 */
function Money({ value, allowEmpty = false, onCommit }: { value: Cents | null; allowEmpty?: boolean; onCommit: (c: Cents | null) => void }) {
  const [text, setText] = useState(value === null ? '' : formatCents(value));
  const [bad, setBad] = useState(false);
  useEffect(() => {
    setText(value === null ? '' : formatCents(value));
    setBad(false);
  }, [value]);

  const commit = () => {
    const trimmed = text.trim();
    if (trimmed === '') {
      if (allowEmpty) {
        setBad(false);
        onCommit(null);
      } else {
        setBad(true);
      }
      return;
    }
    const cents = parseTyped(trimmed);
    if (cents === null) {
      setBad(true);
      return;
    }
    setBad(false);
    setText(formatCents(cents));
    onCommit(cents);
  };

  return (
    <input
      class={`money${bad ? ' bad' : ''}`}
      inputMode="decimal"
      value={text}
      placeholder={allowEmpty ? '—' : '0.00'}
      aria-invalid={bad}
      onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
      }}
    />
  );
}

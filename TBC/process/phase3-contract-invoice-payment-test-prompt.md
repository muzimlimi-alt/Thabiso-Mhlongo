# Phase 3 — Contract, Invoice & Payment: Test & Close Gaps (v2 — re-audited against latest code)

## Changelog from v1 — read this first, it changes the priority order

Two of v1's findings need correcting, not just confirming:

1. **The invoice VOID casing bug does not reproduce.** Every write to
   `invoices.status = 'VOID'` found in the current codebase
   (server.js ~1031, ~4966, ~6774) is uppercase, consistently. The comparisons
   are a mix of `!= 'VOID'` and `UPPER(status) != 'VOID'`, but since the data is
   never actually written lowercase, both forms work correctly in practice. The
   lowercase `'void'` convention exists only on the **`quotations`** table
   (a different table, correctly scoped to its own lowercase convention) — that
   line was likely the source of the original confusion. **Drop this from the
   gap list.** The broader observation that `bookings` uses uppercase status
   and `quotations`/`contracts`/`transactions` use lowercase remains
   structurally true, but it isn't producing a bug here.

2. **The PayFast/manual payment status inconsistency is narrower than v1
   described, not resolved.** Both paths were touched since v1. Re-read section
   1 below carefully before testing.

## 0. Phase boundary

Invoice generation happens at quote acceptance (end of Phase 2). This phase
covers what happens to that invoice, the contract, and payment — through
`bookings.status = 'CONFIRMED'`.

## 1. Confirmed implementation (re-audited against the latest upload)

**Contracts** — unchanged from v1. Still admin-uploaded PDFs
(`POST /api/admin/bookings/:id/contract`, server.js ~5142+), still resets
`status='draft'` and `is_frozen=0` on every re-upload regardless of prior
signed state. **New finding**: the separate signing route
(`PUT /api/admin/bookings/:id/contract/sign`, confirmed present) correctly
blocks re-signing an already-signed contract (`is_frozen===1 ||
status==='signed'` → 400) — so double-*signing* is guarded, but overwriting a
signed contract via re-*upload* still isn't. Gap 3 (below) is narrower than it
might first appear: the signing step is safe, the upload step is the hole.

**Invoices**: auto-generated at quote acceptance. Status values are
consistently uppercase `'VOID'` at write time (see changelog above). Multiple
paths now mark an invoice `'PAID'` (server.js ~3843, ~4130, ~7637) — all using
the same `WHERE booking_id=? AND status NOT IN ('VOID','PAID')` guard, which is
idempotent and consistent. No casing issue found across any of them.

**Payment — both paths were modified since v1, and the gap shifted, it didn't close:**

- **PayFast ITN** (server.js ~3766–3850): the unconditional `status =
  'CONFIRMED'` from v1 is gone. It's now:
  ```sql
  status = CASE WHEN status IN ('ACCEPTED','CONFIRMED') THEN 'CONFIRMED' ELSE status END
  ```
  This is a real improvement — a payment can no longer force-confirm a booking
  that hasn't even reached `ACCEPTED` yet. **But within that guard, it still
  confirms on *any* payment level** — `PAID`, `DEPOSIT_PAID`, and
  `PARTIALLY_PAID` all satisfy the `CASE` condition identically, since the
  condition only checks the *current status*, not the *payment amount*. A 10%
  deposit via PayFast on an already-`ACCEPTED` booking still jumps straight to
  `CONFIRMED`.
  - New, separate addition: a guard now rejects the ITN entirely if
    `total_amount` can't be resolved (`currentTotal === 0`), with an admin
    alert email — this closes a related risk (payment applied with nothing to
    apply it against) that v1 didn't explicitly test for.

- **Manual payment** (`PUT /api/admin/bookings/:id/manual-payment`, server.js
  ~4019–4140, now split into the route handler plus a `processManualPayment`
  helper): status logic changed too —
  ```js
  const newStatus = payment_status === 'PAID'
      ? (['ACCEPTED','CONFIRMED'].includes(row.status) ? 'CONFIRMED' : 'ACCEPTED')
      : row.status;
  ```
  Still **only** advances status on full `PAID` — deposit/partial payments
  leave `row.status` untouched, same as v1. **New: if a full payment is recorded
  on a booking that was never explicitly accepted, it now advances to
  `ACCEPTED` rather than just sitting stuck** — a sensible improvement, but
  worth confirming it doesn't skip the payment-schedule/invoice side effects
  that the *real* acceptance route creates (this manual-payment path does not
  call `generateInvoice()` or create `payment_schedules` — if a payment is
  recorded against a booking that skipped formal acceptance, confirm an invoice
  actually exists for `sendPaidReceiptEmail` to attach).

  **Net result: the core inconsistency from v1 still exists, just narrower.**
  Deposit via PayFast on an accepted booking → `CONFIRMED` immediately. Deposit
  recorded manually on the same booking → stays at whatever it was. This is
  Gap 1 below, re-scoped, not closed.

- **New protections on the manual-payment route, both genuinely valuable, not present in v1:**
  - **Duplicate-payment guard (P2-5)**: rejects (409, `duplicate_warning: true`)
    if a completed PayFast transaction exists for the same booking within the
    last 2 hours, unless `force: true` is sent. Directly closes the
    "duplicate: both payfast and manual entries exist" risk flagged generically
    in the original master audit.
  - **No silent reduction (P2-4)**: attempting to *lower* `amount_paid` via this
    endpoint is now rejected outright — the response tells the admin to use a
    dedicated refund endpoint instead, to keep the ledger and audit trail
    correct.
  - **`alignMilestonePayments()`** is now called after every payment to
    reconcile `payment_schedules` rows — wasn't present in v1, worth testing
    directly (see test plan) since it's new and unread in this pass beyond its
    call site.

- **Receipting is now confirmed real on both paths**: `sendPaidReceiptEmail()`
  fires after a `PAID` status is reached, via both PayFast and manual payment.
  This resolves the "is receipting a distinct artifact" open question from the
  original master audit — it's an automated email triggered by full payment,
  not a separate manual step.

## 2. Non-negotiable constraints

- Do not re-flag the invoice VOID casing as a bug — it isn't one, per the changelog.
- Do not remove the new duplicate-payment guard, the no-reduction guard, or the `total_amount`-required ITN guard — all three are correct, deliberate safety additions.
- Any fix to the PayFast/manual status inconsistency (Gap 1) needs the same business decision flagged in v1: confirm with the project owner whether a deposit should confirm a booking, then make both paths agree — don't pick a side unilaterally.
- Do not change the contract-signing route's re-sign block.

## 3. Test plan — does Phase 3 work as documented?

| Case | Steps | Expected |
|---|---|---|
| Normal | Full payment via PayFast on an ACCEPTED booking | `CONFIRMED`, invoice marked `PAID`, receipt email sent |
| Normal | Full payment recorded manually on an ACCEPTED booking | Same outcome as PayFast — confirm parity here, since both now converge on `PAID` |
| **Critical — re-confirm the narrowed inconsistency** | Deposit via PayFast on an ACCEPTED booking | Confirm it still jumps to `CONFIRMED` immediately, per the `CASE` logic above |
| **Critical — compare** | Same deposit amount, recorded manually instead | Confirm status stays unchanged (not `CONFIRMED`) — this is the live discrepancy to resolve |
| **New — duplicate guard** | Record a PayFast payment, then attempt a manual payment entry within 2 hours without `force` | 409, `duplicate_warning: true` |
| **New — duplicate guard override** | Same, with `force: true` | Succeeds — confirm this is logged clearly enough to investigate later if misused |
| **New — no-reduction guard** | Attempt to manually set `amount_paid` lower than the current value | 400, told to use the refund endpoint — confirm that endpoint actually exists and was not part of this audit (locate and test separately if found) |
| **New — alignMilestonePayments** | Record a payment that covers exactly one of two `payment_schedules` milestones | Confirm the covered milestone's `status` updates to reflect payment, the other remains `pending` |
| **New — full payment with no prior acceptance** | Manually record `payment_status: PAID` on a booking still at `QUOTED` | Confirm it advances to `ACCEPTED` (not `CONFIRMED` directly, per the code) — then check whether an invoice exists for the receipt email to attach, since this path bypasses `generateInvoice()` |
| Edge | Re-upload a contract over one already marked `signed` | Confirm it still silently resets to `draft`/`is_frozen=0` (Gap 2 below) |
| Edge | Attempt to re-sign an already-signed contract | Confirmed blocked (400) — this one already works correctly |

## 4. Gaps to close

### Gap 1 (re-scoped from v1) — PayFast still confirms on deposit; manual still doesn't
See section 1 above for the precise current mechanics. Fix direction depends on
a business decision (does a deposit count as "confirmed" or not?) — once
decided, align both paths to the same rule.

### Gap 2 (carried forward) — Contract re-upload silently overwrites a signed contract
Unchanged from v1. The signing endpoint is safe; the upload endpoint isn't. Add
a check: if `status === 'signed'` and a new file is uploaded, either block it
or require explicit confirmation, and log the prior signed state to
`audit_log` either way.

### Gap 3 (new) — Manual full-payment-without-acceptance path may produce a receipt email with no invoice
Per the test plan above: `processManualPayment` doesn't call `generateInvoice()`.
If `sendPaidReceiptEmail()` expects an invoice file path to attach and none
exists, confirm what actually happens (broken attachment, blank receipt, or a
silent no-op) and fix accordingly — likely by calling `generateInvoice()` from
this path too when no invoice exists yet, mirroring the acceptance route.

## 5. Acceptance criteria

- [ ] PayFast and manual payment paths produce the same `bookings.status` outcome for the same `payment_status` value, per the resolved business decision
- [ ] Contract re-upload over a signed contract is blocked or explicitly confirmed, with the prior signed state preserved in `audit_log`
- [ ] Manual full-payment recording always results in a real invoice existing before the receipt email sends
- [ ] Duplicate-payment guard, no-reduction guard, and the ITN total-amount guard all remain in place and pass their tests

## 6. Test matrix (post-fix regression)

| Case | Expected after fix |
|---|---|
| Deposit via PayFast vs. deposit recorded manually | Same status outcome |
| Re-upload contract over signed one | Blocked, or proceeds with explicit confirmation + audit trail |
| Manual full payment with no prior acceptance | Invoice exists, receipt email attaches correctly |
| Duplicate-payment guard, no-reduction guard, ITN total guard | All unchanged, still passing |

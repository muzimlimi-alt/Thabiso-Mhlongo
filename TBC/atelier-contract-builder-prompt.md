# Atelier — Structured Contract Builder

**Feature:** Replace the upload-a-PDF contract step with an in-app clause-by-clause **Contract Builder** (parties · performance details · fee & payment · cancellation · force majeure · travel/hospitality · rights & recording · e-sign settings), generating the contract instead of uploading it — then reusing the existing e-signature flow unchanged.
**Scope:** Full-stack — `admin.html` (builder UI) + `server.js` (generate route) + a `pdfService.js` extension. **Zero** new tables (the schema already supports it).
**Read the primary gate first (§4 DG-C1): this feature is only worth building if contract volume justifies it. If the answer is "keep upload-and-sign," stop here — the current flow is fine.**
**Grounding:** All citations verified by direct audit. Do not infer — open the cited lines first.

---

## 0. PROMPT RULES
Standard Atelier rules apply: `--atl-*` tokens only (zero hardcoded hex); every `catch` → `notificationService.showError()` + `console.error()`; `apiCall()` (`admin.html:10310`) for authenticated fetches; new routes are `requireAdmin` (`server.js:1229`); no RBAC edits; idempotent migrations if any column is added. **Do not touch the e-signature flow** — the builder feeds into it, it does not change it.

---

## 1. FULL-STACK IMPACT ANALYSIS

| Layer | Impact | Detail |
|---|---|---|
| **Database** | **None** | The `contracts` table already carries `content_html`, `content_hash`, `template_version`, `pdf_url`, and all e-sign fields (`database.js:865+`). `content_html` exists but is currently unused (see C1). |
| **Backend / API** | **New generate route** | Add `POST /api/admin/bookings/:id/contract/generate` that assembles clauses → `content_html` → PDF → writes to `docs/contracts/` as `pdf_url`, mirroring what the upload route stores today. Existing sign/download/remind routes unchanged. |
| **Frontend** | **New builder UI** | Clause editor + template selector + preview, in the Deal View's Offer & Contract tab (or a modal). Adds a "Build contract" path alongside the existing "Upload contract." |
| **Security / RBAC** | **Untouched** | `requireAdmin` reused. |
| **External deps** | **Blocking (1)** | `pdfService.js` (not in mount) must render a `'Contract'` document type — see C4. |

---

## 2. CONFIRMED CURRENT-STATE FINDINGS (audit, cited)

- **C1 — `content_html` is dormant.** The contracts table has `content_html` (`database.js:869`), but the current `POST /contract` route only writes `pdf_url` from an uploaded file (`server.js:4274`, via `contractUpload.single('contract_file')` `:4259`). The builder makes `content_html` live — the column was clearly provisioned for exactly this.
- **C2 — E-signature infra is complete and reusable.** `PUT /contract/sign` (`server.js:4300`) captures `client_signature_data` + `client_ip_address`, sets `signed_by_client_at`, freezes (`is_frozen`), and hashes (`content_hash`). The builder **reuses this unchanged** — it only changes how the document is created, not how it's signed.
- **C3 — Download & remind operate on the file path.** `GET /contract/download` (`server.js:4346`) `res.download`s `pdf_url` from `docs/contracts/`; `POST /contract/remind` (`:4358`) nudges the client. The generated PDF **must be written to `docs/contracts/` as `pdf_url`** so both continue to work with no change.
- **C4 — `pdfService.js` not in the mount (blocking).** PDF generation uses `pdfService.generateDocument(type, booking, items, pdfPath)` (`server.js:924, 7107`). It must be extended for a `'Contract'` type that renders `content_html`. The route can be written against the known signature, but the render template inside `pdfService.js` cannot be specified until the file is provided. **DG-C2.**

---

## 3. NON-NEGOTIABLE CONSTRAINTS
- Do not modify the sign / download / remind routes or any e-sign field handling.
- Generated PDFs go to `docs/contracts/` and are stored as `pdf_url` exactly like uploads.
- Keep the **upload path available** — building is an addition, not a removal (some contracts will still arrive as external PDFs).
- Store the assembled `content_html` and compute `content_hash` at generate time (the sign route already hashes; keep them consistent).
- `--atl-*` tokens; both themes; `apiCall`; surfaced catches.

---

## 4. DECISION GATES

| ID | Decision | Options | Recommendation |
|---|---|---|---|
| **DG-C1** (go/no-go, decide first) | Build the Contract Builder at all? | A. Build the clause editor · B. Keep upload-and-sign | **Depends on volume.** Upload-and-sign already captures signature + IP + hash + freeze. Build **only if** you issue contracts often enough that manual PDF prep is a real bottleneck. If not, **B** — and skip the rest of this prompt. |
| **DG-C2** | PDF rendering (C4) | Extend `pdfService.js` for `'Contract'` · Defer | Extend once `pdfService.js` is provided; route ships against the known signature meanwhile. |
| **DG-C3** | Clause storage | A. Assembled `content_html` only · B. Structured clause records (a `contract_clauses` table) + rendered `content_html` | **A** to start (fastest, schema already fits); move to B only if you need per-clause reuse/versioning across contracts. |
| **DG-C4** | Template source | Hardcoded clause set · Editable templates in Branding/Policies admin | Start hardcoded; make editable later if clause wording changes often. |

The phases below assume DG-C1 = Build, DG-C3 = A.

---

## 5. PHASED TASKS

### Phase 1 — Backend generate route (`server.js`)
Add `POST /api/admin/bookings/:id/contract/generate` (`requireAdmin`):
1. Accept clause field values (parties, fee/payment terms, cancellation, force majeure, travel/hospitality, rights/recording, e-sign settings) + `template_version`.
2. Assemble `content_html` from the clause set (server-side, so the client can't inject markup that bypasses the template).
3. Compute `content_hash`.
4. Render via `pdfService.generateDocument('Contract', booking, contractData, pdfPath)` → write to `docs/contracts/` **[C4/DG-C2]**.
5. Upsert the contracts row (set `content_html`, `content_hash`, `template_version`, `pdf_url`, `status='draft'`), matching the existing upsert shape (`server.js:4274`).
Block if the contract is already `is_frozen` (signed) — never regenerate a signed contract.

### Phase 2 — Builder UI (`admin.html`)
In the Offer & Contract tab (Deal View) add a **Build contract** action opening a clause editor:
- Sections mirroring the source spec §6.4: Parties (pre-fill from booking client + `comedians` + `manager_details`) · Performance details (pre-fill from booking) · Fee & payment (pre-fill from the accepted quote) · Cancellation · Force majeure · Travel/hospitality · Rights & recording · Additional clauses · E-sign settings.
- Template selector (`template_version`) and a **Preview** (renders the generated PDF).
- Save/Generate via `apiCall`; on success, the existing contract card (send / download / remind) takes over.
Keep the existing **Upload** control beside it.

### Phase 3 — Wire to e-sign (no new work, verify only)
Confirm that after generate, the existing `POST /contract` send, `PUT /contract/sign`, `GET /contract/download`, and `POST /contract/remind` all operate on the generated `pdf_url` with **zero changes**.

---

## 6. ACCEPTANCE CRITERIA
- [ ] DG-C1 explicitly decided before any code.
- [ ] Building a contract assembles `content_html`, computes `content_hash`, generates a PDF to `docs/contracts/`, and stores `pdf_url` (once C4 provided).
- [ ] Clause sections pre-fill from booking / quote / `comedians` / `manager_details`.
- [ ] Preview renders the generated document.
- [ ] The existing send / sign / download / remind flow works unchanged on the generated PDF.
- [ ] A frozen (signed) contract cannot be regenerated.
- [ ] The upload path still works.
- [ ] `--atl-*` only; both themes; `apiCall`; catches surfaced.

---

## 7. TEST MATRIX
**Normal** — Accepted booking → build contract, sections pre-filled → preview → generate → send → client signs → download shows the signed PDF.
**Edge** — Missing quote (no fee to pre-fill) → fee section blank, still generates. · Very long clause text → PDF paginates. · Regenerate a draft (unsigned) → replaces cleanly. · Upload path used instead → unchanged behaviour.
**Failure** — `pdfService` throws (C4 not yet extended) → `notificationService.showError`, no partial `pdf_url`. · Attempt to regenerate a frozen contract → blocked with a clear message, signature untouched.
**Regression** — Sign / download / remind unaffected; existing Quote/Invoice PDF generation via `pdfService` unaffected by the new `'Contract'` type; `requireAdmin` unchanged.

---

## Appendix — anchor index
- Contract routes: get `server.js:4250` · **upload** `:4258` · **sign** `:4300` · download `:4346` · remind `:4358`
- Upload multer: `contractUpload` `server.js:4228`, write path `docs/contracts/`
- Contracts table: `database.js:865+` (`content_html:869`, `content_hash`, `template_version`, `pdf_url`, `is_frozen`, signature fields)
- PDF: `pdfService.generateDocument` `server.js:924, 7107` — **file not in mount (C4)**
- Pre-fill sources: `comedians` `database.js:586` · `manager_details` `database.js:323` · accepted quote
- Backend RBAC: `requireAdmin` `server.js:1229`

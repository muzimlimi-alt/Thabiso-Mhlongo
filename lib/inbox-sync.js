// Customer replies from the booking mailbox into the Inquiries conversation (Microsoft Graph, read-only; lib/m365-graph.js).
//
// Why this exists: a reply sent from Admin > Inquiries goes out with Reply-To = the shared mailbox, so the customer's answer lands in Outlook and
// nowhere else. This reads the Inbox through Graph delta query and attaches each answer to its inquiry, so the whole conversation is in one place.
//
// It is OFF until an administrator switches it on (and then only after a live check proves the app can read the inbox), and it is deliberately
// careful:
//   * READ-ONLY and pinned to the one configured mailbox (m365-graph.js); nothing is ever marked read, moved or deleted in Outlook.
//   * From now on only: the first run asks for messages received after the moment sync was enabled - the mailbox's history is never imported.
//   * Incremental and resumable: Graph's own checkpoint (deltaLink) is saved after every run; a run that is cut short saves the nextLink and carries on next time.
//   * Never stored twice: the RFC Message-ID and the Graph id are unique in inquiry_messages. A lost checkpoint (410) simply rescans, harmlessly.
//   * Never trusts a message's claim to belong to an inquiry: a [INQ-000123] tag only attaches the message when the SENDER is that inquiry's customer (or someone we
//     wrote to); otherwise it is treated as new mail. A stranger cannot write into someone else's conversation.
//   * Text only: bodies are requested and stored as plain text (never HTML from a stranger), bounded in size; attachments are not copied (a note says they exist).
//   * Our own mail (the intake notification arrives in this inbox too), drafts, out-of-office replies and delivery-failure notices are not customer messages. A delivery-failure
//     notice for one of our replies marks that reply 'bounced'.
//   * Polite: bounded pages per run, Retry-After honoured, exponential back-off after failures, one run at a time, nothing sensitive logged (counts only).
'use strict';
const db = require('../database');
const graph = require('./m365-graph');
const { decodeStoredText, normalizeEncodedText } = require('./html-sanitize');
const { idFromReference, isMailbox } = require('./contact-validation');

const DELTA_PATH = '/mailFolders/inbox/messages/delta';   // a saved nextLink / deltaLink is only ever followed together with this path (see m365-graph.js linkSearch)
const PAGE_SIZE = 25;
const MAX_PAGES_PER_RUN = 20;
const RUN_INTERVAL_MS = 2 * 60 * 1000;
const FIRST_RUN_MARGIN_MS = 15 * 60 * 1000;     // include mail that arrived just before the switch was flipped
const MAX_TEXT = 20000;
const SELECT = 'id,internetMessageId,subject,from,toRecipients,ccRecipients,receivedDateTime,body,hasAttachments,isDraft';

const dbGet = (sql, p = []) => new Promise((resolve, reject) => db.get(sql, p, (e, r) => e ? reject(e) : resolve(r)));
const dbAll = (sql, p = []) => new Promise((resolve, reject) => db.all(sql, p, (e, r) => e ? reject(e) : resolve(r)));
const dbRun = (sql, p = []) => new Promise((resolve, reject) => db.run(sql, p, function (e) { e ? reject(e) : resolve(this); }));

let running = false;

// ── state ────────────────────────────────────────────────────────────────────────────────────────────────────
const getState = () => dbGet('SELECT * FROM inbox_sync_state WHERE id = 1');
async function saveState(patch) {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    await dbRun(`UPDATE inbox_sync_state SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = 1`, keys.map((k) => patch[k]));
}

// What an API may show: no checkpoint URL, nothing from any message.
async function getStatus() {
    const s = await getState();
    let stats = null; try { stats = s.last_stats ? JSON.parse(s.last_stats) : null; } catch (e) { /* ignore */ }
    return {
        enabled: !!s.enabled, mailbox: s.mailbox || null, baselineAt: s.baseline_at, lastRunAt: s.last_run_at, lastSuccessAt: s.last_success_at,
        lastError: s.last_error, lastErrorCategory: s.last_error_category, consecutiveFailures: s.consecutive_failures, retryAfter: s.retry_after,
        lastStats: stats, hasCheckpoint: !!s.delta_link
    };
}

async function setEnabled(enabled, adminId) {
    const s = await getState();
    const patch = { enabled: enabled ? 1 : 0, enabled_by: adminId || null };
    if (enabled) { patch.retry_after = null; patch.consecutive_failures = 0; patch.last_error = null; patch.last_error_category = null; }
    await saveState(patch);
    return { before: !!s.enabled, after: !!enabled };
}

// ── pure helpers ─────────────────────────────────────────────────────────────────────────────────────────────
const lower = (v) => String(v || '').trim().toLowerCase();
const addr = (r) => lower(r && r.emailAddress && r.emailAddress.address);
const NDR_SENDER = /^(postmaster|mailer-daemon|microsoftexchange[0-9a-f]+)$/i;
const NDR_SUBJECT = /^\s*(undeliverable|delivery (status notification|has failed|failure)|mail delivery (failed|system failure)|returned mail|failure notice)/i;
const AUTO_SUBJECT = /^\s*(automatic reply|auto[- ]?reply|autoreply|out of office|abwesenheitsnotiz)/i;

function stripHtml(html) {
    return String(html || '')
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
        .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&amp;/g, '&');
}
const plainBody = (m) => {
    const b = m.body || {};
    const t = String(b.contentType || 'text').toLowerCase() === 'html' ? stripHtml(b.content) : String(b.content || '');
    return t.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\n{4,}/g, '\n\n\n').trim();
};

// The customer's new text without the quoted history underneath it. Conservative on purpose: if nothing would be left, or no marker is found, the whole text stays.
function stripQuotedReply(text) {
    const lines = text.split('\n');
    for (let i = 1; i < lines.length; i++) {
        const l = lines[i].trim();
        const next = (lines[i + 1] || '').trim();
        const marker =
            /^-{2,}\s*original message\s*-{2,}$/i.test(l) ||
            /^on .{5,200}wrote:$/i.test(l) || (/^on .{5,200}$/i.test(l) && /wrote:$/i.test(next)) ||
            (/^_{10,}$/.test(l) && /^from:/i.test(next)) ||
            (/^from:\s.+/i.test(l) && /^sent:\s.+/i.test(next));
        if (marker) {
            const kept = lines.slice(0, i).join('\n').trim();
            return kept.length ? kept : text;
        }
    }
    return text;
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function classify(m, mailbox) {
    const from = addr(m.from);
    const subject = String(m.subject || '');
    if (m.isDraft) return 'draft';
    if (!from || !isMailbox(from)) return 'no-sender';
    if (from === lower(mailbox)) return 'self';                                      // our own mail (e.g. the intake notification) lands here too
    if (NDR_SENDER.test(from.split('@')[0]) || NDR_SUBJECT.test(subject)) return 'ndr';
    if (AUTO_SUBJECT.test(subject)) return 'auto';
    return 'customer';
}

// ── matching ─────────────────────────────────────────────────────────────────────────────────────────────────
async function senderBelongsToInquiry(inquiry, from) {
    if (lower(decodeStoredText(inquiry.sender_email)) === from) return true;
    const rows = await dbAll(`SELECT to_addresses, cc_addresses FROM inquiry_messages WHERE inquiry_id = ? AND direction = 'out'`, [inquiry.inquiry_id]);
    return rows.some((r) => [r.to_addresses, r.cc_addresses].some((j) => { try { return JSON.parse(j || '[]').some((a) => lower(a) === from); } catch (e) { return false; } }));
}

// Returns { inquiry, how } or null. Never attaches on a tag alone.
async function matchInquiry(m, from) {
    const tag = /\[(INQ-\d{1,9})\]/i.exec(String(m.subject || ''));
    const id = tag ? idFromReference(tag[1]) : null;
    if (id) {
        const inquiry = await dbGet('SELECT inquiry_id, sender_email, status FROM inquiries WHERE inquiry_id = ?', [id]);
        if (inquiry && await senderBelongsToInquiry(inquiry, from)) return { inquiry, how: 'reference' };
    }
    // no usable tag: this sender's ONE open inquiry from the last 60 days (two or more is ambiguous - better a new inquiry than a wrong thread)
    const open = await dbAll(`SELECT inquiry_id, sender_email, status FROM inquiries WHERE LOWER(sender_email) = ? AND status <> 'archived' AND submitted_at > datetime('now', '-60 days') ORDER BY inquiry_id DESC LIMIT 2`, [from]);
    if (open.length === 1) return { inquiry: open[0], how: 'sender' };
    return null;
}

async function handleBounce(m, stats) {
    const hay = `${m.subject || ''}\n${plainBody(m)}`;
    const exact = /<(inq-(\d+)-[A-Za-z0-9-]+@[A-Za-z0-9.-]+)>/i.exec(hay);
    const tag = /\[INQ-(\d{1,9})\]/i.exec(hay);
    const inquiryId = exact ? Number(exact[2]) : (tag ? Number(tag[1]) : null);
    if (!inquiryId) { stats.ignored.ndr_unmatched++; return; }
    const reasonMatch = /(?:^|\n)\s*((?:4|5)\d\d[ -]?\d?\.?\d?\.?\d?[^\n]{0,200})/.exec(plainBody(m));
    const reason = clip(reasonMatch ? reasonMatch[1].trim() : 'A delivery-failure notice came back for this reply.', 480);
    const target = exact
        ? await dbGet(`SELECT id FROM inquiry_messages WHERE inquiry_id = ? AND direction = 'out' AND message_id = ?`, [inquiryId, `<${exact[1]}>`])
        : await dbGet(`SELECT id FROM inquiry_messages WHERE inquiry_id = ? AND direction = 'out' AND delivery_status IN ('accepted', 'bounced') ORDER BY id DESC LIMIT 1`, [inquiryId]);
    if (!target) { stats.ignored.ndr_unmatched++; return; }
    const r = await dbRun(`UPDATE inquiry_messages SET delivery_status = 'bounced', last_error = ? WHERE id = ? AND delivery_status = 'accepted'`, [reason, target.id]);
    if (r.changes) stats.bounces++;
}

// ── importing one message ────────────────────────────────────────────────────────────────────────────────────
async function ingest(m, mailbox, stats) {
    const kind = classify(m, mailbox);
    if (kind === 'ndr') return handleBounce(m, stats);
    if (kind !== 'customer') { stats.ignored[kind === 'no-sender' ? 'no_sender' : kind]++; return; }

    const graphId = m.id, rfcId = m.internetMessageId || null;
    const dup = await dbGet('SELECT id FROM inquiry_messages WHERE graph_id = ? OR (message_id IS NOT NULL AND message_id = ?)', [graphId || null, rfcId]);
    if (dup) { stats.ignored.duplicate++; return; }

    const from = addr(m.from);
    const senderName = clip(oneLine((m.from.emailAddress && m.from.emailAddress.name) || '') || from.split('@')[0], 100);
    const subject = clip(oneLine(m.subject || '') || '(no subject)', 150);
    let text = stripQuotedReply(plainBody(m));
    if (m.hasAttachments) text += '\n\n[This email had attachments. Open it in Outlook to see them.]';
    text = clip(text || '(empty message)', MAX_TEXT);
    const when = m.receivedDateTime ? new Date(m.receivedDateTime).toISOString().replace('T', ' ').slice(0, 19) : null;
    const toList = (m.toRecipients || []).map(addr).filter(Boolean);
    const ccList = (m.ccRecipients || []).map(addr).filter(Boolean);

    const match = await matchInquiry(m, from);
    let inquiryId, origin = false;
    if (match) {
        inquiryId = match.inquiry.inquiry_id;
    } else {
        // new mail with no inquiry to attach to: it becomes an inquiry (source 'email'). The text is the inquiry's body, so the conversation row carries none.
        const r = await dbRun(`INSERT INTO inquiries (sender_name, sender_email, receiver_email, category, subject, message_body, status, routing_path, source, submitted_at)
                               VALUES (?, ?, ?, 'Email', ?, ?, 'unread', 'mailbox', 'email', COALESCE(?, CURRENT_TIMESTAMP))`,
            [normalizeEncodedText(senderName), from, mailbox, normalizeEncodedText(subject), normalizeEncodedText(clip(text, 5000)), when]);
        inquiryId = r.lastID;
        origin = true;
    }
    try {
        await dbRun(`INSERT INTO inquiry_messages (inquiry_id, direction, source, message_id, graph_id, from_address, to_addresses, cc_addresses, subject, body_text, delivery_status, occurred_at)
                     VALUES (?, 'in', 'mailbox', ?, ?, ?, ?, ?, ?, ?, 'received', COALESCE(?, CURRENT_TIMESTAMP))`,
            [inquiryId, rfcId, graphId || null, from, JSON.stringify(toList), JSON.stringify(ccList), subject, origin ? null : text, when]);
    } catch (e) {
        if (origin) await dbRun('DELETE FROM inquiries WHERE inquiry_id = ?', [inquiryId]).catch(() => {});
        if (/UNIQUE|constraint/i.test(e.message)) { stats.ignored.duplicate++; return; }
        throw e;
    }
    if (origin) { stats.new_inquiries++; return; }
    // a customer wrote again: the inquiry needs attention (an archived one is reopened too)
    await dbRun(`UPDATE inquiries SET status = 'unread', updated_by = NULL, updated_by_role = 'system', updated_at = CURRENT_TIMESTAMP WHERE inquiry_id = ? AND status <> 'unread'`, [inquiryId]);
    stats.replies++;
}
const oneLine = (s) => String(s).replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();

// ── one run ──────────────────────────────────────────────────────────────────────────────────────────────────
const newStats = () => ({ pages: 0, seen: 0, replies: 0, new_inquiries: 0, bounces: 0, ignored: { self: 0, auto: 0, draft: 0, duplicate: 0, no_sender: 0, ndr_unmatched: 0, removed: 0 } });

async function failRun(state, category, message, systemic, throttled) {
    const n = (state.consecutive_failures || 0) + 1;
    const waitMin = throttled ? 5 : systemic ? 15 : Math.min(60, Math.pow(2, Math.min(n, 5)));
    await saveState({
        last_run_at: new Date().toISOString(), last_error: String(message).slice(0, 480), last_error_category: category,
        consecutive_failures: n, retry_after: new Date(Date.now() + waitMin * 60000).toISOString()
    });
    return { ok: false, category, error: message };
}

/**
 * One sync run. force = ignore the enabled switch and the back-off (the administrator's "Sync now"). deps (tests only): { resolveContext, graphGet }.
 * Resolves { ok, stats } or { ok:false, category, error } or { ok:true, skipped } - never throws.
 */
async function runSync({ force = false, deps = {} } = {}) {
    if (running) return { ok: true, skipped: 'a sync is already running' };
    running = true;
    try {
        let state = await getState();
        if (!force && !state.enabled) return { ok: true, skipped: 'sync is switched off' };
        const resolveContext = deps.resolveContext || graph.resolveContext;
        const graphGet = deps.graphGet || graph.graphGet;

        const r = await resolveContext();
        if (!r.ok) return await failRun(state, 'config', r.message, true, false);
        const ctx = r.ctx;

        // the checkpoint belongs to one mailbox
        if (state.mailbox && state.mailbox !== ctx.mailbox) { await saveState({ delta_link: null, baseline_at: null }); state = await getState(); }
        if (state.mailbox !== ctx.mailbox) await saveState({ mailbox: ctx.mailbox });

        const stats = newStats();
        let request;
        if (state.delta_link) {
            request = { url: state.delta_link, path: DELTA_PATH };
        } else {
            const since = state.baseline_at || new Date(Date.now() - FIRST_RUN_MARGIN_MS).toISOString();
            if (!state.baseline_at) await saveState({ baseline_at: since });
            request = { path: DELTA_PATH, query: { $select: SELECT, $filter: `receivedDateTime ge ${since}`, $orderby: 'receivedDateTime desc' } };
        }
        const headers = { Prefer: 'odata.maxpagesize=' + PAGE_SIZE + ', outlook.body-content-type="text"' };

        let checkpoint = null;
        for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
            const res = await graphGet(ctx, { ...request, headers });
            if (!res.ok) {
                if (res.category === 'resync') {   // Microsoft dropped the checkpoint: rescan from the baseline (duplicates are impossible - ids are unique)
                    await saveState({ delta_link: null, last_run_at: new Date().toISOString(), last_error: res.message, last_error_category: 'resync' });
                    return { ok: false, category: 'resync', error: res.message, stats };
                }
                const out = await failRun(state, res.category, res.message, !!res.systemic, res.category === 'throttled');
                return { ...out, stats };
            }
            stats.pages++;
            for (const m of (res.json && res.json.value) || []) {
                stats.seen++;
                if (m['@removed']) { stats.ignored.removed++; continue; }
                try { await ingest(m, ctx.mailbox, stats); }
                catch (e) { console.error('[inbox-sync] one message could not be stored:', e.message); }   // never log the message itself
            }
            const j = res.json || {};
            if (j['@odata.deltaLink']) { checkpoint = j['@odata.deltaLink']; break; }
            if (!j['@odata.nextLink']) break;
            checkpoint = j['@odata.nextLink'];            // if the page budget runs out, the next run continues from here
            request = { url: j['@odata.nextLink'], path: DELTA_PATH };
        }
        await saveState({
            delta_link: checkpoint || state.delta_link, last_run_at: new Date().toISOString(), last_success_at: new Date().toISOString(),
            last_error: null, last_error_category: null, consecutive_failures: 0, retry_after: null, last_stats: JSON.stringify(stats)
        });
        if (stats.replies || stats.new_inquiries || stats.bounces) console.log(`[inbox-sync] ${stats.replies} repl${stats.replies === 1 ? 'y' : 'ies'}, ${stats.new_inquiries} new inquir${stats.new_inquiries === 1 ? 'y' : 'ies'}, ${stats.bounces} bounce(s) from ${stats.seen} message(s)`);
        return { ok: true, stats };
    } catch (e) {
        console.error('[inbox-sync] run failed:', e.message);
        try { return await failRun(await getState(), 'internal', 'The sync hit an unexpected problem.', false, false); } catch (e2) { return { ok: false, category: 'internal', error: 'The sync hit an unexpected problem.' }; }
    } finally {
        running = false;
    }
}

// The scheduler's entry point (lib/background-clerk.js): cheap when switched off.
async function runIfDue() {
    const s = await getState().catch(() => null);
    if (!s || !s.enabled) return null;
    if (s.retry_after && Date.now() < Date.parse(s.retry_after)) return null;
    if (s.last_run_at && Date.now() - Date.parse(s.last_run_at) < RUN_INTERVAL_MS) return null;
    return runSync();
}

module.exports = { runSync, runIfDue, getStatus, setEnabled, classify, stripQuotedReply, plainBody, matchInquiry, RUN_INTERVAL_MS };

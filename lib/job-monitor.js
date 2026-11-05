// Business Activity & Alert Management System - scheduled-job monitoring (docs-internal/notifications.md).
//
// Before this, ~20 background jobs logged failures to the console and nothing noticed a job that had silently stopped. Now every job is wrapped:
//
//     const run = jobMonitor.monitored('ledger-reconciliation', 'Nightly ledger check', 24 * 3600e3, runLedgerReconciliationJob);
//     setInterval(() => run().catch(...), 24 * 3600e3);      // the wrapper re-throws, so the existing .catch / logging is unchanged
//
// Every run stamps job_heartbeats (last_run_at / last_success_at / consecutive_failures / last_error). A failure raises ONE grouped
// system.job_failed incident (a repeat only bumps its count); a success resolves it. A watchdog (started by the first registration, unref'd)
// raises system.job_missed when a job has not run for twice its interval - the "detection of missed or failed scheduled tasks" - and clears it
// when the job runs again. For callback-style jobs that cannot be wrapped, call beat(name, label, intervalMs) when a run completes.

const { dbRun, dbGet, dbAll } = require('./db-helpers');
const notify = require('./notify');

const nowIso = () => new Date().toISOString();
const JOBS = new Map();           // name -> { label, intervalMs }
const WATCHDOG_MS = 5 * 60 * 1000;
const GRACE_MS = 2 * 60 * 1000;
let watchdog = null;

function safe(promise) { return Promise.resolve(promise).catch((err) => { console.error(`[job-monitor] ${err && err.message}`); }); }

// Jobs register at module load, while database.js is still creating tables (its serialize() queue is not awaited by anyone), so every write
// waits until job_heartbeats exists - otherwise the first heartbeats of a fresh boot are silently lost.
let readyPromise = null;
function ready() {
    if (!readyPromise) {
        readyPromise = (async () => {
            for (let i = 0; i < 150; i++) {
                const ok = await dbGet("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'job_heartbeats'").catch(() => null);
                if (ok) return true;
                await new Promise((r) => setTimeout(r, 200));
            }
            return false;
        })();
    }
    return readyPromise;
}
const dbRunReady = async (sql, params) => { await ready(); return dbRun(sql, params); };

function register(name, label, intervalMs) {
    JOBS.set(name, { label, intervalMs });
    safe(dbRunReady(
        `INSERT INTO job_heartbeats (job_name, expected_interval_s, started_at) VALUES (?, ?, ?)
         ON CONFLICT(job_name) DO UPDATE SET expected_interval_s = excluded.expected_interval_s, started_at = excluded.started_at`,
        [name, Math.max(1, Math.round(intervalMs / 1000)), nowIso()]));
    if (!watchdog) {
        watchdog = setInterval(() => safe(checkMissed()), WATCHDOG_MS);
        if (watchdog.unref) watchdog.unref();
    }
}

async function started(name) {
    await safe(dbRunReady('UPDATE job_heartbeats SET last_run_at = ? WHERE job_name = ?', [nowIso(), name]));
}

async function succeeded(name) {
    await safe((async () => {
        const row = await dbGet('SELECT consecutive_failures, missed_alerted_at FROM job_heartbeats WHERE job_name = ?', [name]);
        await dbRun('UPDATE job_heartbeats SET last_success_at = ?, consecutive_failures = 0, missed_alerted_at = NULL WHERE job_name = ?', [nowIso(), name]);
        if (row && row.consecutive_failures > 0) await notify.resolve('system.job_failed', { key: `jobfail:${name}` }, { note: 'The task ran successfully again.' });
        if (row && row.missed_alerted_at) await notify.resolve('system.job_missed', { key: `jobmissed:${name}` }, { note: 'The task is running again.' });
    })());
}

async function failed(name, err) {
    await safe((async () => {
        const message = String(notify.sanitize(String((err && err.message) || err || 'unknown error')));
        await dbRun(
            `UPDATE job_heartbeats SET consecutive_failures = consecutive_failures + 1, last_error = ?, last_error_at = ? WHERE job_name = ?`,
            [message, nowIso(), name]);
        const row = await dbGet('SELECT consecutive_failures FROM job_heartbeats WHERE job_name = ?', [name]);
        const job = JOBS.get(name) || {};
        await notify.emit('system.job_failed', { job: name, label: job.label || name, failures: row ? row.consecutive_failures : 1, error: message }, {});
    })());
}

// Wrap a job function. Behaviour is unchanged: the result is returned and any error is re-thrown to the caller's existing handling.
function monitored(name, label, intervalMs, fn) {
    register(name, label, intervalMs);
    return async function monitoredRun(...args) {
        await started(name);
        try {
            const out = await fn.apply(this, args);
            await succeeded(name);
            return out;
        } catch (err) {
            await failed(name, err);
            throw err;
        }
    };
}

// For jobs that finish through callbacks: stamp a completed run (ok = false records a failure with `err`).
async function beat(name, label, intervalMs, ok = true, err = null) {
    if (!JOBS.has(name)) register(name, label, intervalMs);
    await started(name);
    if (ok) await succeeded(name); else await failed(name, err);
}

function ago(ms) {
    const m = Math.round(ms / 60000);
    if (m < 90) return `${m} minute(s) ago`;
    const h = Math.round(m / 60);
    return h < 48 ? `${h} hour(s) ago` : `${Math.round(h / 24)} day(s) ago`;
}

// A job is "missed" when neither its last run nor this process's start is within 2 intervals (+ grace). Counting the process start means a
// redeploy never raises a false alarm for a daily job that has not come due yet.
async function checkMissed(now = Date.now()) {
    const rows = await dbAll('SELECT * FROM job_heartbeats');
    let raised = 0;
    for (const r of rows) {
        const ref = Math.max(Date.parse(r.last_run_at || 0) || 0, Date.parse(r.started_at || 0) || 0);
        if (!ref) continue;
        const age = now - ref;
        const limit = r.expected_interval_s * 1000 * 2 + GRACE_MS;
        if (age > limit && !r.missed_alerted_at) {
            await dbRun('UPDATE job_heartbeats SET missed_alerted_at = ? WHERE job_name = ?', [nowIso(), r.job_name]);
            const job = JOBS.get(r.job_name) || {};
            await notify.emit('system.job_missed', { job: r.job_name, label: job.label || r.job_name, expectedMinutes: Math.round(r.expected_interval_s / 60), lastRunAgo: ago(age) }, {});
            raised++;
        }
    }
    return raised;
}

// ── health snapshot for the Security & Audit → System Integrity panel ──────────────────────────────────────────────────────────────
async function health(now = Date.now()) {
    const rows = await dbAll('SELECT * FROM job_heartbeats ORDER BY job_name');
    const jobs = rows.map((r) => {
        const job = JOBS.get(r.job_name) || {};
        const ref = Math.max(Date.parse(r.last_run_at || 0) || 0, Date.parse(r.started_at || 0) || 0);
        const limit = r.expected_interval_s * 1000 * 2 + GRACE_MS;
        let status = 'ok';
        if (r.consecutive_failures > 0) status = 'failing';
        else if (ref && now - ref > limit) status = 'stale';
        else if (!r.last_run_at) status = 'waiting';
        return {
            name: r.job_name, label: job.label || r.job_name, status, expected_interval_s: r.expected_interval_s, last_run_at: r.last_run_at, last_success_at: r.last_success_at,
            last_error: r.last_error, last_error_at: r.last_error_at, consecutive_failures: r.consecutive_failures
        };
    });
    const one = (sql, p = []) => dbGet(sql, p).catch(() => null);
    const queue = await one(`SELECT SUM(status = 'pending') AS pending, SUM(status = 'failed' AND created_at >= datetime('now','-7 days')) AS failed_7d, MIN(CASE WHEN status = 'pending' THEN created_at END) AS oldest_pending FROM notifications WHERE channel = 'email'`);
    const open = await one(`SELECT SUM(priority = 'critical') AS critical, SUM(priority = 'high') AS high, COUNT(*) AS total FROM admin_notifications WHERE status IN ('open','acknowledged')`);
    const payfast = await one('SELECT last_run_at, last_success_at, consecutive_failures, last_error FROM payfast_reconcile_state WHERE id = 1');
    const inbox = await one('SELECT enabled, last_run_at, last_success_at, consecutive_failures, last_error FROM inbox_sync_state WHERE id = 1');
    const bad = jobs.filter((j) => j.status === 'failing' || j.status === 'stale').length;
    return {
        generated_at: nowIso(), overall: (open && open.critical) || bad ? 'attention' : 'ok', jobs,
        email_queue: { pending: (queue && queue.pending) || 0, failed_last_7_days: (queue && queue.failed_7d) || 0, oldest_pending_at: queue && queue.oldest_pending },
        open_alerts: { critical: (open && open.critical) || 0, high: (open && open.high) || 0, total: (open && open.total) || 0 },
        integrations: { payfast_safety_net: payfast || null, inbox_sync: inbox || null }
    };
}

module.exports = { monitored, beat, register, checkMissed, health, _JOBS: JOBS };

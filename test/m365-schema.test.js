// Schema, constraints and migration safety for the Contact/Inquiries <-> Microsoft 365 work (Phase 6): the tables/columns/indexes exist, the
// database itself refuses impossible states (direction vs delivery state, duplicate message ids, a second sync row), foreign keys cascade or
// null correctly, and booting the server again on the same database (migrations run at every boot) changes nothing.
const sqlite3 = require('sqlite3');
const support = require('./support');

// A write connection with foreign keys ON (the app's own connection has them on; a bare sqlite3 handle does not).
function withDb(fn) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(support.TEST_DB);
        const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));
        const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));
        db.serialize(async () => {
            try { await run('PRAGMA foreign_keys = ON'); resolve(await fn({ run, all })); } catch (e) { reject(e); } finally { db.close(); }
        });
    });
}
const refuses = async (run, sql, p, re) => { try { await run(sql, p); return false; } catch (e) { return re ? re.test(e.message) : true; } };

module.exports = async function ({ check, q, one, restart, api }) {
    const objects = async () => ({
        tables: (await q("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('inquiry_messages', 'inbox_sync_state')")).map((r) => r.name).sort(),
        indexes: (await q("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE '%inquiry_messages%'")).map((r) => r.name).sort(),
        inqCols: (await q('PRAGMA table_info(inquiries)')).map((c) => c.name),
        deCols: (await q('PRAGMA table_info(direct_emails)')).map((c) => c.name),
        migrations: (await q('SELECT version, name FROM schema_migrations WHERE version IN (102, 103, 104) ORDER BY version')),
        syncRows: (await one('SELECT COUNT(*) AS n FROM inbox_sync_state')).n
    });
    const before = await objects();
    check('the new tables exist (inquiry_messages, inbox_sync_state)', before.tables.join() === 'inbox_sync_state,inquiry_messages', before.tables.join());
    check('their indexes exist, including the two UNIQUE ones that make double-storing a message impossible', ['idx_inquiry_messages_inquiry', 'idx_inquiry_messages_notification', 'idx_inquiry_messages_pending', 'uq_inquiry_messages_graph_id', 'uq_inquiry_messages_message_id'].every((i) => before.indexes.includes(i)), before.indexes.join());
    check('the additive columns exist (inquiries.source, direct_emails.created_by) - no existing column was changed', before.inqCols.includes('source') && before.deCols.includes('created_by') && ['inquiry_id', 'sender_name', 'sender_email', 'message_body', 'status', 'responded_at', 'converted_booking_id'].every((c) => before.inqCols.includes(c)), before.inqCols.join());
    check('migrations 102, 103 and 104 are recorded exactly once', before.migrations.length === 3, JSON.stringify(before.migrations));
    check('the sync state is a single row, off by default', before.syncRows === 1 && (await one('SELECT enabled FROM inbox_sync_state WHERE id = 1')).enabled === 0, '');

    // the database itself refuses impossible states
    const inq = (await withDb(async ({ run }) => (await run("INSERT INTO inquiries (sender_name, sender_email, category, subject, message_body, status) VALUES ('Schema Test', 'schema.test@example.invalid', 'General Inquiry', 's', 'a message body', 'unread')")).lastID));
    const insertMsg = (cols) => `INSERT INTO inquiry_messages (inquiry_id, ${cols}) VALUES (${inq}, `;
    await withDb(async ({ run, all }) => {
        check('an outbound message cannot be "received" and an inbound one cannot be "queued/accepted" (CHECK)', await refuses(run, insertMsg('direction, delivery_status') + "'out', 'received')", [], /CHECK/i) && await refuses(run, insertMsg('direction, source, delivery_status') + "'in', 'mailbox', 'accepted')", [], /CHECK/i), '');
        check('direction, source and delivery_status only accept their documented values', await refuses(run, insertMsg('direction, delivery_status') + "'sideways', 'queued')", [], /CHECK/i) && await refuses(run, insertMsg('direction, delivery_status') + "'out', 'confirmed')", [], /CHECK/i) && await refuses(run, insertMsg('direction, source, delivery_status') + "'in', 'carrier-pigeon', 'received')", [], /CHECK/i), '');
        await run(insertMsg('direction, source, message_id, graph_id, delivery_status') + "'in', 'mailbox', '<one@x.test>', 'g-1', 'received')");
        check('the same RFC Message-ID cannot be stored twice (UNIQUE)', await refuses(run, insertMsg('direction, source, message_id, delivery_status') + "'in', 'mailbox', '<one@x.test>', 'received')", [], /UNIQUE/i), '');
        check('the same Graph id cannot be stored twice (UNIQUE)', await refuses(run, insertMsg('direction, source, graph_id, delivery_status') + "'in', 'mailbox', 'g-1', 'received')", [], /UNIQUE/i), '');
        await run(insertMsg('direction, delivery_status') + "'out', 'queued')"); await run(insertMsg('direction, delivery_status') + "'out', 'queued')");
        check('messages without an id (not sent yet) may repeat - uniqueness applies to real ids only', (await all('SELECT COUNT(*) AS n FROM inquiry_messages WHERE inquiry_id = ? AND message_id IS NULL', [inq]))[0].n === 2, '');
        check('a message must belong to an inquiry that exists (FK)', await refuses(run, "INSERT INTO inquiry_messages (inquiry_id, direction, delivery_status) VALUES (987654321, 'out', 'queued')", [], /FOREIGN KEY/i), '');
        check('inbox_sync_state refuses a second row and a non-boolean switch (CHECK)', await refuses(run, 'INSERT INTO inbox_sync_state (id) VALUES (2)', [], /CHECK/i) && await refuses(run, 'UPDATE inbox_sync_state SET enabled = 2 WHERE id = 1', [], /CHECK/i), '');

        // foreign-key behaviour: outbox row deleted -> link nulled, message kept; inquiry deleted -> its conversation goes with it
        const note = (await run("INSERT INTO notifications (type, channel, status, recipient_email, subject, body) VALUES ('email', 'email', 'pending', 'fk.test@example.invalid', 's', '{}')")).lastID;
        const linked = (await run(insertMsg('direction, delivery_status, notification_id') + `'out', 'queued', ${note})`)).lastID;
        await run('DELETE FROM notifications WHERE id = ?', [note]);
        const afterNote = (await all('SELECT notification_id FROM inquiry_messages WHERE id = ?', [linked]))[0];
        check('deleting an outbox row keeps the conversation message and nulls the link (ON DELETE SET NULL)', !!afterNote && afterNote.notification_id === null, JSON.stringify(afterNote));
        await run('DELETE FROM inquiries WHERE inquiry_id = ?', [inq]);
        check('deleting an inquiry deletes its conversation (ON DELETE CASCADE)', (await all('SELECT COUNT(*) AS n FROM inquiry_messages WHERE inquiry_id = ?', [inq]))[0].n === 0, '');
    });

    // query plans use the indexes (a thread read and the outbox link must not scan)
    const plan = (sql, p) => q('EXPLAIN QUERY PLAN ' + sql, p).then((r) => r.map((x) => x.detail).join(' | '));
    const planThread = await plan('SELECT * FROM inquiry_messages WHERE inquiry_id = ? ORDER BY occurred_at ASC, id ASC', [1]);
    const planIntake = await plan("SELECT * FROM notifications WHERE related_id = ? AND related_entity IN ('inquiry_intake', 'inquiry_receipt')", [1]);
    const planDup = await plan('SELECT id FROM inquiry_messages WHERE graph_id = ? OR (message_id IS NOT NULL AND message_id = ?)', ['g', '<m>']);
    check('reading a conversation uses its index', /idx_inquiry_messages_inquiry/.test(planThread), planThread);
    check('finding an inquiry\'s intake mails uses the existing (related_entity, related_id) index', /idx_notifications_entity/.test(planIntake), planIntake);
    check('the duplicate check on an incoming message uses the unique indexes (no table scan)', /uq_inquiry_messages_(graph|message)_id/.test(planDup) && !/SCAN inquiry_messages(?! USING)/i.test(planDup), planDup);

    // migrations run at every boot: starting the server again on the same database changes nothing
    const seed = await withDb(async ({ run }) => (await run("INSERT INTO inquiries (sender_name, sender_email, category, subject, message_body, status) VALUES ('Boot Test', 'boot.test@example.invalid', 'General Inquiry', 's', 'a message body', 'read')")).lastID);
    await withDb(async ({ run }) => run("INSERT INTO inquiry_messages (inquiry_id, direction, source, message_id, delivery_status, subject) VALUES (?, 'out', 'admin_reply', '<boot-test@x.test>', 'accepted', 'kept across restarts')", [seed]));
    await restart();
    const after = await objects();
    check('booting again on the same database leaves the schema identical (no duplicate migration rows, one sync row, same indexes and columns)', JSON.stringify(after) === JSON.stringify(before), JSON.stringify({ before, after }));
    check('...and keeps existing conversation data', !!(await one("SELECT 1 AS x FROM inquiry_messages WHERE message_id = '<boot-test@x.test>' AND subject = 'kept across restarts'")), '');
    const fk = (await q('PRAGMA foreign_key_check')).filter((r) => ['inquiry_messages', 'inbox_sync_state'].includes(r.table));
    check('no foreign-key violations in the new tables', fk.length === 0, JSON.stringify(fk));
    const integrity = await q('PRAGMA integrity_check');
    check('the database passes its integrity check after the restart', integrity.length === 1 && integrity[0].integrity_check === 'ok', JSON.stringify(integrity));
    const alive = await api('GET', `/api/admin/inquiries/${seed}/messages`);
    check('the server is serving the new endpoints after the restart', alive.status === 200 && alive.body.messages.length === 1, JSON.stringify(alive.body));
};

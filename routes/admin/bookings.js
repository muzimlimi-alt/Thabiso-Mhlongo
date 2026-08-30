const express = require('express');
const db = require('../../database');
const { requireAdmin } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const {
    getBookingNotesForBooking, insertBookingNote, getBookingNoteById, deleteBookingNote,
    unlinkBookingClient
} = require('../../database/repositories/bookings.repository');
const { getQuoteHistoryForBooking, getQuoteForBookingFinancials, getInvoiceForBookingFinancials } = require('../../database/repositories/invoices-quotations.repository');
const { getExpensesForBooking, getCancellationDetailForBooking, getTransactionsForBooking } = require('../../database/repositories/finance.repository');
const router = express.Router();

// Gap 10: GET — fetch outgoing communication log for a booking
router.get('/api/admin/bookings/:id/communications', requireAdmin, (req, res) => {
    db.all(
        `SELECT id, direction, channel, subject, content_snippet, sent_at, created_at
         FROM communication_log WHERE booking_id = ? ORDER BY created_at DESC LIMIT 50`,
        [req.params.id],
        (err, rows) => res.json({ success: !err, logs: rows || [] })
    );
});

// Unlink a booking from its client record so COALESCE falls back to the booking's own name/email.
// Use when client_id was incorrectly assigned (e.g. email collision in findOrCreateClient).
router.post('/api/admin/bookings/:id/unlink-client', requireAdmin, (req, res) => {
    unlinkBookingClient(req.params.id, function(err) {
        if (err) return res.status(500).json({ success: false, error: err.message });
        if (this.changes === 0) return res.status(404).json({ success: false, message: 'Booking not found.' });
        res.json({ success: true, message: `client_id cleared for booking #${req.params.id}` });
    });
});

// S5-4: Threaded booking notes — replaces the single admin_notes text blob.
router.get('/api/admin/bookings/:id/notes', requireAdmin, (req, res) => {
    getBookingNotesForBooking(
        req.params.id,
        (err, rows) => {
            if (err) return res.status(500).json({ success: false, error: err.message });
            res.json({ success: true, notes: rows || [] });
        }
    );
});

router.post('/api/admin/bookings/:id/notes', requireAdmin, (req, res) => {
    const { note, author } = req.body;
    if (!note || !note.trim()) return res.status(400).json({ success: false, message: 'Note text is required.' });
    insertBookingNote(
        req.params.id, note.trim(), (author || 'Admin').trim(),
        function(err) {
            if (err) return res.status(500).json({ success: false, error: err.message });
            getBookingNoteById(this.lastID, (e, row) => {
                res.json({ success: true, note: row });
            });
        }
    );
});

router.delete('/api/admin/bookings/:id/notes/:noteId', requireAdmin, (req, res) => {
    deleteBookingNote(
        req.params.noteId, req.params.id,
        function(err) {
            if (err) return res.status(500).json({ success: false, error: err.message });
            if (this.changes === 0) return res.status(404).json({ success: false, message: 'Note not found.' });
            res.json({ success: true });
        }
    );
});

// --- Booking Line Items + Transactions (lazy detail) ---
router.get('/api/admin/bookings/:id/details', requireAdmin, (req, res) => {
    const id = req.params.id;
    // Prefer booking_services if available, fallback to booking_line_items for legacy data
    db.all(`SELECT bs.*, bs.quantity_minutes as quantity, s.name as service_name, s.display_unit 
            FROM booking_services bs 
            LEFT JOIN services s ON bs.service_id = s.id 
            WHERE bs.booking_id = ?`, [id], (e1, servicesItems) => {
        
        getCancellationDetailForBooking(id, (e3, cancellation) => {
            const sendResponse = (items, txs) => {
                res.json({
                    line_items: items || [],
                    transactions: txs || [],
                    cancellation: cancellation || null
                });
            };

            if (servicesItems && servicesItems.length > 0) {
                getTransactionsForBooking(id, (e2, transactions) => {
                    sendResponse(servicesItems, transactions);
                });
            } else {
                // Legacy fallback
                db.all("SELECT bli.*, s.name as service_name FROM booking_line_items bli LEFT JOIN services s ON bli.service_id = s.id WHERE bli.booking_id = ?", [id], (e1, lineItems) => {
                    getTransactionsForBooking(id, (e2, transactions) => {
                        sendResponse(lineItems, transactions);
                    });
                });
            }
        });
    });
});

router.get('/api/admin/bookings/:id/quote-history', requireAdmin, (req, res) => {
    getQuoteHistoryForBooking(
        req.params.id, (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json((rows || []).map(r => ({
                ...r,
                pdf_url: r.file_path ? `/docs/quotes/${r.file_path}` : null
            })));
        }
    );
});

// GET /api/admin/bookings/:id/expenses — expenses for a specific booking + P&L
router.get('/api/admin/bookings/:id/expenses', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const bookingId = req.params.id;
    getExpensesForBooking(bookingId, (err, expenses) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        const totalExpenses = (expenses || []).reduce((sum, e) => sum + parseFloat(e.amount || 0), 0);
        // Fetch the booking's quote total for P&L
        db.get(
            `SELECT COALESCE(q.total, b.total_amount, 0) AS gross
             FROM bookings b
             LEFT JOIN quotations q ON q.booking_id = b.id
             WHERE b.id = ?
             ORDER BY q.created_at DESC LIMIT 1`,
            [bookingId], (e2, fin) => {
                const gross = fin ? parseFloat(fin.gross || 0) : 0;
                res.json({
                    success: true,
                    expenses: expenses || [],
                    total_expenses: totalExpenses,
                    gross_revenue: gross,
                    net_profit: gross - totalExpenses
                });
            }
        );
    });
});

// 5. Booking-Specific Financial Details (Admin)

router.get('/api/admin/bookings/:id/financials', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const bookingId = req.params.id;
    const result = { quote: null, invoice: null };

    getQuoteForBookingFinancials(bookingId, (err, quote) => {
        if (quote) {
            result.quote = {
                id: quote.id,
                quote_number: quote.quote_number,
                pdf_url: `/docs/quotes/${quote.file_path}`,
                created_at: quote.created_at
            };
        }

        getInvoiceForBookingFinancials(bookingId, (err, invoice) => {
            if (invoice) {
                result.invoice = {
                    id: invoice.id,
                    invoice_number: invoice.invoice_number,
                    pdf_url: `/docs/invoices/${invoice.file_path}`,
                    status: invoice.status,
                    total_amount: invoice.total_amount
                };
            }
            res.json(result);
        });
    });
});

module.exports = router;

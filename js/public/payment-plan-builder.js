/*
 * Payment plan builder: the client's editor for a booking's payment milestones in the public
 * Track Booking drawer (index.html). The same component is used in two places:
 *   - accept mode: the client designs their plan while accepting a quote (#planBuilder);
 *   - change mode: after acceptance, the client rearranges the unpaid milestones (#planEditor).
 *
 * It is driven ONLY by the rules context the server sends in /track's payment_plan.context (built by
 * PaymentPlanRules.buildContext from fresh database state, with the Africa/Johannesburg "today"),
 * never by text read back from the page. Every check goes through js/shared/payment-plan-rules.js,
 * the very code the server re-runs on save, so what the client sees here is what the server accepts.
 * Validation is local and live because the public mutate rate limit (5 actions per 15 minutes) leaves
 * no room for a server "preview" round trip.
 *
 * Rendering uses plain DOM nodes and textContent only (nothing from data goes through innerHTML).
 * ES5, no jQuery dependency. Never uses the `pay-btn` class: index.html binds a delegated PayFast
 * redirect to every element carrying it.
 *
 * API (window.PaymentPlanBuilder):
 *   create(container, options) -> builder, or null when the rules module is missing / the context
 *     is unusable. options: {
 *       context,       // payment_plan.context from /track (required)
 *       mode,          // 'accept' | 'change' (defaults to context.mode)
 *       rows,          // optional prefill: [{amount_cents, due_date}] (e.g. context.unpaid_rows)
 *       presetCount,   // without rows: start from this preset, else the largest valid one below it
 *       descriptions,  // optional {scheduleRowId: description} for the read-only paid rows
 *       idPrefix,      // prefix for element ids (unique per instance anyway)
 *       onChange       // function (builder) called after every change of state
 *     }
 *   builder.isValid() / isUnchanged() / getMilestones() / describePlan()
 *   builder.showServerErrors(errors, message)  400 INVALID_PLAN: blocks isValid() until the next edit
 *   builder.showNotice(message)                any other failure: shown, cleared by the next edit
 *   builder.settleOrder()                       apply a pending date re-sort now (call before getMilestones)
 *   builder.setBusy(bool) / focus() / focusErrors() / destroy()
 *   renderPlanList(listElement, items)         read-only list: [{description, due_date, amount_cents, paid}]
 */
(function (window, document) {
    'use strict';

    var instanceCount = 0;
    // Typing fires on every keystroke; the polite live region only gets the settled error list so a
    // screen reader is not read "add up to R 6.00 … R 62.00 … R 625.00" while an amount is typed.
    var ERROR_LIST_DELAY_MS = 400;

    function rules() {
        return window.PaymentPlanRules || null;
    }

    function h(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = String(text);
        return node;
    }

    function icon(cls) {
        var i = document.createElement('i');
        i.className = cls;
        i.setAttribute('aria-hidden', 'true');
        return i;
    }

    function toggleClass(node, cls, on) {
        if (!node) return;
        if (on) node.classList.add(cls);
        else node.classList.remove(cls);
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    function plural(n, word) {
        return n + ' ' + word + (n === 1 ? '' : 's');
    }

    // "R 1,234.50" with a non-breaking space, so a narrow phone never wraps the "R" onto its own line.
    function money(cents) {
        return rules().formatRand(cents).replace(/^(-?R) /, '$1\u00a0');
    }

    // The same for amounts inside rule/error messages from the shared rules module (and the server's
    // copies of them), which write "R 3,500.00" with an ordinary space.
    function keepRandTogether(text) {
        return String(text).replace(/\bR (?=-?\d)/g, 'R\u00a0');
    }

    // Stored milestone descriptions can be entity-encoded once (app.js encodes request bodies; see
    // js/shared/stored-text.js). textContent would show "&amp;" literally, so decode first.
    function plainText(value) {
        if (value === null || value === undefined) return '';
        var s = String(value);
        return typeof window.decodeStoredText === 'function' ? window.decodeStoredText(s) : s;
    }

    // Whole cents -> "6250.00": plain digits with no grouping, so it is unambiguous both to
    // parseMoneyInput and to the server's strict amount format. Built from integers (no toFixed float
    // rounding).
    function centsToInput(cents) {
        var c = Math.round(Number(cents));
        if (!isFinite(c) || c < 0) return '';
        return Math.floor(c / 100) + '.' + pad2(c % 100);
    }

    // What the person typed -> the amount handed to validatePlan: '' (no amount yet: "enter an
    // amount"), NaN (unreadable: "enter the amount in rands …") or the parsed rands.
    function parseAmountText(text) {
        var t = String(text === null || text === undefined ? '' : text).trim();
        if (t === '') return '';
        var v = rules().parseMoneyInput(t);
        return v === null ? NaN : v;
    }

    function amountCents(amount) {
        if (typeof amount !== 'number' || !isFinite(amount)) return null;
        return rules().toCents(amount);
    }

    // Row indices in the order validatePlan sorts them (and the server labels them): by due date,
    // ties and unreadable dates keeping their position, unreadable ones last.
    function sortedOrder(dues) {
        var R = rules();
        var idx = [];
        for (var i = 0; i < dues.length; i++) idx.push(i);
        idx.sort(function (a, b) {
            var da = R.isValidDate(dues[a]) ? dues[a] : null;
            var db = R.isValidDate(dues[b]) ? dues[b] : null;
            if (da && db) {
                if (da !== db) return da < db ? -1 : 1;
            } else if (da) {
                return -1;
            } else if (db) {
                return 1;
            }
            return a - b;
        });
        return idx;
    }

    function closestCard(node, root) {
        while (node && node !== root) {
            if (node.nodeType === 1 && node.classList.contains('trk-plan-card')) return node;
            node = node.parentNode;
        }
        return null;
    }

    /**
     * Read-only plan list (paid milestones, or a plan shown before the client chooses to change it).
     * items: [{ description, due_date, amount_cents, paid }]
     */
    function renderPlanList(list, items) {
        var R = rules();
        if (!list || !R) return;
        while (list.firstChild) list.removeChild(list.firstChild);
        (items || []).forEach(function (it) {
            var li = h('li', 'trk-plan-item' + (it.paid ? ' is-paid' : ''));
            var main = h('div', 'trk-plan-item-main');
            main.appendChild(h('span', 'trk-plan-item-desc', plainText(it.description) || 'Payment'));
            main.appendChild(h('span', 'trk-plan-item-amt', money(it.amount_cents)));
            var meta = h('div', 'trk-plan-item-meta');
            meta.appendChild(h('span', 'trk-plan-item-date', it.due_date ? 'Due ' + R.formatDate(it.due_date) : 'No due date'));
            if (it.paid) {
                var tag = h('span', 'trk-plan-tag trk-plan-tag--paid');
                tag.appendChild(icon('fa-solid fa-lock'));
                tag.appendChild(document.createTextNode(' Paid'));
                meta.appendChild(tag);
            }
            li.appendChild(main);
            li.appendChild(meta);
            list.appendChild(li);
        });
    }

    function PlanBuilder(container, options) {
        var R = rules();
        this.R = R;
        this.container = container;
        this.opts = options || {};
        this.ctx = this.opts.context;
        this.mode = this.opts.mode === 'change' || this.opts.mode === 'accept' ? this.opts.mode : (this.ctx.mode === 'change' ? 'change' : 'accept');
        this.uid = String(this.opts.idPrefix || 'trkPlan').replace(/[^A-Za-z0-9_-]/g, '') + '-' + (++instanceCount);
        this.descriptions = this.opts.descriptions || {};
        this.nextKey = 1;
        this.rows = [];
        this.result = null;
        this.serverErrors = null;
        this.notice = null;
        this.busy = false;
        this.destroyed = false;
        this.errorTimer = null;
        this.sortTimer = null;
        this.pointerDown = false;
        this.sortPending = false;
        this.lastErrorSignature = null;
        this.lastEditedKey = null;
        this.presets = {};
        for (var n = 1; n <= R.MAX_PAYMENTS; n++) this.presets[n] = R.buildPreset(this.ctx, n);
        // Splitting is impossible when only one due date is left or two minimum payments exceed the
        // balance; "Add payment" then stays off rather than leading straight to an error.
        this.splittable = this.ctx.slots > 1 && this.ctx.earliest_due !== this.ctx.latest_due &&
            !(this.ctx.min_payment_cents > 0 && this.ctx.remaining_cents < 2 * this.ctx.min_payment_cents);

        this.build();
        this.setRows(this.initialRows());
        this.renderRows();
        this.refresh(true);
    }

    PlanBuilder.prototype.initialRows = function () {
        var ctx = this.ctx;
        var given = this.opts.rows;
        if (Array.isArray(given) && given.length) {
            return given.map(function (r) {
                return { amount_cents: r.amount_cents, due_date: r.due_date };
            });
        }
        var preferred = parseInt(this.opts.presetCount, 10);
        if (!(preferred >= 1)) preferred = 2;
        for (var k = Math.min(preferred, ctx.slots, this.R.MAX_PAYMENTS); k >= 1; k--) {
            if (this.presets[k]) return this.presets[k];
        }
        // No ready-made plan fits: start from one payment of the whole amount for the client to adjust
        // (the error list says what has to change).
        return [{ amount_cents: ctx.remaining_cents, due_date: ctx.first_due_by || ctx.latest_due }];
    };

    PlanBuilder.prototype.setRows = function (list) {
        var self = this;
        this.rows = (list || []).map(function (r) {
            return {
                key: self.nextKey++,
                amountText: centsToInput(r.amount_cents),
                due: typeof r.due_date === 'string' && self.R.isValidDate(r.due_date.slice(0, 10)) ? r.due_date.slice(0, 10) : ''
            };
        });
    };

    // ───────────────────────── skeleton ─────────────────────────

    PlanBuilder.prototype.build = function () {
        var self = this;
        var R = this.R;
        var ctx = this.ctx;

        var root = h('div', 'trk-plan');
        root.id = this.uid;
        root.setAttribute('data-mode', this.mode);
        root.setAttribute('role', 'group');
        root.setAttribute('tabindex', '-1');
        root.setAttribute('aria-label', 'Payment plan');

        // The client only chooses HOW MANY payments; the system sets every amount and date. So one
        // plain sentence says how the split works, instead of the rules for typing a plan by hand.
        var split = ctx.require_deposit && ctx.deposit_needed_cents > 0 && ctx.deposit_percentage
            ? (ctx.locked_cents > 0
                ? 'Your next payment completes the ' + ctx.deposit_percentage + '% deposit and the rest is split evenly.'
                : 'Your first payment is the ' + ctx.deposit_percentage + '% deposit and the rest is split evenly.')
            : 'The amount is split evenly.';
        root.appendChild(h('p', 'trk-plan-intro', this.mode === 'change'
            ? 'Choose how many payments you’d like for what is still unpaid. ' + split + ' We set the due dates for you.'
            : 'Choose how many payments you’d like. ' + split + ' We set the due dates for you.'));

        // Only when the amount cannot be split at all: then ruleLines() is the one-sentence reason why.
        if (this.cannotSplit()) {
            var rulesList = h('ul', 'trk-plan-rules');
            this.ruleLines().forEach(function (line) { rulesList.appendChild(h('li', null, line)); });
            root.appendChild(rulesList);
        }

        var locked = ctx.locked_rows || [];
        if (locked.length) {
            var lockedWrap = h('div', 'trk-plan-locked');
            lockedWrap.appendChild(h('p', 'trk-plan-sub', 'Already paid'));
            var lockedList = h('ol', 'trk-plan-list');
            renderPlanList(lockedList, locked.map(function (r, i) {
                var d = self.descriptions[r.id];
                return { description: d ? d : 'Payment ' + (i + 1), due_date: r.due_date, amount_cents: r.amount_cents, paid: true };
            }));
            lockedWrap.appendChild(lockedList);
            root.appendChild(lockedWrap);
        }

        var presetsLabel = h('p', 'trk-plan-sub', 'Number of payments');
        presetsLabel.id = this.uid + '-presets';
        root.appendChild(presetsLabel);
        var presets = h('div', 'trk-plan-presets');
        presets.setAttribute('role', 'group');
        presets.setAttribute('aria-labelledby', presetsLabel.id);
        this.presetButtons = [];
        for (var n = 1; n <= R.MAX_PAYMENTS; n++) {
            var b = h('button', 'trk-plan-preset');
            b.type = 'button';
            b.setAttribute('data-role', 'preset');
            b.setAttribute('data-count', String(n));
            b.setAttribute('aria-pressed', 'false');
            b.appendChild(h('strong', null, String(n)));
            b.appendChild(h('span', null, n === 1 ? 'payment' : 'payments'));
            var available = !!this.presets[n] && n <= ctx.slots;
            b.disabled = !available;
            b.setAttribute('data-available', available ? '1' : '0');
            b.setAttribute('aria-label', plural(n, 'payment') + (available ? '' : ' (not possible for this booking)'));
            if (!available) b.title = 'Not possible for this booking';
            presets.appendChild(b);
            this.presetButtons.push(b);
        }
        root.appendChild(presets);

        var rowsLabel = h('p', 'trk-plan-sub', this.mode === 'change' ? 'Your new payments' : 'Your payments');
        rowsLabel.id = this.uid + '-rows';
        root.appendChild(rowsLabel);
        this.rowsList = h('ol', 'trk-plan-rows');
        this.rowsList.setAttribute('aria-labelledby', rowsLabel.id);
        root.appendChild(this.rowsList);

        // Owner rule: the client picks a plan SHAPE (the 1-4 payment buttons) and the system computes every
        // amount and date from it - never a number the client typed. this.addBtn still exists (refresh()
        // unconditionally touches it) but is deliberately never appended, so there is no way to add a
        // payment the chosen preset didn't already produce.
        this.addBtn = h('button', 'trk-plan-add');
        this.addBtn.type = 'button';
        this.addBtn.setAttribute('data-role', 'add');
        var plus = h('span', 'trk-plan-add-plus', '+');
        plus.setAttribute('aria-hidden', 'true');
        this.addBtn.appendChild(plus);
        this.addBtn.appendChild(document.createTextNode('Add payment'));

        var summary = h('div', 'trk-plan-summary');
        this.summaryLine = h('p', 'trk-plan-summary-line');
        this.summaryLeft = h('p', 'trk-plan-summary-left');
        this.fixBtn = h('button', 'trk-plan-fix');
        this.fixBtn.type = 'button';
        this.fixBtn.setAttribute('data-role', 'fix');
        this.fixBtn.style.display = 'none';
        summary.appendChild(this.summaryLine);
        summary.appendChild(this.summaryLeft);
        summary.appendChild(this.fixBtn);
        root.appendChild(summary);
        this.summary = summary;

        // The single error list for the whole plan. Present (empty) from the start: a live region
        // only announces changes if it already existed.
        this.errorsBox = h('div', 'trk-plan-errors');
        this.errorsBox.setAttribute('role', 'status');
        this.errorsBox.setAttribute('aria-live', 'polite');
        this.errorsBox.setAttribute('tabindex', '-1');
        this.errorsBox.id = this.uid + '-errors';
        root.appendChild(this.errorsBox);

        this.root = root;
        while (this.container.firstChild) this.container.removeChild(this.container.firstChild);
        this.container.appendChild(root);

        this.onInput = function (e) { self.handleInput(e); };
        this.onChangeEvt = function (e) { self.handleChange(e); };
        this.onClick = function (e) { self.handleClick(e); };
        this.onFocusOut = function (e) { self.handleFocusOut(e); };
        // A press inside the builder holds back the date re-sort until it is released (see
        // handleFocusOut). The release is watched on the document: it can end outside the builder.
        this.onPointerDown = function () { self.pointerDown = true; };
        this.onPointerUp = function () {
            if (!self.pointerDown) return;
            self.pointerDown = false;
            if (!self.sortPending) return;
            self.sortPending = false;
            clearTimeout(self.sortTimer);
            // A click is dispatched in the same task as the pointerup before it, so this runs after
            // the click has been handled (removeRow finds its card by key, then the rest is sorted).
            self.sortTimer = setTimeout(function () { self.sortByDate(); }, 0);
        };
        root.addEventListener('input', this.onInput);
        root.addEventListener('change', this.onChangeEvt);
        root.addEventListener('click', this.onClick);
        root.addEventListener('focusout', this.onFocusOut);
        root.addEventListener('pointerdown', this.onPointerDown, true);
        document.addEventListener('pointerup', this.onPointerUp, true);
        document.addEventListener('pointercancel', this.onPointerUp, true);
    };

    // The balance can only be paid in one payment: no slots left, one possible due date, or too small
    // to split into two minimum payments. (The same test ruleLines() uses for its short version.)
    PlanBuilder.prototype.cannotSplit = function () {
        var ctx = this.ctx;
        return ctx.slots <= 1 || ctx.earliest_due === ctx.latest_due ||
            (ctx.min_payment_cents > 0 && ctx.remaining_cents < 2 * ctx.min_payment_cents);
    };

    // The rules in plain words, built from the same context the checks use.
    PlanBuilder.prototype.ruleLines = function () {
        var R = this.R;
        var ctx = this.ctx;
        var lines = [];
        var lockedCount = ctx.locked_count || 0;
        var date = function (ymd) { return ymd === ctx.today ? 'today' : R.formatDate(ymd); };
        var firstBy = null;
        if (ctx.require_first_by && ctx.first_due_by) {
            firstBy = ctx.first_due_by === ctx.today ? 'due today' : 'due by ' + R.formatDate(ctx.first_due_by);
        }

        // The cases where the balance cannot be split at all get one plain sentence instead of rules
        // that could never all apply. (Presets alone don't decide this: with a close event the ready-
        // made 2-payment plan can be impossible while a hand-made one still fits.)
        var oneDay = ctx.earliest_due === ctx.latest_due;
        var tooSmall = ctx.min_payment_cents > 0 && ctx.remaining_cents < 2 * ctx.min_payment_cents;
        if (ctx.slots <= 1 || oneDay || tooSmall) {
            var when = oneDay ? 'due ' + (ctx.latest_due === ctx.today ? 'today' : 'on ' + R.formatDate(ctx.latest_due))
                : (firstBy || 'due by ' + R.formatDate(ctx.latest_due));
            lines.push('Pay the ' + (lockedCount > 0 ? 'remaining ' : 'full ') + money(ctx.remaining_cents) + ' in one payment, ' + when + '.');
            if (ctx.slots <= 1) {
                lines.push('A payment plan can have at most ' + ctx.max_payments + ' payments in total, including the ' +
                    plural(lockedCount, 'payment') + ' already made.');
            } else if (oneDay) {
                lines.push(ctx.event_date
                    ? 'Payments must be made at least ' + R.LAST_DUE_DAYS_BEFORE_EVENT + ' days before your event, so there is no time to split the amount.'
                    : 'There is only one possible due date left, so the amount cannot be split.');
            } else {
                lines.push('Amounts under ' + money(2 * ctx.min_payment_cents) + ' cannot be split, because each payment must be at least ' +
                    money(ctx.min_payment_cents) + '.');
            }
            return lines;
        }

        if (lockedCount > 0) {
            lines.push('Up to ' + plural(ctx.slots, 'more payment') + ' (' + ctx.max_payments + ' in total, including ' +
                (lockedCount === 1 ? 'the payment' : 'the ' + lockedCount + ' payments') + ' already made).');
        } else {
            lines.push('Up to ' + plural(Math.min(ctx.slots, ctx.max_payments), 'payment') + '.');
        }

        if (ctx.require_deposit && ctx.deposit_needed_cents > 0) {
            if (ctx.locked_cents > 0) {
                lines.push('Your next payment must be at least ' + money(ctx.deposit_needed_cents) + ' to complete the ' +
                    ctx.deposit_percentage + '% deposit' + (firstBy ? ', ' + firstBy : '') + '.');
            } else {
                lines.push('Your first payment must be at least ' + money(ctx.deposit_needed_cents) + ' (the ' +
                    ctx.deposit_percentage + '% deposit)' + (firstBy ? ', ' + firstBy : '') + '.');
            }
        } else if (firstBy) {
            lines.push('Your first payment must be ' + firstBy + '.');
        }

        var span = 'Payments must be due between ' + date(ctx.earliest_due) + ' and ' + R.formatDate(ctx.latest_due);
        if (ctx.event_date && ctx.latest_due === R.addDays(ctx.event_date, -R.LAST_DUE_DAYS_BEFORE_EVENT)) {
            span += ' (' + R.LAST_DUE_DAYS_BEFORE_EVENT + ' days before your event)';
        }
        lines.push(span + ', each on a different day.');

        if (ctx.min_payment_cents > 0) {
            lines.push('When you split the amount, each payment must be at least ' + money(ctx.min_payment_cents) + '.');
        }
        return lines;
    };

    // ───────────────────────── rows ─────────────────────────

    // The number shown on card i: payments are numbered across the whole plan, the paid ones first,
    // so with one payment made the first editable card is payment 2 — matching its label
    // ("Payment 2 of 3") and validatePlan's messages ("Payment 2 must be due …").
    PlanBuilder.prototype.cardNumber = function (i) {
        return (this.ctx.locked_count > 0 ? this.ctx.locked_count : 0) + i + 1;
    };

    PlanBuilder.prototype.renderRows = function () {
        var self = this;
        var list = this.rowsList;
        while (list.firstChild) list.removeChild(list.firstChild);
        this.rows.forEach(function (r, i) {
            var li = h('li', 'trk-plan-card');
            li.setAttribute('data-key', String(r.key));

            var top = h('div', 'trk-plan-card-top');
            var n = self.cardNumber(i);
            var num = h('span', 'trk-plan-num', String(n));
            num.setAttribute('aria-hidden', 'true');
            var label = h('span', 'trk-plan-card-label', 'Payment ' + n);
            label.id = self.uid + '-label-' + r.key;
            // Built but never appended, same reasoning as this.addBtn in build(): refresh() still
            // unconditionally does card.querySelector('[data-role="remove"]') and handles finding
            // none, so this stays a one-line change rather than also touching that function.
            var rm = h('button', 'trk-plan-remove');
            rm.type = 'button';
            rm.setAttribute('data-role', 'remove');
            rm.setAttribute('aria-label', 'Remove payment ' + n);
            rm.title = 'Remove this payment';
            // A plain "×" (like the drawer's own close button) rather than an icon-font glyph, so the
            // control never renders empty if the icon font fails to load.
            var x = h('span', 'trk-plan-remove-x', '\u00d7');
            x.setAttribute('aria-hidden', 'true');
            rm.appendChild(x);
            // Owner rule: the client picks how many payments and the system computes every amount and
            // date from it - so each payment is shown as text, never as a field that looks editable.
            // data-role stays on the two values so refresh() can still mark one a server error names.
            var cents = amountCents(parseAmountText(r.amountText));
            var amount = h('span', 'trk-plan-card-amt', cents === null ? r.amountText : money(cents));
            amount.setAttribute('data-role', 'amount');
            top.appendChild(num);
            top.appendChild(label);
            top.appendChild(amount);
            li.appendChild(top);
            var due = h('p', 'trk-plan-card-due', r.due ? 'Due ' + self.R.formatDate(r.due) : 'No due date');
            due.setAttribute('data-role', 'due');
            li.appendChild(due);
            list.appendChild(li);
        });
    };

    PlanBuilder.prototype.rowIndexOf = function (node) {
        var card = closestCard(node, this.root);
        if (!card) return -1;
        var key = Number(card.getAttribute('data-key'));
        for (var i = 0; i < this.rows.length; i++) if (this.rows[i].key === key) return i;
        return -1;
    };

    PlanBuilder.prototype.cardFor = function (key) {
        return this.rowsList.querySelector('li[data-key="' + key + '"]');
    };

    PlanBuilder.prototype.fieldFor = function (key, role) {
        var card = this.cardFor(key);
        return card ? card.querySelector('[data-role="' + role + '"]') : null;
    };

    // Any edit makes earlier server feedback stale.
    PlanBuilder.prototype.touched = function () {
        this.serverErrors = null;
        this.notice = null;
    };

    PlanBuilder.prototype.handleInput = function (e) {
        if (this.busy) return;
        var role = e.target && e.target.getAttribute ? e.target.getAttribute('data-role') : null;
        if (role !== 'amount' && role !== 'due') return;
        var i = this.rowIndexOf(e.target);
        if (i < 0) return;
        if (role === 'amount') this.rows[i].amountText = e.target.value;
        else this.rows[i].due = e.target.value;
        this.lastEditedKey = this.rows[i].key;
        this.touched();
        this.refresh(false);
    };

    PlanBuilder.prototype.handleChange = function (e) {
        if (this.busy) return;
        var role = e.target && e.target.getAttribute ? e.target.getAttribute('data-role') : null;
        if (role !== 'amount' && role !== 'due') return;
        var i = this.rowIndexOf(e.target);
        if (i < 0) return;
        var row = this.rows[i];
        if (role === 'amount') {
            // Tidy a readable amount into the canonical "6250.00" once the person is done with it,
            // so what they see is exactly what will be scheduled.
            var cents = amountCents(parseAmountText(e.target.value));
            row.amountText = cents === null ? e.target.value : centsToInput(cents);
            if (e.target.value !== row.amountText) e.target.value = row.amountText;
        } else {
            row.due = e.target.value;
        }
        this.lastEditedKey = row.key;
        this.touched();
        this.refresh(true);
    };

    PlanBuilder.prototype.handleFocusOut = function (e) {
        var role = e.target && e.target.getAttribute ? e.target.getAttribute('data-role') : null;
        if (role !== 'due') return;
        var self = this;
        // Re-order the cards by due date once the person has left a date field (never while they are
        // in it: re-rendering mid-typing would throw away their place in the date segments). Deferred
        // so the element receiving focus is known and can be given focus back after the re-render.
        clearTimeout(this.sortTimer);
        // Focus left because a mouse button went down inside the builder, e.g. on another card's ×.
        // Re-rendering before it comes back up would detach the pressed button, so the browser
        // would drop its click and the cards would move under the pointer: sort once it is released.
        // (A touch tap releases before focus moves, so it never waits here.)
        if (this.pointerDown) {
            this.sortPending = true;
            return;
        }
        this.sortTimer = setTimeout(function () { self.sortByDate(); }, 0);
    };

    // Runs a re-sort that is still waiting (on its timer or on a pointer release) right away. The
    // tracker calls it just before getMilestones(): a tap on its submit button is handled before
    // that timer fires, and milestones sent in unsorted card order would leave a 400's error
    // indices pointing at cards a later re-sort moves.
    PlanBuilder.prototype.settleOrder = function () {
        if (this.destroyed) return;
        clearTimeout(this.sortTimer);
        this.sortTimer = null;
        this.sortPending = false;
        this.sortByDate();
    };

    PlanBuilder.prototype.sortByDate = function () {
        if (this.destroyed || this.busy || this.rows.length < 2) return;
        var R = this.R;
        var allDated = this.rows.every(function (r) { return R.isValidDate(r.due); });
        if (!allDated) return;
        var self = this;
        var order = sortedOrder(this.rows.map(function (r) { return r.due; }));
        var changed = order.some(function (idx, pos) { return idx !== pos; });
        if (!changed) return;
        var active = document.activeElement;
        var focusKey = null;
        var focusRole = null;
        var selStart = null;
        var selEnd = null;
        if (active && this.rowsList.contains(active)) {
            var card = closestCard(active, this.root);
            focusKey = card ? card.getAttribute('data-key') : null;
            focusRole = active.getAttribute('data-role');
            try { selStart = active.selectionStart; selEnd = active.selectionEnd; } catch (err) { selStart = null; }
        }
        this.rows = order.map(function (idx) { return self.rows[idx]; });
        this.renderRows();
        this.refresh(true);
        if (focusKey && focusRole) {
            var target = this.fieldFor(focusKey, focusRole);
            if (target) {
                target.focus();
                try { if (selStart !== null && selStart !== undefined) target.setSelectionRange(selStart, selEnd); } catch (err2) { /* date inputs have no selection */ }
            }
        }
    };

    PlanBuilder.prototype.handleClick = function (e) {
        if (this.busy) return;
        var node = e.target;
        while (node && node !== this.root && !(node.getAttribute && node.getAttribute('data-role'))) node = node.parentNode;
        if (!node || node === this.root || node.disabled) return;
        var role = node.getAttribute('data-role');
        if (role === 'preset') this.applyPreset(parseInt(node.getAttribute('data-count'), 10));
        else if (role === 'remove') this.removeRow(this.rowIndexOf(node));
        else if (role === 'add') this.addRow();
        else if (role === 'fix') this.applyFix();
    };

    PlanBuilder.prototype.applyPreset = function (n) {
        var preset = this.presets[n];
        if (!preset || n > this.ctx.slots) return;
        this.setRows(preset);
        this.lastEditedKey = null;
        this.touched();
        this.renderRows();
        this.refresh(true);
    };

    PlanBuilder.prototype.removeRow = function (i) {
        if (i < 0 || this.rows.length <= 1) return;
        this.rows.splice(i, 1);
        this.touched();
        this.renderRows();
        this.refresh(true);
        // Keep keyboard users in the list rather than dropping focus on <body>.
        var next = this.rows[Math.min(i, this.rows.length - 1)];
        var target = next ? this.fieldFor(next.key, 'remove') : null;
        if (target && !target.disabled) target.focus();
        else if (next) {
            var amount = this.fieldFor(next.key, 'amount');
            if (amount) amount.focus();
        }
    };

    // A free due date for a new payment: the last allowed date if nothing is due on it yet, else the
    // middle of the widest gap between the planned dates; '' when every day is taken.
    PlanBuilder.prototype.suggestDate = function () {
        var R = this.R;
        var ctx = this.ctx;
        var taken = {};
        var dates = [];
        this.rows.forEach(function (r) {
            if (R.isValidDate(r.due) && !taken[r.due]) {
                taken[r.due] = true;
                dates.push(r.due);
            }
        });
        dates.sort();
        if (!dates.length) return ctx.require_first_by && ctx.first_due_by ? ctx.first_due_by : ctx.latest_due;
        if (dates[dates.length - 1] < ctx.latest_due && !taken[ctx.latest_due]) return ctx.latest_due;
        var points = [ctx.earliest_due];
        dates.forEach(function (d) {
            if (d > points[points.length - 1] && d <= ctx.latest_due) points.push(d);
        });
        var best = '';
        var bestGap = 1;
        for (var i = 1; i < points.length; i++) {
            var gap = R.diffDays(points[i], points[i - 1]);
            if (gap !== null && gap > bestGap) {
                bestGap = gap;
                best = R.addDays(points[i - 1], Math.floor(gap / 2));
            }
        }
        if (best && taken[best]) best = '';
        return best;
    };

    PlanBuilder.prototype.addRow = function () {
        if (this.rows.length >= this.ctx.slots || (!this.splittable && this.rows.length > 0)) return;
        var R = this.R;
        var stats = this.amountStats();
        var left = this.ctx.remaining_cents - stats.allocated;
        var due = this.suggestDate();
        var row = {
            key: this.nextKey++,
            amountText: stats.allValid && left > 0 ? centsToInput(left) : '',
            due: due || ''
        };
        // Insert at its date position so the cards stay in date order.
        var at = this.rows.length;
        if (row.due && this.rows.every(function (r) { return R.isValidDate(r.due); })) {
            for (var i = 0; i < this.rows.length; i++) {
                if (this.rows[i].due > row.due) { at = i; break; }
            }
        }
        this.rows.splice(at, 0, row);
        this.lastEditedKey = row.key;
        this.touched();
        this.renderRows();
        this.refresh(true);
        var amount = this.fieldFor(row.key, 'amount');
        if (amount) amount.focus();
    };

    // Which payment the "remaining amount" quick fix adjusts: the last one by date, unless that is
    // the one the person just typed into (adjusting it would undo their edit), then the one before.
    PlanBuilder.prototype.fixTarget = function () {
        if (!this.rows.length) return -1;
        var order = sortedOrder(this.rows.map(function (r) { return r.due; }));
        for (var p = order.length - 1; p >= 0; p--) {
            if (this.rows[order[p]].key !== this.lastEditedKey) return order[p];
        }
        return order[order.length - 1];
    };

    PlanBuilder.prototype.applyFix = function () {
        var stats = this.amountStats();
        var diff = this.ctx.remaining_cents - stats.allocated;
        if (!stats.allValid || diff === 0) return;
        var t = this.fixTarget();
        if (t < 0) return;
        var cents = stats.cents[t] + diff;
        if (!(cents > 0)) return;
        var row = this.rows[t];
        row.amountText = centsToInput(cents);
        this.touched();
        var input = this.fieldFor(row.key, 'amount');
        if (input) input.value = row.amountText;
        this.refresh(true);
        if (input) input.focus();
    };

    // ───────────────────────── state ─────────────────────────

    PlanBuilder.prototype.inputRows = function () {
        return this.rows.map(function (r) {
            return { amount: parseAmountText(r.amountText), due_date: r.due };
        });
    };

    PlanBuilder.prototype.amountStats = function () {
        var cents = [];
        var allocated = 0;
        var allValid = true;
        this.rows.forEach(function (r) {
            var c = amountCents(parseAmountText(r.amountText));
            cents.push(c);
            if (c === null || c <= 0) allValid = false;
            if (c !== null) allocated += c;
        });
        return { cents: cents, allocated: allocated, allValid: allValid && this.rows.length > 0 };
    };

    PlanBuilder.prototype.refresh = function (immediateErrors) {
        if (this.destroyed) return;
        var self = this;
        var R = this.R;
        var ctx = this.ctx;
        var inputs = this.inputRows();
        this.result = R.validatePlan(ctx, inputs);
        var stats = this.amountStats();

        // Preview of the descriptions the server will give each payment (labels are always
        // server-generated; this is the same function the server uses).
        var order = sortedOrder(this.rows.map(function (r) { return r.due; }));
        var labels = R.labelPlan(ctx, order.map(function (idx) {
            return { amount_cents: stats.cents[idx], due_date: self.rows[idx].due };
        }));
        var position = [];
        order.forEach(function (idx, p) { position[idx] = p; });

        var shown = this.serverErrors || this.result.errors;
        var bad = {};
        shown.forEach(function (err) {
            if (err && err.index !== null && err.index !== undefined) bad[err.index + ':' + err.field] = true;
        });

        var cards = this.rowsList.children;
        for (var i = 0; i < cards.length && i < this.rows.length; i++) {
            var card = cards[i];
            var num = card.querySelector('.trk-plan-num');
            var label = card.querySelector('.trk-plan-card-label');
            var rm = card.querySelector('[data-role="remove"]');
            var amount = card.querySelector('[data-role="amount"]');
            var due = card.querySelector('[data-role="due"]');
            var n = this.cardNumber(i);
            if (num) num.textContent = String(n);
            if (label) label.textContent = labels[position[i]] || ('Payment ' + n);
            if (rm) {
                rm.disabled = this.busy || this.rows.length <= 1;
                rm.setAttribute('aria-label', 'Remove payment ' + n);
            }
            this.markField(amount, !!bad[i + ':amount']);
            this.markField(due, !!bad[i + ':due_date']);
            if (amount) amount.disabled = this.busy;
            if (due) due.disabled = this.busy;
        }

        // Which ready-made plan (if any) the rows currently are.
        this.presetButtons.forEach(function (b) {
            var n = parseInt(b.getAttribute('data-count'), 10);
            b.setAttribute('aria-pressed', self.matchesPreset(n) ? 'true' : 'false');
            b.disabled = self.busy || b.getAttribute('data-available') !== '1';
        });

        var canAdd = this.rows.length < ctx.slots && (this.splittable || this.rows.length === 0);
        this.addBtn.disabled = this.busy || !canAdd;
        this.addBtn.title = canAdd ? '' : (this.rows.length >= ctx.slots ? 'You have reached the maximum number of payments' : 'This amount can only be paid in one payment');

        this.renderSummary(stats);

        if (immediateErrors) {
            this.renderErrors();
        } else {
            clearTimeout(this.errorTimer);
            this.errorTimer = setTimeout(function () { self.renderErrors(); }, ERROR_LIST_DELAY_MS);
        }

        if (typeof this.opts.onChange === 'function') {
            try { this.opts.onChange(this); } catch (err) { if (window.console) window.console.error('[PaymentPlanBuilder] onChange failed:', err); }
        }
    };

    PlanBuilder.prototype.markField = function (input, isBad) {
        if (!input) return;
        toggleClass(input, 'bk-input--err', isBad);
        if (isBad) input.setAttribute('aria-invalid', 'true');
        else input.removeAttribute('aria-invalid');
    };

    PlanBuilder.prototype.matchesPreset = function (n) {
        var preset = this.presets[n];
        if (!preset || preset.length !== this.rows.length) return false;
        for (var i = 0; i < preset.length; i++) {
            var row = this.rows[i];
            if (row.due !== preset[i].due_date) return false;
            if (amountCents(parseAmountText(row.amountText)) !== preset[i].amount_cents) return false;
        }
        return true;
    };

    PlanBuilder.prototype.renderSummary = function (stats) {
        var R = this.R;
        var ctx = this.ctx;
        var diff = ctx.remaining_cents - stats.allocated;
        this.summaryLine.textContent = 'Scheduled ' + money(stats.allocated) + ' of ' + money(ctx.remaining_cents);

        var left = this.summaryLeft;
        while (left.firstChild) left.removeChild(left.firstChild);
        left.className = 'trk-plan-summary-left';
        if (!stats.allValid) {
            left.classList.add('is-warn');
            left.appendChild(document.createTextNode('Enter a valid amount for every payment.'));
        } else if (diff === 0) {
            left.classList.add('is-ok');
            left.appendChild(icon('fa-solid fa-circle-check'));
            left.appendChild(document.createTextNode(' Everything is scheduled.'));
        } else if (diff > 0) {
            left.classList.add('is-warn');
            left.appendChild(document.createTextNode(money(diff) + ' still to schedule.'));
        } else {
            left.classList.add('is-err');
            left.appendChild(document.createTextNode(money(-diff) + ' more than the balance.'));
        }
        toggleClass(this.summary, 'is-err', stats.allValid && diff !== 0);
        // A plan the system built always adds up, so the tally only appears when something is off.
        this.summary.style.display = stats.allValid && diff === 0 ? 'none' : '';

        var showFix = false;
        if (stats.allValid && diff !== 0) {
            var t = this.fixTarget();
            if (t >= 0 && stats.cents[t] + diff > 0) {
                showFix = true;
                this.fixBtn.textContent = diff > 0
                    ? 'Add the remaining ' + money(diff) + ' to payment ' + this.cardNumber(t)
                    : 'Take ' + money(-diff) + ' off payment ' + this.cardNumber(t);
            }
        }
        this.fixBtn.style.display = showFix ? '' : 'none';
        this.fixBtn.disabled = this.busy;
    };

    PlanBuilder.prototype.renderErrors = function () {
        clearTimeout(this.errorTimer);
        this.errorTimer = null;
        if (this.destroyed) return;
        var fromServer = !!this.serverErrors;
        var list = this.serverErrors || (this.result ? this.result.errors : []);
        var messages = [];
        list.forEach(function (err) {
            var m = err && err.message ? String(err.message) : '';
            if (m && messages.indexOf(m) === -1) messages.push(m);
        });
        if (this.notice && messages.indexOf(this.notice) === -1) messages.unshift(this.notice);
        var serverTitle = this.mode === 'accept' ? 'The quote could not be accepted with this plan:' : 'We could not save this plan:';
        var title = fromServer ? serverTitle : (this.notice && messages.length === 1 ? '' : 'Please adjust your plan:');
        var signature = title + '\n' + messages.join('\n');
        if (signature === this.lastErrorSignature) return;
        this.lastErrorSignature = signature;

        var box = this.errorsBox;
        while (box.firstChild) box.removeChild(box.firstChild);
        toggleClass(box, 'has-errors', messages.length > 0);
        if (!messages.length) return;
        if (title) {
            var p = h('p', 'trk-plan-errors-title');
            p.appendChild(icon('fa-solid fa-triangle-exclamation'));
            p.appendChild(document.createTextNode(' ' + title));
            box.appendChild(p);
        }
        var ul = h('ul');
        messages.forEach(function (m) { ul.appendChild(h('li', null, keepRandTogether(m))); });
        box.appendChild(ul);
    };

    // ───────────────────────── public API ─────────────────────────

    PlanBuilder.prototype.isValid = function () {
        return !this.destroyed && !this.serverErrors && !!this.result && this.result.ok;
    };

    PlanBuilder.prototype.isUnchanged = function () {
        if (this.destroyed) return false;
        return this.R.isUnchangedPlan(this.ctx, this.inputRows());
    };

    // [{amount (rands, number), due_date}] in card order: the indices of a 400 INVALID_PLAN answer
    // then point straight back at the cards.
    PlanBuilder.prototype.getMilestones = function () {
        var R = this.R;
        return this.rows.map(function (r) {
            return { amount: R.parseMoneyInput(String(r.amountText).trim()), due_date: r.due };
        });
    };

    // "R 6,250.00 due 23 Oct 2026; R 6,250.00 due 20 Dec 2026", in date order (for the confirm dialog,
    // which shows plain text on one line).
    PlanBuilder.prototype.describePlan = function () {
        var R = this.R;
        var rows = this.result && this.result.rows ? this.result.rows : [];
        return rows.map(function (r) {
            // Non-breaking spaces keep "R 750.00" and "16 Nov 2026" whole when the dialog wraps.
            return money(r.amount_cents) + ' due ' + R.formatDate(r.due_date).replace(/ /g, '\u00a0');
        }).join('; ');
    };

    PlanBuilder.prototype.showServerErrors = function (errors, message) {
        if (this.destroyed) return;
        var list = Array.isArray(errors) ? errors.filter(function (e) { return e && e.message; }) : [];
        if (!list.length && message) list = [{ index: null, field: 'plan', message: String(message) }];
        this.serverErrors = list.length ? list : null;
        this.notice = null;
        this.lastErrorSignature = null;
        this.refresh(true);
        this.focusErrors();
    };

    PlanBuilder.prototype.showNotice = function (message) {
        if (this.destroyed || !message) return;
        this.notice = String(message);
        this.lastErrorSignature = null;
        this.renderErrors();
        this.focusErrors();
    };

    PlanBuilder.prototype.setBusy = function (busy) {
        if (this.destroyed) return;
        this.busy = !!busy;
        toggleClass(this.root, 'is-busy', this.busy);
        this.root.setAttribute('aria-busy', this.busy ? 'true' : 'false');
        this.refresh(true);
    };

    PlanBuilder.prototype.focus = function () {
        if (this.destroyed) return;
        try { this.root.focus({ preventScroll: true }); } catch (e) { this.root.focus(); }
        if (this.root.scrollIntoView) this.root.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    PlanBuilder.prototype.focusErrors = function () {
        if (this.destroyed) return;
        this.renderErrors();
        var box = this.errorsBox;
        if (!box.classList.contains('has-errors')) return;
        try { box.focus({ preventScroll: true }); } catch (e) { box.focus(); }
        if (box.scrollIntoView) box.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };

    PlanBuilder.prototype.destroy = function () {
        if (this.destroyed) return;
        this.destroyed = true;
        clearTimeout(this.errorTimer);
        clearTimeout(this.sortTimer);
        document.removeEventListener('pointerup', this.onPointerUp, true);
        document.removeEventListener('pointercancel', this.onPointerUp, true);
        if (this.root) {
            this.root.removeEventListener('input', this.onInput);
            this.root.removeEventListener('change', this.onChangeEvt);
            this.root.removeEventListener('click', this.onClick);
            this.root.removeEventListener('focusout', this.onFocusOut);
            this.root.removeEventListener('pointerdown', this.onPointerDown, true);
            if (this.root.parentNode) this.root.parentNode.removeChild(this.root);
        }
        this.opts = {};
    };

    function usableContext(ctx) {
        return !!(ctx && typeof ctx === 'object' && typeof ctx.remaining_cents === 'number' && typeof ctx.slots === 'number' &&
            typeof ctx.earliest_due === 'string' && typeof ctx.latest_due === 'string');
    }

    window.PaymentPlanBuilder = {
        create: function (container, options) {
            if (!rules() || !container || !options || !usableContext(options.context)) return null;
            return new PlanBuilder(container, options);
        },
        renderPlanList: renderPlanList,
        centsToInput: centsToInput
    };
})(window, document);

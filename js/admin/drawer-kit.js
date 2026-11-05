/* Admin Drawer Kit - the one piece of behaviour the kit's forms share (styles: css/admin/drawer-kit.css).

   window.dkMessage(target, kind, text)
     Shows a message in a form drawer as a kit notice instead of colouring a line of text. kind = 'ok' | 'bad' | 'warn' | 'info'; an empty kind or text
     clears it (the .dk-msg:empty rule hides the box). The text is set as TEXT (never HTML), so anything typed by a person is safe. An error is announced
     to screen readers (role=alert) and scrolled into view: it used to sit at the bottom of a long form where an admin scrolled up could miss it.
     Why not just colour the text: the success green and the error red were 3.9:1 and 4.5:1 on the Ivory card, a notice keeps the text in the Finish's ink and
     carries the colour in its icon, border and tint, so it is readable in every Appearance setting. */
(function () {
    'use strict';
    var ICON = { ok: 'circle-check', bad: 'circle-exclamation', warn: 'triangle-exclamation', info: 'circle-info' };

    window.dkMessage = function (target, kind, text) {
        var $el = (window.jQuery || window.$)(target);
        if (!$el.length) return;
        if (!kind || !text) { $el.attr('class', 'dk-msg').removeAttr('role').empty(); return; }
        var $ = window.jQuery || window.$;
        $el.attr('class', 'dk-msg dk-notice dk-notice--' + kind)
            .attr('role', kind === 'bad' ? 'alert' : 'status')
            .empty()
            .append($('<i class="fa-solid" aria-hidden="true"></i>').addClass('fa-' + (ICON[kind] || ICON.info)))
            .append($('<div></div>').text(text));
        if (kind === 'bad' && $el[0].scrollIntoView) {
            try { $el[0].scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) { $el[0].scrollIntoView(false); }
        }
    };
})();

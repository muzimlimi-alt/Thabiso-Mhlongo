/**
 * Stored text, shown as text. Loaded on BOTH index.html and admin.html, right after jQuery.
 *
 * The database holds user text entity-encoded once ("Tom &amp; Jerry&#x27;s") because app.js's deepEscapeBody encodes
 * every request body (see lib/html-sanitize.js for the full picture). That form is right for exactly one consumer:
 * markup injected with .html() / innerHTML, where the browser decodes it once. Anything that shows it as TEXT - a form
 * box, .text(), a title - has to decode it first, otherwise the page shows the raw entities, and an admin form that is
 * saved again encodes them a second time (every edit stacked another layer: "&amp;amp;quot;").
 *
 * So this file makes jQuery's two text setters do that decoding:
 *     $(el).val(storedString)    on text inputs / textareas / url / email / tel / search fields
 *     $(el).text(storedString)
 * A string with no entity in it is untouched, selects / checkboxes / hidden / password fields are untouched, and
 * .html() is deliberately NOT patched (it is the consumer the encoded form is for).
 *
 * Native assignments (el.value = x, el.textContent = x) are not covered - call decodeStoredText(x) there.
 */
(function (window, document) {
    'use strict';

    var ENTITY = /&(?:amp|lt|gt|quot|#x27);/;
    var scratch = document.createElement('textarea');   // decodes without ever executing markup (RCDATA)

    // The plain text behind a stored value. Decodes until stable: rows saved by older versions had stacked layers.
    function decodeStoredText(str) {
        var prev, cur = str == null ? '' : String(str);
        do { prev = cur; scratch.innerHTML = prev; cur = scratch.value; } while (cur !== prev);
        return cur;
    }
    window.decodeStoredText = decodeStoredText;

    var $ = window.jQuery;
    if (!$ || !$.fn || $.fn.val.__storedText) return;

    var origVal = $.fn.val;
    var origText = $.fn.text;

    $.fn.val = function (value) {
        if (typeof value !== 'string' || !ENTITY.test(value)) return origVal.apply(this, arguments);
        var plain = decodeStoredText(value);
        return this.each(function () {
            var t = this.type;
            var textLike = this.tagName === 'TEXTAREA' || (this.tagName === 'INPUT' && /^(text|search|url|email|tel)$/.test(t));
            origVal.call($(this), textLike ? plain : value);
        });
    };
    $.fn.val.__storedText = true;

    $.fn.text = function (value) {
        if (typeof value === 'string' && ENTITY.test(value)) return origText.call(this, decodeStoredText(value));
        return origText.apply(this, arguments);
    };
})(window, document);

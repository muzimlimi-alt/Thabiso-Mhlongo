// Error-handling middleware — Phase 5 of the housekeeping effort (HOUSEKEEPING-NOTES.md). Moved
// out of the server.js monolith byte-identical.
//
// Both handlers originally used __dirname to locate error.html at the project root — __dirname
// inside this file would instead resolve to middleware/, so rootDir is passed in explicitly by the
// caller (app.js, which still sits at the project root and can pass its own __dirname unchanged).
//
// Notification Centre (docs-internal/notifications.md): a real server fault (status >= 500) is now announced as ONE grouped incident per
// route shape + error class, and the JSON response carries the same short `ref` so a report from a user can be matched to it. The
// response itself is unchanged apart from that extra field. A client mistake (a 4xx raised through next(err), e.g. malformed JSON) is not one.
const path = require('path');
const notify = require('../lib/notify');

// 404 - Not Found
function createNotFoundHandler(rootDir) {
    return (req, res) => {
        res.status(404).sendFile(path.join(rootDir, 'error.html'));
    };
}

// 500 - Server Error
function createServerErrorHandler(rootDir) {
    return (err, req, res, next) => {
        console.error(err.stack);
        const route = notify.normalizeRoute(req.originalUrl || req.path);
        const errorClass = (err && err.name) || 'Error';
        const fingerprint = notify.fingerprint(req.method, route, errorClass);
        const status = Number(err && (err.status || err.statusCode)) || 500;
        if (status >= 500) {
            notify.emit('system.server_error', { fingerprint, route, method: req.method, errorClass, message: err && err.message }, { req });
        }
        if (req.path.startsWith('/api/')) {
            return res.status(500).json({ success: false, message: err.message || 'Internal server error', ref: fingerprint });
        }
        res.status(500).sendFile(path.join(rootDir, 'error.html'));
    };
}

module.exports = { createNotFoundHandler, createServerErrorHandler };

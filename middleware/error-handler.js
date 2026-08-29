// Error-handling middleware — Phase 5 of the housekeeping effort (HOUSEKEEPING-NOTES.md). Moved
// out of the server.js monolith byte-identical.
//
// Both handlers originally used __dirname to locate error.html at the project root — __dirname
// inside this file would instead resolve to middleware/, so rootDir is passed in explicitly by the
// caller (app.js, which still sits at the project root and can pass its own __dirname unchanged).
const path = require('path');

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
        if (req.path.startsWith('/api/')) {
            return res.status(500).json({ success: false, message: err.message || 'Internal server error' });
        }
        res.status(500).sendFile(path.join(rootDir, 'error.html'));
    };
}

module.exports = { createNotFoundHandler, createServerErrorHandler };

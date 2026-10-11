// Object storage for admin-uploaded files. With R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID and
// R2_SECRET_ACCESS_KEY set, uploads go to a Cloudflare R2 bucket and survive redeploys; without them
// everything stays on local disk (development and the test suite). Keys mirror the site's public
// /images/... paths, so existing database rows keep working unchanged.
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { UPLOADS_PATH, DOCS_PATH, resolveDocsPath } = require('./runtime-paths');

const { R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;
const enabled = Boolean(R2_ENDPOINT && R2_BUCKET && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY);
const CACHE_CONTROL = 'public, max-age=604800';
const client = enabled ? new S3Client({
    region: 'auto',
    endpoint: R2_ENDPOINT,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY }
}) : null;

// Two roots share this module: UPLOADS_PATH (public admin images, key prefix "images/") and
// DOCS_PATH (private generated/uploaded documents — contracts, invoices, payment proofs, key prefix
// "docs/"). DOCS_PATH is checked first since it is the more specific of the two.
function keyForDiskPath(absPath) {
    if (absPath.startsWith(DOCS_PATH)) return 'docs/' + path.relative(DOCS_PATH, absPath).split(path.sep).join('/');
    return 'images/' + path.relative(UPLOADS_PATH, absPath).split(path.sep).join('/');
}

function diskPathForKey(key) {
    if (key.startsWith('docs/')) return path.join(DOCS_PATH, key.slice('docs/'.length));
    return path.join(UPLOADS_PATH, key.replace(/^images\//, ''));
}

function isMissing(err) {
    return err.name === 'NoSuchKey' || err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404;
}

// A drop-in replacement for multer.diskStorage(): same destination/filename callbacks, and the same
// req.file fields (destination, filename, path, size) that routes already read. With R2 enabled the
// bytes go to the bucket instead of disk — req.file.path is still set (same join as diskStorage would
// produce) so code that stores or reconstructs that string as an identifier keeps working unchanged,
// but nothing is actually there on disk. Anything that needs the bytes back (or an existence check)
// must go through readFile()/fileExists()/resolveDocument() below, never a raw fs call on that path.
function multerStorage(options) {
    const disk = multer.diskStorage(options);
    return {
        _handleFile(req, file, cb) {
            if (!enabled) return disk._handleFile(req, file, cb);
            options.destination(req, file, (destErr, dir) => {
                if (destErr) return cb(destErr);
                options.filename(req, file, (nameErr, name) => {
                    if (nameErr) return cb(nameErr);
                    const diskPath = path.join(dir, name);
                    const key = keyForDiskPath(diskPath);
                    const chunks = [];
                    file.stream.on('data', chunk => chunks.push(chunk));
                    file.stream.on('error', cb);
                    file.stream.on('end', () => {
                        const body = Buffer.concat(chunks);
                        client.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: body, ContentType: file.mimetype, CacheControl: CACHE_CONTROL }))
                            .then(() => cb(null, { destination: dir, filename: name, path: diskPath, size: body.length, key }), cb);
                    });
                });
            });
        },
        _removeFile(req, file, cb) {
            if (!enabled) return disk._removeFile(req, file, cb);
            client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: file.key }))
                .then(() => cb(null), cb);
        }
    };
}

async function putBuffer(key, buffer, contentType) {
    if (!enabled) {
        const target = diskPathForKey(key);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, buffer);
        return key;
    }
    await client.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: buffer, ContentType: contentType, CacheControl: CACHE_CONTROL }));
    return key;
}

async function objectExists(key) {
    if (!enabled) {
        try { return fs.statSync(diskPathForKey(key)).isFile(); } catch (e) { return false; }
    }
    try {
        await client.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
        return true;
    } catch (err) {
        if (isMissing(err)) return false;
        throw err;
    }
}

// Returns the S3 GetObject response (Body is a stream) or null when the key does not exist.
async function getObject(key) {
    if (!enabled) return null;
    try {
        return await client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    } catch (err) {
        if (isMissing(err)) return null;
        throw err;
    }
}

// Best-effort: deleting something that was never there (or that only ever existed on disk, in
// disabled mode) is not an error — callers delete both the disk path and this in one pass.
async function deleteObject(key) {
    if (!enabled) return;
    try {
        await client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    } catch (err) {
        if (!isMissing(err)) throw err;
    }
}

// pdfkit writes PDFs to a real path on disk (lib/contracts.js, lib/invoicing.js, js/pdfService.js) —
// that code is unchanged. Call this right after generation succeeds to also push the bytes to R2 under
// the matching key; a no-op when R2 isn't configured, so the file generated on disk is already the
// full, correct result in that mode.
async function syncFileToStorage(diskPath) {
    if (!enabled) return;
    const buffer = fs.readFileSync(diskPath);
    const contentType = diskPath.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream';
    await putBuffer(keyForDiskPath(diskPath), buffer, contentType);
}

// Reads a generated/uploaded document as a Buffer — R2 first when enabled, else disk. Used wherever a
// file used to be handed to something (email attachments, hashing) by path.
async function readFile(diskPath) {
    if (enabled) {
        const obj = await getObject(keyForDiskPath(diskPath));
        if (obj) {
            const chunks = [];
            for await (const chunk of obj.Body) chunks.push(chunk);
            return Buffer.concat(chunks);
        }
    }
    return fs.readFileSync(diskPath);
}

async function fileExists(diskPath) {
    return objectExists(keyForDiskPath(diskPath));
}

// Mirrors deleting an upload everywhere it might have landed — both are best-effort; neither throws
// for a file that was never there in that location.
async function deleteFile(diskPath) {
    try { fs.unlinkSync(diskPath); } catch (err) { if (err.code !== 'ENOENT') console.error('[object-storage] disk delete failed:', diskPath, err.message); }
    await deleteObject(keyForDiskPath(diskPath));
}

// The single lookup every document download route needs: R2 first (when enabled), else the existing
// resolveDocsPath() two-tier disk fallback (DOCS_PATH, then the legacy in-repo docs/ folder). Returns
// { stream, contentType, contentLength } for an R2 hit, { diskPath } for a disk hit, or null for neither
// — callers branch on which shape came back once, right before actually sending the response.
async function resolveDocument(section, filename) {
    if (enabled) {
        const obj = await getObject(`docs/${section}/${filename}`);
        if (obj) return { stream: obj.Body, contentType: obj.ContentType || 'application/pdf', contentLength: obj.ContentLength };
    }
    const diskPath = resolveDocsPath(section, filename);
    return fs.existsSync(diskPath) ? { diskPath } : null;
}

module.exports = {
    enabled, keyForDiskPath, diskPathForKey, multerStorage, putBuffer, objectExists, getObject,
    deleteObject, syncFileToStorage, readFile, fileExists, deleteFile, resolveDocument
};

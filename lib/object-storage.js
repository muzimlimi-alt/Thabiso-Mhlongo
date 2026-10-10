// Object storage for admin-uploaded files. With R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID and
// R2_SECRET_ACCESS_KEY set, uploads go to a Cloudflare R2 bucket and survive redeploys; without them
// everything stays on local disk (development and the test suite). Keys mirror the site's public
// /images/... paths, so existing database rows keep working unchanged.
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { UPLOADS_PATH } = require('./runtime-paths');

const { R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;
const enabled = Boolean(R2_ENDPOINT && R2_BUCKET && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY);
const CACHE_CONTROL = 'public, max-age=604800';
const client = enabled ? new S3Client({
    region: 'auto',
    endpoint: R2_ENDPOINT,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY }
}) : null;

function keyForDiskPath(absPath) {
    return 'images/' + path.relative(UPLOADS_PATH, absPath).split(path.sep).join('/');
}

function diskPathForKey(key) {
    return path.join(UPLOADS_PATH, key.replace(/^images\//, ''));
}

function isMissing(err) {
    return err.name === 'NoSuchKey' || err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404;
}

// A drop-in replacement for multer.diskStorage(): same destination/filename callbacks, and the same
// req.file fields (destination, filename, size) that routes already read. With R2 enabled the bytes go
// to the bucket instead of disk, so routes must build paths from req.file.filename, never req.file.path.
function multerStorage(options) {
    const disk = multer.diskStorage(options);
    return {
        _handleFile(req, file, cb) {
            if (!enabled) return disk._handleFile(req, file, cb);
            options.destination(req, file, (destErr, dir) => {
                if (destErr) return cb(destErr);
                options.filename(req, file, (nameErr, name) => {
                    if (nameErr) return cb(nameErr);
                    const key = keyForDiskPath(path.join(dir, name));
                    const chunks = [];
                    file.stream.on('data', chunk => chunks.push(chunk));
                    file.stream.on('error', cb);
                    file.stream.on('end', () => {
                        const body = Buffer.concat(chunks);
                        client.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: body, ContentType: file.mimetype, CacheControl: CACHE_CONTROL }))
                            .then(() => cb(null, { destination: dir, filename: name, size: body.length, key }), cb);
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

module.exports = { enabled, keyForDiskPath, diskPathForKey, multerStorage, putBuffer, objectExists, getObject };

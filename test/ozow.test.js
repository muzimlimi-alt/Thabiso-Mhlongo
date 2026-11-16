const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    ozowCreds,
    generateRequestHash,
    generateNotificationHash,
    verifyNotificationHash,
    buildOzowPaymentRequest,
    ozowBaseUrl,
    isOzowComplete,
    isOzowCancelled,
    isOzowError,
    isOzowPending
} = require('../lib/ozow');
const crypto = require('crypto');

const TEST_ENV = {
    OZOW_SITE_CODE: 'TST-001',
    OZOW_API_KEY: 'testapikey123',
    OZOW_PRIVATE_KEY: 'testprivatekey456',
    OZOW_TEST_MODE: 'true',
    BASE_URL: 'https://example.com'
};

describe('ozowCreds', () => {
    it('reads credentials from env', () => {
        const c = ozowCreds(TEST_ENV);
        assert.equal(c.siteCode, 'TST-001');
        assert.equal(c.apiKey, 'testapikey123');
        assert.equal(c.privateKey, 'testprivatekey456');
        assert.equal(c.isTest, true);
    });

    it('defaults isTest to false when unset', () => {
        const c = ozowCreds({ OZOW_SITE_CODE: 'X' });
        assert.equal(c.isTest, false);
    });

    it('treats "1" as test mode (admin checkbox value)', () => {
        const c = ozowCreds({ ...TEST_ENV, OZOW_TEST_MODE: '1' });
        assert.equal(c.isTest, true);
    });

    it('treats "0" as live mode', () => {
        const c = ozowCreds({ ...TEST_ENV, OZOW_TEST_MODE: '0' });
        assert.equal(c.isTest, false);
    });

    it('returns empty strings when nothing is set', () => {
        const c = ozowCreds({});
        assert.equal(c.siteCode, '');
        assert.equal(c.privateKey, '');
        assert.equal(c.apiKey, '');
    });
});

describe('generateRequestHash', () => {
    it('produces a 128-char lowercase hex SHA-512', () => {
        const fields = {
            siteCode: 'TST-001', countryCode: 'ZA', currencyCode: 'ZAR',
            amount: '100.00', transactionReference: 'REF-1',
            bankReference: 'BK-1', cancelUrl: 'https://x.com/cancel',
            errorUrl: 'https://x.com/error', successUrl: 'https://x.com/success',
            notifyUrl: 'https://x.com/notify', isTest: true
        };
        const hash = generateRequestHash(fields, 'secret');
        assert.equal(hash.length, 128);
        assert.match(hash, /^[0-9a-f]{128}$/);
    });

    it('skips empty / undefined fields', () => {
        const fields = { siteCode: 'A', countryCode: 'ZA', currencyCode: 'ZAR', amount: '50.00', transactionReference: 'R1' };
        const hash = generateRequestHash(fields, 'key');
        const expected = crypto.createHash('sha512').update('azazar50.00r1key'.toLowerCase()).digest('hex');
        assert.equal(hash, expected);
    });

    it('is deterministic', () => {
        const fields = { siteCode: 'X', amount: '10.00' };
        assert.equal(generateRequestHash(fields, 'k'), generateRequestHash(fields, 'k'));
    });
});

describe('generateNotificationHash / verifyNotificationHash', () => {
    const PRIVATE_KEY = 'myprivkey';

    function makeNotification(overrides) {
        const data = {
            SiteCode: 'TST-001', TransactionId: 'txn-abc', TransactionReference: 'REF-1',
            Amount: '100.00', Status: 'Complete', CurrencyCode: 'ZAR', IsTest: 'true',
            StatusMessage: 'The transaction was successful', SubStatus: 'None',
            ...overrides
        };
        data.Hash = generateNotificationHash(data, PRIVATE_KEY);
        return data;
    }

    it('generates a valid hash that can be verified', () => {
        const data = makeNotification();
        const result = verifyNotificationHash(data, PRIVATE_KEY);
        assert.equal(result.valid, true);
    });

    it('rejects a tampered Amount', () => {
        const data = makeNotification();
        data.Amount = '200.00';
        assert.equal(verifyNotificationHash(data, PRIVATE_KEY).valid, false);
    });

    it('rejects a wrong private key', () => {
        const data = makeNotification();
        assert.equal(verifyNotificationHash(data, 'wrongkey').valid, false);
    });

    it('rejects when Hash is missing', () => {
        const data = makeNotification();
        delete data.Hash;
        assert.equal(verifyNotificationHash(data, PRIVATE_KEY).valid, false);
    });

    it('SubStatus is NOT included in the hash', () => {
        const a = makeNotification({ SubStatus: 'None' });
        const b = makeNotification({ SubStatus: 'PendingInvestigation' });
        assert.equal(a.Hash, b.Hash);
    });

    it('skips empty optional fields', () => {
        const a = makeNotification({ Optional1: '', Optional2: '' });
        const b = makeNotification({});
        assert.equal(a.Hash, b.Hash);
    });

    it('includes populated optional fields', () => {
        const a = makeNotification({ Optional1: 'booking_42' });
        const b = makeNotification({});
        assert.notEqual(a.Hash, b.Hash);
    });
});

describe('buildOzowPaymentRequest', () => {
    it('returns requestBody, apiUrl, apiKey', () => {
        const result = buildOzowPaymentRequest({
            transactionReference: 'PF-123',
            bankReference: 'BK-123',
            amount: '500.00',
            customer: 'test@example.com',
            cancelUrl: 'https://x.com/cancel',
            errorUrl: 'https://x.com/error',
            successUrl: 'https://x.com/success',
            notifyUrl: 'https://x.com/notify'
        }, TEST_ENV);

        assert.equal(typeof result.requestBody, 'object');
        assert.equal(result.requestBody.siteCode, 'TST-001');
        assert.equal(result.requestBody.countryCode, 'ZA');
        assert.equal(result.requestBody.currencyCode, 'ZAR');
        assert.equal(result.requestBody.amount, '500.00');
        assert.equal(result.requestBody.transactionReference, 'PF-123');
        assert.equal(result.requestBody.isTest, true);
        assert.equal(typeof result.requestBody.hashCheck, 'string');
        assert.equal(result.requestBody.hashCheck.length, 128);
        assert.ok(result.apiUrl.includes('stagingapi.ozow.com'));
        assert.equal(result.apiKey, 'testapikey123');
    });

    it('uses live API URL when test mode is off', () => {
        const env = { ...TEST_ENV, OZOW_TEST_MODE: 'false' };
        const result = buildOzowPaymentRequest({
            transactionReference: 'X', amount: '10.00',
            cancelUrl: 'https://x.com/c', errorUrl: 'https://x.com/e',
            successUrl: 'https://x.com/s', notifyUrl: 'https://x.com/n'
        }, env);
        assert.ok(result.apiUrl.includes('api.ozow.com'));
        assert.ok(!result.apiUrl.includes('staging'));
    });

    it('truncates bankReference to 20 chars', () => {
        const result = buildOzowPaymentRequest({
            transactionReference: 'X',
            bankReference: 'A_VERY_LONG_BANK_REFERENCE_THAT_EXCEEDS_TWENTY',
            amount: '10.00', cancelUrl: 'u', errorUrl: 'u', successUrl: 'u', notifyUrl: 'u'
        }, TEST_ENV);
        assert.ok(result.requestBody.bankReference.length <= 20);
    });
});

describe('ozowBaseUrl', () => {
    it('prefers OZOW_BASE_URL', () => {
        assert.equal(ozowBaseUrl(null, { OZOW_BASE_URL: 'https://tunnel.dev/', BASE_URL: 'https://live.com' }), 'https://tunnel.dev');
    });

    it('falls back to BASE_URL', () => {
        assert.equal(ozowBaseUrl(null, { BASE_URL: 'https://live.com/' }), 'https://live.com');
    });

    it('defaults to localhost', () => {
        assert.equal(ozowBaseUrl(null, {}), 'http://localhost:3000');
    });
});

describe('status helpers', () => {
    it('isOzowComplete', () => {
        assert.equal(isOzowComplete('Complete'), true);
        assert.equal(isOzowComplete('Cancelled'), false);
    });
    it('isOzowCancelled', () => {
        assert.equal(isOzowCancelled('Cancelled'), true);
        assert.equal(isOzowCancelled('Complete'), false);
    });
    it('isOzowError', () => {
        assert.equal(isOzowError('Error'), true);
    });
    it('isOzowPending', () => {
        assert.equal(isOzowPending('PendingInvestigation'), true);
    });
});

'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Build one anchor payload (~400-450 bytes as JSON on-chain).
function makeAnchorArgs(id) {
    const hash = crypto.randomBytes(32).toString('hex');            // SHA-256 hex (64 chars)
    const sig = crypto.randomBytes(64).toString('base64');          // clinician signature
    return [
        id,
        'patient-' + crypto.randomBytes(8).toString('hex'),         // pseudonymous ref
        hash,
        'https://store.example.org/ehr/' + hash.slice(0, 32),       // storage URI
        'ImagingStudy',
        new Date().toISOString(),
        sig
    ];
}

// Per-transaction log written to JSONL at cleanup (primary data for analysis).
class TxLog {
    constructor(dir, name) { this.dir = dir; this.name = name; this.rows = []; }
    add(startMs, endMs, ok, err) {
        this.rows.push({ s: startMs, e: endMs, ok: ok ? 1 : 0, err: err || '' });
    }
    flush() {
        fs.mkdirSync(this.dir, { recursive: true });
        const f = path.join(this.dir, this.name + '.jsonl');
        fs.writeFileSync(f, this.rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    }
}

// Normalise whatever sendRequests returns into {ok, err}.
function statusOf(res) {
    const r = Array.isArray(res) ? res[0] : res;
    if (!r) return { ok: true, err: '' };
    if (typeof r.GetStatus === 'function') {
        const ok = r.GetStatus() === 'success';
        let err = '';
        if (!ok) {
            err = (typeof r.GetErrMsg === 'function' && r.GetErrMsg()) ||
                  (typeof r.GetResult === 'function' && String(r.GetResult())) || 'failed';
        }
        return { ok, err: String(err).slice(0, 300) };
    }
    return { ok: true, err: '' };
}

module.exports = { makeAnchorArgs, TxLog, statusOf };

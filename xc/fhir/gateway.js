'use strict';
// Minimal FHIR R4 gateway in front of the Fabric anchor chaincode (prototype of "Layer 4").
//  POST /fhir/{Patient|Observation|DocumentReference}   create: AES-256-GCM encrypt -> SHA-256 of ciphertext -> anchor on Fabric
//  GET  /fhir/{type}/{id}                               read: fetch anchor, verify hash, decrypt, return the resource
//  GET  /fhir/metadata                                  CapabilityStatement
// Auth: bearer token "sub|scope|exp|hmac" (stand-in for OAuth2/OIDC access token), scopes system/*.read, system/*.write.
// Off-chain object store is in memory here (stand-in for cloud storage); that is a limitation stated in the paper.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const grpc = require('@grpc/grpc-js');
const { connect, signers } = require('@hyperledger/fabric-gateway');
const FS = process.env.FS_DIR, PORT = +(process.env.FHIR_PORT || 8080), SECRET = Buffer.from(process.env.TOKEN_SECRET || 'dev-secret-change-me');
const TYPES = ['Patient', 'Observation', 'DocumentReference'];
const store = new Map();

function mkContract() {
  const d = 'example.com', base = path.join(FS, 'test-network', 'organizations', 'peerOrganizations', 'org1.' + d);
  const tls = fs.readFileSync(path.join(base, 'peers', 'peer0.org1.' + d, 'tls', 'ca.crt'));
  const ud = path.join(base, 'users', 'User1@org1.' + d, 'msp');
  const cert = fs.readFileSync(path.join(ud, 'signcerts', fs.readdirSync(path.join(ud, 'signcerts'))[0]));
  const key = fs.readFileSync(path.join(ud, 'keystore', fs.readdirSync(path.join(ud, 'keystore'))[0]));
  const client = new grpc.Client('127.0.0.1:7051', grpc.credentials.createSsl(tls), { 'grpc.ssl_target_name_override': 'peer0.org1.' + d });
  const gw = connect({ client, identity: { mspId: 'Org1MSP', credentials: cert }, signer: signers.newPrivateKeySigner(crypto.createPrivateKey(key)),
    evaluateOptions: () => ({ deadline: Date.now() + 15000 }), endorseOptions: () => ({ deadline: Date.now() + 30000 }),
    submitOptions: () => ({ deadline: Date.now() + 30000 }), commitStatusOptions: () => ({ deadline: Date.now() + 60000 }) });
  return gw.getNetwork('mychannel').getContract('ehr');
}
const contract = process.env.MOCK_FABRIC === '1' ? (() => { const m = new Map();   // local logic test only, never used for reported numbers
  return { submitTransaction: async (f, id, pr, h, uri, rt) => { m.set(id, { id, hashSha256: h, resourceType: rt }); },
           evaluateTransaction: async (f, id) => { if (!m.has(id)) throw new Error('not found'); return Buffer.from(JSON.stringify(m.get(id))); } }; })() : mkContract();

const mac = p => crypto.createHmac('sha256', SECRET).update(p).digest('hex');
function auth(req, need) {
  const h = req.headers.authorization || ''; if (!h.startsWith('Bearer ')) return 401;
  const t = h.slice(7), i = t.lastIndexOf('|'); if (i < 0) return 401;
  const p = t.slice(0, i), m = t.slice(i + 1);
  if (m.length !== 64 || !crypto.timingSafeEqual(Buffer.from(m), Buffer.from(mac(p)))) return 401;
  const [, scope, exp] = p.split('|'); if (+exp < Date.now()) return 401;
  return scope.split(' ').includes(need) ? 200 : 403;
}
const outcome = (code, sev, msg) => ({ resourceType: 'OperationOutcome', issue: [{ severity: sev, code, diagnostics: msg }] });
function send(res, status, body, extra = {}) { const b = JSON.stringify(body); res.writeHead(status, { 'Content-Type': 'application/fhir+json', 'Content-Length': Buffer.byteLength(b), ...extra }); res.end(b); }
function validShape(r) {   // light structural check; full conformance is checked with the HL7 validator in the test suite
  if (!r || typeof r !== 'object') return 'body is not a JSON object';
  if (!TYPES.includes(r.resourceType)) return 'unsupported or missing resourceType';
  if (r.id !== undefined && !/^[A-Za-z0-9\-.]{1,64}$/.test(r.id)) return 'invalid id';
  if (r.resourceType === 'Observation' && (!r.status || !r.code)) return 'Observation requires status and code';
  if (r.resourceType === 'DocumentReference' && (!r.status || !r.content)) return 'DocumentReference requires status and content';
  return null;
}
async function body(req) { const c = []; for await (const x of req) c.push(x); return Buffer.concat(c).toString('utf8'); }

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x'), seg = u.pathname.split('/').filter(Boolean);
    if (seg[0] === 'fhir' && seg[1] === 'metadata' && req.method === 'GET')
      return send(res, 200, { resourceType: 'CapabilityStatement', status: 'active', date: '2026-10-07', kind: 'instance', fhirVersion: '4.0.1', format: ['json'],
        rest: [{ mode: 'server', resource: TYPES.map(t => ({ type: t, interaction: [{ code: 'create' }, { code: 'read' }] })) }] });
    if (process.env.FHIR_TEST_MODE === '1' && seg[0] === 'admin' && seg[1] === 'tamper') { const o = store.get(seg[2]); if (!o) return send(res, 404, outcome('not-found', 'error', 'no such object')); o.ct[0] ^= 1; return send(res, 200, { tampered: seg[2] }); }
    if (seg[0] !== 'fhir' || !TYPES.includes(seg[1])) return send(res, 404, outcome('not-found', 'error', 'unknown path'));
    if (req.method === 'POST' && seg.length === 2) {
      const a = auth(req, 'system/*.write'); if (a !== 200) return send(res, a, outcome(a === 401 ? 'login' : 'forbidden', 'error', a === 401 ? 'missing or invalid token' : 'insufficient scope'));
      let r; try { r = JSON.parse(await body(req)); } catch { return send(res, 400, outcome('structure', 'error', 'invalid JSON')); }
      const bad = validShape(r); if (bad || r.resourceType !== seg[1]) return send(res, 422, outcome('invalid', 'error', bad || 'resourceType does not match URL'));
      const id = crypto.randomUUID(); r.id = id; r.meta = { versionId: '1', lastUpdated: new Date().toISOString() };
      const k = crypto.randomBytes(32), iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', k, iv);
      const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(r))), c.final()]), hash = crypto.createHash('sha256').update(ct).digest('hex');
      store.set(id, { k, iv, tag: c.getAuthTag(), ct });
      await contract.submitTransaction('CreateRecord', id, 'patient-' + crypto.randomBytes(8).toString('hex'), hash, 'mem://' + id, r.resourceType, r.meta.lastUpdated, crypto.randomBytes(64).toString('base64'));
      return send(res, 201, r, { Location: `/fhir/${r.resourceType}/${id}/_history/1`, ETag: 'W/"1"' });
    }
    if (req.method === 'GET' && seg.length === 3) {
      const a = auth(req, 'system/*.read'); if (a !== 200) return send(res, a, outcome(a === 401 ? 'login' : 'forbidden', 'error', a === 401 ? 'missing or invalid token' : 'insufficient scope'));
      let anchor; try { anchor = JSON.parse(Buffer.from(await contract.evaluateTransaction('ReadRecord', seg[2])).toString('utf8')); } catch { return send(res, 404, outcome('not-found', 'error', 'no such resource')); }
      if (anchor.resourceType !== seg[1]) return send(res, 404, outcome('not-found', 'error', 'no such resource'));
      const o = store.get(seg[2]); if (!o) return send(res, 503, outcome('transient', 'error', 'off-chain object unavailable'));
      if (crypto.createHash('sha256').update(o.ct).digest('hex') !== anchor.hashSha256) return send(res, 502, outcome('security', 'fatal', 'integrity check failed: ciphertext hash differs from on-chain anchor'));
      const d = crypto.createDecipheriv('aes-256-gcm', o.k, o.iv); d.setAuthTag(o.tag);
      return send(res, 200, JSON.parse(Buffer.concat([d.update(o.ct), d.final()]).toString('utf8')), { ETag: 'W/"1"' });
    }
    return send(res, 405, outcome('not-supported', 'error', 'method not allowed'));
  } catch (e) { return send(res, 500, outcome('exception', 'fatal', String(e.message || e).slice(0, 120))); }
});
server.listen(PORT, '127.0.0.1', () => console.log('FHIR gateway listening on', PORT));

'use strict';
// Cross-cluster benchmark for the EHR anchor architecture.
//  - Bridge: verifies a consent token, fetches an anchor from ANOTHER Fabric cluster (through an emulated WAN link),
//    re-computes SHA-256 over the (AES-256-GCM) ciphertext, decrypts, then records a CrossRef receipt on the local ledger.
//  - Scale-out: open-loop writes to 1 cluster vs 2 clusters at the same per-cluster offered rate.
// All per-operation timings are written as JSONL; summary rows go to summary.csv. Nothing is tuned or filtered.
const fs = require('fs'), path = require('path'), net = require('net'), crypto = require('crypto');
const grpc = require('@grpc/grpc-js');
const { connect, signers } = require('@hyperledger/fabric-gateway');

const FS = process.env.FS_DIR;                       // .../fabric-samples
const OUT = process.env.OUT_DIR || 'results/xc';
const MODE = process.env.MODE || 'smoke';            // smoke | full
const REPS = +(process.env.REPS || 3);
const OBJ_KB = +(process.env.OBJ_KB || 1024);        // size of the encrypted off-chain object
const NOBJ = +(process.env.NOBJ || 40);
const RTTS = (process.env.RTTS || '0,20,50,100,200').split(',').map(Number);
const RATES = (process.env.RATES || '25,50,100,150').split(',').map(Number);
const DUR = +(process.env.DUR || 30);
fs.mkdirSync(OUT, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const pct = (a, p) => a.length ? a[Math.min(a.length - 1, Math.floor(p / 100 * a.length))] : NaN;

// ---------- host CPU (whole VM) ----------
function cpuNow() { const l = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].split(/\s+/).slice(1).map(Number);
  const idle = l[3] + l[4], tot = l.slice(0, 8).reduce((a, b) => a + b, 0); return { idle, tot }; }
const cpuPct = (a, b) => 100 * (1 - (b.idle - a.idle) / (b.tot - a.tot));

// ---------- cluster connections ----------
function dom(c) { return c === 'A' ? 'example.com' : 'b.example.com'; }
function ports(c) { return c === 'A' ? 7051 : 17051; }
function mkGateway(cluster, endpointPort) {
  const d = dom(cluster), base = path.join(FS, cluster === 'A' ? 'test-network' : 'test-network-b', 'organizations', 'peerOrganizations', 'org1.' + d);
  const tls = fs.readFileSync(path.join(base, 'peers', 'peer0.org1.' + d, 'tls', 'ca.crt'));
  const ud = path.join(base, 'users', 'User1@org1.' + d, 'msp');
  const cert = fs.readFileSync(path.join(ud, 'signcerts', fs.readdirSync(path.join(ud, 'signcerts'))[0]));
  const key = fs.readFileSync(path.join(ud, 'keystore', fs.readdirSync(path.join(ud, 'keystore'))[0]));
  const client = new grpc.Client('127.0.0.1:' + endpointPort, grpc.credentials.createSsl(tls),
    { 'grpc.ssl_target_name_override': 'peer0.org1.' + d });
  const gw = connect({ client, identity: { mspId: 'Org1MSP', credentials: cert },
    signer: signers.newPrivateKeySigner(crypto.createPrivateKey(key)),
    evaluateOptions: () => ({ deadline: Date.now() + 15000 }), endorseOptions: () => ({ deadline: Date.now() + 30000 }),
    submitOptions: () => ({ deadline: Date.now() + 30000 }), commitStatusOptions: () => ({ deadline: Date.now() + 60000 }) });
  return { gw, contract: gw.getNetwork('mychannel').getContract('ehr'), client };
}

// ---------- emulated WAN: TCP proxy delaying every chunk by rtt/2 in each direction ----------
const wan = { oneWay: 0 };
function startProxy(listenPort, targetPort) {
  return new Promise(res => {
    const srv = net.createServer(c => {
      const t = net.connect(targetPort, '127.0.0.1');
      const fwd = (s, d) => s.on('data', x => { const w = wan.oneWay; if (w > 0) setTimeout(() => { if (!d.destroyed) d.write(x); }, w); else d.write(x); });
      fwd(c, t); fwd(t, c);
      c.on('close', () => t.destroy()); t.on('close', () => c.destroy()); c.on('error', () => {}); t.on('error', () => {});
    });
    srv.listen(listenPort, '127.0.0.1', () => res(srv));
  });
}

// ---------- chaincode helpers ----------
let ctr = 0;
const uid = tag => `${tag}-${Date.now()}-${process.pid}-${ctr++}`;
const dec = u => Buffer.from(u).toString('utf8');
async function createAnchor(contract, id, hash, uri) {
  await contract.submitTransaction('CreateRecord', id, 'patient-' + crypto.randomBytes(8).toString('hex'), hash, uri,
    'ImagingStudy', new Date().toISOString(), crypto.randomBytes(64).toString('base64'));
}
async function withRetry(f, n = 20) { let e; for (let i = 0; i < n; i++) { try { return await f(); } catch (x) { e = x; await sleep(500); } } throw e; }

// ---------- encrypted off-chain objects (AES-256-GCM, hash anchored over ciphertext) ----------
function makeObject(i) {
  const key = crypto.randomBytes(32), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(crypto.randomBytes(OBJ_KB * 1024)), c.final()]);
  return { key, iv, tag: c.getAuthTag(), ct, hash: sha256(ct) };
}
function verifyAndDecrypt(obj, anchorHash) {
  if (!obj) throw new Error('object-unavailable');
  if (sha256(obj.ct) !== anchorHash) throw new Error('hash-mismatch');
  const d = crypto.createDecipheriv('aes-256-gcm', obj.key, obj.iv); d.setAuthTag(obj.tag);
  d.update(obj.ct); d.final();
}

// ---------- bridge (runs "in the requester's city") ----------
const TOKEN_KEY = crypto.randomBytes(32);   // stands in for the federation trust anchor (OIDC/MSP) in this prototype
const mkToken = (who, rec, exp) => { const p = `${who}|${rec}|${exp}`; return p + '|' + crypto.createHmac('sha256', TOKEN_KEY).update(p).digest('hex'); };
function checkToken(tok, who, rec) {
  const i = tok.lastIndexOf('|'), p = tok.slice(0, i), mac = tok.slice(i + 1);
  const ok = crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(crypto.createHmac('sha256', TOKEN_KEY).update(p).digest('hex')));
  const [w, r, exp] = p.split('|');
  if (!ok || w !== who || r !== rec || +exp < Date.now()) throw new Error('token-denied');
}
const audit = [];
async function bridgeRead({ remote, local, store, recId, who, token, srcCluster }) {
  const t0 = process.hrtime.bigint(); const mark = () => Number(process.hrtime.bigint() - t0) / 1e6; const st = {};
  try {
    checkToken(token, who, recId); st.auth = mark();
    const a = JSON.parse(dec(await remote.evaluateTransaction('ReadRecord', recId))); st.fetch = mark();
    verifyAndDecrypt(store.get(recId), a.hashSha256); st.verify = mark();
    await local.submitTransaction('CreateCrossRef', uid('xref'), srcCluster, recId, a.hashSha256, new Date().toISOString(), who);
    st.receipt = mark(); audit.push({ rec: recId, res: 'allow' });
    return { ok: 1, err: '', st, ms: st.receipt };
  } catch (e) {
    const m = String(e.message || e).slice(0, 80); audit.push({ rec: recId, res: 'deny', why: m });
    return { ok: 0, err: m, st, ms: mark() };
  }
}

// ---------- stats / output ----------
const SUMMARY = path.join(OUT, 'summary.csv');
if (!fs.existsSync(SUMMARY)) fs.writeFileSync(SUMMARY, 'phase,param,rep,n,ok,duration_s,tps,mean_ms,p50_ms,p95_ms,p99_ms,host_cpu_pct,auth_ms,fetch_ms,verify_ms,receipt_ms\n');
function summarize(phase, param, rep, rows, secs, cpu) {
  const okr = rows.filter(r => r.ok), l = okr.map(r => r.ms).sort((a, b) => a - b);
  const mean = l.length ? l.reduce((a, b) => a + b, 0) / l.length : NaN;
  const seg = k => { const v = okr.filter(r => r.st && r.st.receipt).map(r => k === 'auth' ? r.st.auth : k === 'fetch' ? r.st.fetch - r.st.auth : k === 'verify' ? r.st.verify - r.st.fetch : r.st.receipt - r.st.verify);
    return v.length ? (v.reduce((a, b) => a + b, 0) / v.length).toFixed(2) : ''; };
  const row = [phase, param, rep, rows.length, okr.length, secs.toFixed(1), (okr.length / secs).toFixed(2), mean.toFixed(1), pct(l, 50).toFixed(1), pct(l, 95).toFixed(1), pct(l, 99).toFixed(1),
    cpu.toFixed(0), seg('auth'), seg('fetch'), seg('verify'), seg('receipt')].join(',');
  fs.appendFileSync(SUMMARY, row + '\n');
  fs.writeFileSync(path.join(OUT, `${phase}_${param}_rep${rep}.jsonl`), rows.map(r => JSON.stringify({ ms: +r.ms.toFixed(2), ok: r.ok, err: r.err })).join('\n') + '\n');
  console.log(row);
}
const errCount = rows => { const m = {}; rows.filter(r => !r.ok).forEach(r => m[r.err] = (m[r.err] || 0) + 1); return m; };

// closed-loop, `conc` concurrent clients, n total ops
async function closedLoop(n, conc, op) {
  const rows = []; let next = 0; const c0 = cpuNow(), t0 = Date.now();
  await Promise.all(Array.from({ length: conc }, async () => { while (next < n) { const i = next++; rows.push(await op(i)); } }));
  return { rows, secs: (Date.now() - t0) / 1000, cpu: cpuPct(c0, cpuNow()) };
}
// open-loop fixed rate on one or more clusters (each gets `rate` tps)
async function openLoop(rate, secs, targets) {
  const out = targets.map(() => []); const c0 = cpuNow(), t0 = Date.now(); const pend = [];
  const total = rate * secs;
  for (let i = 0; i < total; i++) {
    const due = t0 + i * 1000 / rate; const w = due - Date.now(); if (w > 1) await sleep(w);
    targets.forEach((tg, k) => { const s = Date.now();
      pend.push(createAnchor(tg, uid('w'), crypto.randomBytes(32).toString('hex'), 'https://store.example.org/ehr/x')
        .then(() => out[k].push({ ok: 1, err: '', ms: Date.now() - s }), e => out[k].push({ ok: 0, err: String(e.message || e).slice(0, 60), ms: Date.now() - s }))); });
  }
  await Promise.all(pend);
  return { out, secs: (Date.now() - t0) / 1000, cpu: cpuPct(c0, cpuNow()) };
}

(async () => {
  const A = mkGateway('A', 7051);            // direct, local to A
  const B = mkGateway('B', 17051);           // direct, local to B (the bridge sits here)
  const proxy = await startProxy(27051, 7051);   // B-city -> A-city WAN link
  const AviaWAN = mkGateway('A', 27051);     // gateway client that reaches A through the emulated WAN
  console.log('connected; mode=' + MODE);

  // preload encrypted objects + anchors on both clusters
  const nobj = MODE === 'smoke' ? 5 : NOBJ;
  const storeA = new Map(), storeB = new Map(), idsA = [], idsB = [];
  for (let i = 0; i < nobj; i++) {
    for (const [c, st, ids, tag] of [[A.contract, storeA, idsA, 'A'], [B.contract, storeB, idsB, 'B']]) {
      const o = makeObject(i), id = uid('rec' + tag); st.set(id, o); ids.push(id);
      await withRetry(() => createAnchor(c, id, o.hash, 'https://store.example.org/ehr/' + o.hash.slice(0, 32)));
    }
  }
  console.log(`preloaded ${nobj} anchors per cluster (object ${OBJ_KB} KiB each)`);
  const who = 'clinicianB@cityB';
  const tok = id => mkToken(who, id, Date.now() + 3600e3);

  if (MODE === 'smoke') {
    wan.oneWay = 25;
    const r = await bridgeRead({ remote: AviaWAN.contract, local: B.contract, store: storeA, recId: idsA[0], who, token: tok(idsA[0]), srcCluster: 'A' });
    console.log('SMOKE cross-cluster read (RTT 50 ms):', JSON.stringify(r));
    const bad = await bridgeRead({ remote: AviaWAN.contract, local: B.contract, store: storeA, recId: idsA[1], who: 'intruder', token: tok(idsA[1]), srcCluster: 'A' });
    console.log('SMOKE bad identity:', JSON.stringify(bad));
    if (!r.ok || bad.ok) { console.error('SMOKE FAILED'); process.exit(1); }
    console.log('SMOKE OK'); process.exit(0);
  }

  // ---- 1. functional tests (security / availability behaviour of the bridge) ----
  wan.oneWay = 25;
  const func = []; const N = 50;
  const cases = {
    allowed: i => ({ recId: idsA[i % nobj], store: storeA, who, token: tok(idsA[i % nobj]) }),
    tampered_object: i => { const id = idsA[i % nobj]; const o = storeA.get(id), t = { ...o, ct: Buffer.from(o.ct) }; t.ct[0] ^= 1; return { recId: id, store: new Map([[id, t]]), who, token: tok(id) }; },
    object_unavailable: i => ({ recId: idsA[i % nobj], store: new Map(), who, token: tok(idsA[i % nobj]) }),
    token_for_other_record: i => ({ recId: idsA[i % nobj], store: storeA, who, token: tok(idsA[(i + 1) % nobj]) }),
    expired_token: i => ({ recId: idsA[i % nobj], store: storeA, who, token: mkToken(who, idsA[i % nobj], Date.now() - 1000) }),
    unknown_record: i => ({ recId: 'nope-' + i, store: storeA, who, token: tok('nope-' + i) })
  };
  for (const [name, f] of Object.entries(cases)) {
    let allow = 0, deny = 0; const why = {};
    for (let i = 0; i < N; i++) { const r = await bridgeRead({ remote: AviaWAN.contract, local: B.contract, srcCluster: 'A', ...f(i) }); if (r.ok) allow++; else { deny++; why[r.err] = (why[r.err] || 0) + 1; } }
    func.push({ case: name, n: N, allowed: allow, denied: deny, reasons: why });
  }
  fs.writeFileSync(path.join(OUT, 'functional.json'), JSON.stringify(func, null, 2)); console.log(JSON.stringify(func));

  // ---- 2. cross-cluster latency vs emulated WAN RTT (and intra-cluster baseline) ----
  for (let rep = 1; rep <= REPS; rep++) {
    const lp = await closedLoop(100, 1, i => bridgeRead({ remote: B.contract, local: B.contract, store: storeB, recId: idsB[i % nobj], who, token: tok(idsB[i % nobj]), srcCluster: 'B' }));
    summarize('intra', 'conc1', rep, lp.rows, lp.secs, lp.cpu);
    for (const rtt of RTTS) {
      wan.oneWay = rtt / 2;
      for (const conc of [1, 8]) {
        const n = conc === 1 ? 100 : 200;
        const r = await closedLoop(n, conc, i => bridgeRead({ remote: AviaWAN.contract, local: B.contract, store: storeA, recId: idsA[i % nobj], who, token: tok(idsA[i % nobj]), srcCluster: 'A' }));
        summarize('cross', `rtt${rtt}_conc${conc}`, rep, r.rows, r.secs, r.cpu);
        const e = errCount(r.rows); if (Object.keys(e).length) console.log('errors', JSON.stringify(e));
      }
    }
  }
  wan.oneWay = 0;

  // ---- 3. scale-out: same per-cluster offered rate, 1 cluster vs 2 clusters ----
  for (let rep = 1; rep <= REPS; rep++) for (const rate of RATES) {
    const s = await openLoop(rate, DUR, [A.contract]);   summarize('scale1', `rate${rate}`, rep, s.out[0], s.secs, s.cpu); await sleep(5000);
    const d = await openLoop(rate, DUR, [A.contract, B.contract]);
    summarize('scale2', `rate${rate}`, rep, d.out[0].concat(d.out[1]), d.secs, d.cpu); await sleep(5000);
  }
  fs.writeFileSync(path.join(OUT, 'audit_sample.json'), JSON.stringify(audit.slice(0, 50), null, 1));
  console.log('XC DONE'); process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });

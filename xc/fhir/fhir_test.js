'use strict';
// FHIR gateway test suite: (1) HL7 validator conformance of round-tripped resources, (2) negative/security behaviour, (3) end-to-end load.
const fs = require('fs'), path = require('path'), http = require('http'), crypto = require('crypto'), { spawnSync } = require('child_process');
const OUT = process.env.OUT_DIR || 'results/fhir', MODE = process.env.MODE || 'smoke', PORT = +(process.env.FHIR_PORT || 8080);
const SECRET = process.env.TOKEN_SECRET || 'dev-secret-change-me', NCONF = MODE === 'smoke' ? 3 : 30;
const RATES = (process.env.RATES || '10,25,50,100').split(',').map(Number), DUR = +(process.env.DUR || 20), REPS = +(process.env.REPS || 3);
const JAR = process.env.VALIDATOR_JAR || 'validator_cli.jar';
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tok = (scope, exp = Date.now() + 3600e3) => { const p = `tester|${scope}|${exp}`; return p + '|' + crypto.createHmac('sha256', SECRET).update(p).digest('hex'); };
const W = tok('system/*.write'), R = tok('system/*.read'), WR = tok('system/*.write system/*.read');
const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });

function call(method, p, token, body, raw) {
  return new Promise(res => {
    const t0 = process.hrtime.bigint(); const b = raw !== undefined ? raw : body ? JSON.stringify(body) : null;
    const rq = http.request({ host: '127.0.0.1', port: PORT, path: p, method, agent, headers: { 'Content-Type': 'application/fhir+json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(b ? { 'Content-Length': Buffer.byteLength(b) } : {}) } }, r => {
      const c = []; r.on('data', x => c.push(x)); r.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(c).toString()); } catch {} res({ status: r.statusCode, body: j, ms: Number(process.hrtime.bigint() - t0) / 1e6 }); });
    });
    rq.on('error', e => res({ status: 0, body: null, ms: Number(process.hrtime.bigint() - t0) / 1e6, err: e.message })); if (b) rq.write(b); rq.end();
  });
}
const rnd = n => crypto.randomInt(n);
const mk = {
  Patient: () => ({ resourceType: 'Patient', active: true, name: [{ family: 'Family' + rnd(1e4), given: ['Given' + rnd(1e4)] }], gender: ['male', 'female', 'other', 'unknown'][rnd(4)], birthDate: `19${50 + rnd(50)}-0${1 + rnd(9)}-1${rnd(9)}` }),
  Observation: () => ({ resourceType: 'Observation', status: 'final', category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs', display: 'Vital Signs' }] }], code: { coding: [{ system: 'http://loinc.org', code: '8867-4', display: 'Heart rate' }] }, subject: { reference: 'Patient/example' },
    effectiveDateTime: new Date().toISOString(), valueQuantity: { value: 50 + rnd(60), unit: 'beats/minute', system: 'http://unitsofmeasure.org', code: '/min' } }),
  DocumentReference: () => ({ resourceType: 'DocumentReference', status: 'current', type: { coding: [{ system: 'http://loinc.org', code: '18748-4', display: 'Diagnostic imaging study' }] }, subject: { reference: 'Patient/example' },
    content: [{ attachment: { contentType: 'application/pdf', url: 'urn:uuid:' + crypto.randomUUID(), title: 'Imaging report' } }] })
};
const pct = (a, p) => a.length ? a[Math.min(a.length - 1, Math.floor(p / 100 * a.length))] : NaN;
function cpuNow() { const l = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].split(/\s+/).slice(1).map(Number); return { idle: l[3] + l[4], tot: l.slice(0, 8).reduce((a, b) => a + b, 0) }; }

(async () => {
  for (let i = 0; i < 30; i++) { const r = await call('GET', '/fhir/metadata'); if (r.status === 200) break; await sleep(1000); }
  // ---- 0. capability statement ----
  const cap = await call('GET', '/fhir/metadata'); fs.writeFileSync(path.join(OUT, 'capability.json'), JSON.stringify(cap.body, null, 1));
  console.log('metadata', cap.status);

  // ---- 1. conformance: create, read back, validate with the HL7 validator ----
  const dir = path.join(OUT, 'roundtrip'); fs.mkdirSync(dir, { recursive: true }); const conf = {};
  for (const t of Object.keys(mk)) {
    let created = 0, readOk = 0, same = 0;
    for (let i = 0; i < NCONF; i++) {
      const c = await call('POST', '/fhir/' + t, W, mk[t]()); if (c.status !== 201) continue; created++;
      const g = await call('GET', `/fhir/${t}/${c.body.id}`, R); if (g.status === 200) { readOk++; if (JSON.stringify(g.body) === JSON.stringify(c.body)) same++; fs.writeFileSync(path.join(dir, `${t}_${i}.json`), JSON.stringify(g.body, null, 1)); }
    }
    conf[t] = { attempted: NCONF, created, read_ok: readOk, byte_identical_roundtrip: same };
  }
  const v = spawnSync('java', ['-jar', JAR, dir, '-version', '4.0.1', '-tx', 'n/a', '-output', path.join(OUT, 'validator_output.json')], { encoding: 'utf8', timeout: 900e3 });
  fs.writeFileSync(path.join(OUT, 'validator_stdout.txt'), (v.stdout || '') + '\n' + (v.stderr || ''));
  let vres = null; try { vres = JSON.parse(fs.readFileSync(path.join(OUT, 'validator_output.json'), 'utf8')); } catch {}
  if (vres) {
    const ocs = vres.resourceType === 'Bundle' ? (vres.entry || []).map(e => e.resource) : [vres];
    let errs = 0, warns = 0, bad = 0; ocs.forEach(o => { const is = (o.issue || []); const e = is.filter(x => ['error', 'fatal'].includes(x.severity)).length; errs += e; warns += is.filter(x => x.severity === 'warning').length; if (e) bad++; });
    conf._validator = { resources_validated: ocs.length, resources_with_errors: bad, errors: errs, warnings: warns, fhir_version: '4.0.1', terminology: 'disabled (-tx n/a)' };
  } else conf._validator = { error: 'validator output not parsed', exit: v.status };
  fs.writeFileSync(path.join(OUT, 'conformance.json'), JSON.stringify(conf, null, 2)); console.log(JSON.stringify(conf));

  // ---- 2. negative / security behaviour ----
  const good = await call('POST', '/fhir/Patient', W, mk.Patient()); const id = good.body && good.body.id;
  const neg = [], add = (name, r, want) => neg.push({ case: name, expected: want, got: r.status, pass: r.status === want });
  add('no token (read)', await call('GET', `/fhir/Patient/${id}`), 401);
  add('garbage token', await call('GET', `/fhir/Patient/${id}`, 'x|y|z'), 401);
  add('expired token', await call('GET', `/fhir/Patient/${id}`, tok('system/*.read', Date.now() - 1000)), 401);
  add('read scope used for create', await call('POST', '/fhir/Patient', R, mk.Patient()), 403);
  add('write scope used for read', await call('GET', `/fhir/Patient/${id}`, W), 403);
  add('unknown id', await call('GET', '/fhir/Patient/does-not-exist', R), 404);
  add('wrong type for existing id', await call('GET', `/fhir/Observation/${id}`, R), 404);
  add('malformed JSON', await call('POST', '/fhir/Patient', W, null, '{not json'), 400);
  add('resourceType mismatch', await call('POST', '/fhir/Patient', W, mk.Observation()), 422);
  add('Observation without status', await call('POST', '/fhir/Observation', W, { resourceType: 'Observation', code: { text: 'x' } }), 422);
  add('unsupported resource type', await call('POST', '/fhir/Medication', W, { resourceType: 'Medication' }), 404);
  const tam = await call('POST', '/fhir/Patient', W, mk.Patient()); await call('GET', `/admin/tamper/${tam.body.id}`, null);
  add('off-chain object tampered (integrity check)', await call('GET', `/fhir/Patient/${tam.body.id}`, R), 502);
  fs.writeFileSync(path.join(OUT, 'negative.json'), JSON.stringify(neg, null, 2)); console.log(JSON.stringify(neg.map(n => [n.case, n.got, n.pass])));
  if (MODE === 'smoke') { console.log('FHIR SMOKE DONE'); process.exit(0); }

  // ---- 3. end-to-end load through the gateway (open loop) ----
  const SUM = path.join(OUT, 'summary.csv'); fs.writeFileSync(SUM, 'phase,rate,rep,n,ok,duration_s,tps,mean_ms,p50_ms,p95_ms,p99_ms,host_cpu_pct\n');
  const seed = []; for (let i = 0; i < 100; i++) { const c = await call('POST', '/fhir/Observation', W, mk.Observation()); if (c.status === 201) seed.push(c.body.id); }
  for (let rep = 1; rep <= REPS; rep++) for (const rate of RATES) for (const phase of ['create', 'read']) {
    const rows = [], pend = [], c0 = cpuNow(), t0 = Date.now();
    for (let i = 0; i < rate * DUR; i++) {
      const due = t0 + i * 1000 / rate, w = due - Date.now(); if (w > 1) await sleep(w);
      pend.push((phase === 'create' ? call('POST', '/fhir/Observation', W, mk.Observation()) : call('GET', `/fhir/Observation/${seed[i % seed.length]}`, R)).then(r => rows.push({ ok: r.status === (phase === 'create' ? 201 : 200), ms: r.ms })));
    }
    await Promise.all(pend); const secs = (Date.now() - t0) / 1000, c1 = cpuNow(), ok = rows.filter(r => r.ok), l = ok.map(r => r.ms).sort((a, b) => a - b);
    const line = [phase, rate, rep, rows.length, ok.length, secs.toFixed(1), (ok.length / secs).toFixed(2), (l.reduce((a, b) => a + b, 0) / (l.length || 1)).toFixed(1), pct(l, 50).toFixed(1), pct(l, 95).toFixed(1), pct(l, 99).toFixed(1), (100 * (1 - (c1.idle - c0.idle) / (c1.tot - c0.tot))).toFixed(0)].join(',');
    fs.appendFileSync(SUM, line + '\n'); console.log(line); await sleep(3000);
  }
  console.log('FHIR DONE'); process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });

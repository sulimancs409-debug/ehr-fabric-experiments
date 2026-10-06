#!/usr/bin/env python3
"""Summarise raw per-transaction logs written by the Caliper workloads.

Usage: python3 analyze.py <results_dir>
Reads  <results_dir>/b<block>/c<clients>/rep<n>/{write,read}_w*.jsonl
Writes summary_runs.csv (one row per run), summary.csv (mean, SD over reps),
       failures.csv, resources.csv, table1.md
"""
import csv, glob, json, math, os, re, statistics as st, sys
from collections import defaultdict, Counter

root = sys.argv[1] if len(sys.argv) > 1 else "."

def pct(sorted_vals, p):
    if not sorted_vals: return float("nan")
    k = (len(sorted_vals) - 1) * p / 100.0
    lo, hi = math.floor(k), math.ceil(k)
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (k - lo)

def classify(err):
    e = (err or "").upper()
    if "MVCC" in e: return "MVCC_READ_CONFLICT"
    if "PHANTOM" in e: return "PHANTOM_READ_CONFLICT"
    if "ENDORSEMENT" in e: return "ENDORSEMENT_POLICY_FAILURE"
    if "TIMEOUT" in e or "TIMED OUT" in e or "DEADLINE" in e: return "TIMEOUT"
    if "ALREADY EXISTS" in e: return "ALREADY_EXISTS"
    if "UNAVAILABLE" in e or "CONNECT" in e or "REFUSED" in e: return "CONNECTION"
    return "OTHER" if e else "UNKNOWN"

runs = []          # one dict per (block, clients, rep, op)
fail_rows = []
for repdir in sorted(glob.glob(os.path.join(root, "b*", "c*", "rep*"))):
    m = re.search(r"b(\d+)[/\\]c(\d+)[/\\]rep(\d+)$", repdir)
    if not m: continue
    block, clients, rep = map(int, m.groups())
    for op in ("write", "read"):
        txs = []
        for f in glob.glob(os.path.join(repdir, f"{op}_w*.jsonl")):
            with open(f) as fh:
                txs += [json.loads(l) for l in fh if l.strip()]
        if not txs: continue
        t0, t1 = min(t["s"] for t in txs), max(t["e"] for t in txs)
        window = max((t1 - t0) / 1000.0, 1e-9)
        ok = [t for t in txs if t["ok"]]
        lat = sorted(t["e"] - t["s"] for t in ok)
        runs.append(dict(block=block, clients=clients, rep=rep, op=op,
            total=len(txs), success=len(ok), fail=len(txs) - len(ok),
            success_pct=100.0 * len(ok) / len(txs), tps=len(ok) / window,
            lat_mean=st.mean(lat) if lat else float("nan"),
            lat_p50=pct(lat, 50), lat_p95=pct(lat, 95), lat_p99=pct(lat, 99)))
        for cause, n in Counter(classify(t["err"]) for t in txs if not t["ok"]).items():
            fail_rows.append(dict(block=block, clients=clients, rep=rep, op=op, cause=cause, count=n))

if not runs:
    sys.exit("No transaction logs found under " + root)

def write_csv(path, rows):
    if not rows: return
    with open(os.path.join(root, path), "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        w.writeheader(); w.writerows(rows)

write_csv("summary_runs.csv", runs)
write_csv("failures.csv", fail_rows)

# aggregate over repetitions
g = defaultdict(list)
for r in runs: g[(r["block"], r["clients"], r["op"])].append(r)
summary = []
metrics = ["tps", "lat_mean", "lat_p50", "lat_p95", "lat_p99", "success_pct"]
for (b, c, op), rs in sorted(g.items()):
    row = dict(block=b, clients=c, op=op, n_reps=len(rs))
    for m_ in metrics:
        vals = [r[m_] for r in rs]
        row[m_ + "_mean"] = st.mean(vals)
        row[m_ + "_sd"] = st.stdev(vals) if len(vals) > 1 else float("nan")
    row["total_failed_tx"] = sum(r["fail"] for r in rs)
    summary.append(row)
write_csv("summary.csv", summary)

# Table 1 in markdown: mean ± SD
def pm(row, k, d=0):
    sd = row[k + "_sd"]
    s = "n/a" if math.isnan(sd) else f"{sd:.{d}f}"
    return f"{row[k + '_mean']:.{d}f} ± {s}"
idx = {(r["block"], r["clients"], r["op"]): r for r in summary}
lines = ["| Block (max msgs) | Clients | Write TPS | Write latency mean (ms) | Write P95 (ms) | Write success (%) | Read TPS | Read latency mean (ms) | Read P95 (ms) | Read success (%) |",
         "|---|---|---|---|---|---|---|---|---|---|"]
for b, c in sorted({(r["block"], r["clients"]) for r in summary}):
    w, rd = idx.get((b, c, "write")), idx.get((b, c, "read"))
    if not w or not rd: continue
    lines.append(f"| {b} | {c} | {pm(w,'tps')} | {pm(w,'lat_mean')} | {pm(w,'lat_p95')} | {pm(w,'success_pct',1)} | "
                 f"{pm(rd,'tps')} | {pm(rd,'lat_mean')} | {pm(rd,'lat_p95')} | {pm(rd,'success_pct',1)} |")
with open(os.path.join(root, "table1.md"), "w") as fh: fh.write("\n".join(lines) + "\n")

# resource use sampled DURING each round (resources_ts.csv: ts_ms,name,cpu%,mem). Each sample is
# assigned to the write or read round by the time window of that round's per-transaction log.
def tomib(s):
    m = re.match(r"([\d.]+)\s*([KMG]i?B)", s.strip())
    if not m: return 0.0
    v, u = float(m.group(1)), m.group(2)
    return v * {"KiB": 1/1024, "KB": 1/1024, "MiB": 1, "MB": 1, "GiB": 1024, "GB": 1024}[u]
def short(n):
    for k in ("peer0.org1", "peer0.org2", "orderer", "couchdb0", "couchdb1", "HOST"):
        if n.startswith(k) or n == k: return k
    return "chaincode" if n.startswith("dev-") else n
res = defaultdict(lambda: {"cpu": [], "mem": []})
for f in glob.glob(os.path.join(root, "b*", "c*", "rep*", "resources_ts.csv")):
    m = re.search(r"b(\d+)[/\\]c(\d+)[/\\]", f); d = os.path.dirname(f)
    win = {}
    for op in ("write", "read"):
        S, E = [], []
        for jf in glob.glob(os.path.join(d, op + "_w*.jsonl")):
            for line in open(jf):
                try: o = json.loads(line); S.append(o["s"]); E.append(o["e"])
                except Exception: pass
        if S: win[op] = (min(S), max(E))
    with open(f) as fh:
        for row in csv.reader(fh):
            if len(row) < 4: continue
            try: ts = int(row[0]); cpu = float(row[2].strip("%") or 0)
            except ValueError: continue
            for op, (lo, hi) in win.items():
                if lo <= ts <= hi:
                    key = (int(m.group(1)), int(m.group(2)), op, short(row[1]))
                    res[key]["cpu"].append(cpu); res[key]["mem"].append(tomib(row[3].split("/")[0]))
rrows = [dict(block=b, clients=c, op=o, container=n, cpu_pct_mean=st.mean(v["cpu"]), cpu_pct_max=max(v["cpu"]),
              mem_mib_mean=st.mean(v["mem"]), samples=len(v["cpu"]))
         for (b, c, o, n), v in sorted(res.items())]
write_csv("resources.csv", rrows)
print(f"{len(runs)} run-rounds analysed; wrote summary.csv, summary_runs.csv, failures.csv, resources.csv, table1.md in {root}")

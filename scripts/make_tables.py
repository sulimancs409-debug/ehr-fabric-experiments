#!/usr/bin/env python3
"""Build all result tables (xlsx + csv) from data/. Usage: make_tables.py <data_dir> <out_dir>"""
import sys, os, json, glob, numpy as np, pandas as pd
D, OUT = sys.argv[1], sys.argv[2]; os.makedirs(OUT + "/csv", exist_ok=True)
src = open(os.path.join(os.path.dirname(__file__), "make_figures.py")).read().split("# F1/F2")[0]
final = f"{D}/final"; xc = None; out = "/tmp/_x"
import matplotlib; matplotlib.use("Agg")
exec(src.replace('final = sys.argv[1]; xc = sys.argv[2] if len(sys.argv) > 2 else None; out = sys.argv[3] if len(sys.argv) > 3 else "figures"', ''))
LAB = {"ldb_maj_100ms_b100": "LevelDB, both orgs endorse (default)", "ldb_any_100ms_b100": "LevelDB, 1-of-2 endorse", "couch_maj_100ms_b100": "CouchDB, both orgs endorse"}
T = {}
def fmt(m, s): return f"{m:.0f} ± {s:.0f}"
# Table 1 and 2: write / read, pooled over two runner instances
for op, name in [("write", "T1_write_path"), ("read", "T2_read_path")]:
    rows = []
    for n, lab in LAB.items():
        d = load(n); d = d[d.op == op].sort_values("clients")
        for _, r in d.iterrows():
            rows.append([lab, int(r.clients), fmt(r.tps_mean, r.tps_sd), round(r.lat_mean_mean, 1), round(r.lat_p50_mean, 1), round(r.lat_p95_mean, 1), round(r.lat_p99_mean, 1), round(r.success_pct_mean, 3), int(r.n_reps), int(r.total_failed_tx)])
    T[name] = pd.DataFrame(rows, columns=["Configuration", "Offered load (TPS)", "Achieved TPS (mean ± SD)", "Mean latency (ms)", "P50 (ms)", "P95 (ms)", "P99 (ms)", "Success (%)", "Repetitions", "Failed tx"])
# Table 3: block-size factor (MaxMessageCount), LevelDB, both orgs, write path
rows = []
for b in [10, 50, 100, 250]:
    d = load(f"ldb_maj_100ms_b{b}"); d = d[d.op == "write"].sort_values("clients")
    for _, r in d.iterrows(): rows.append([b, int(r.clients), fmt(r.tps_mean, r.tps_sd), round(r.lat_p50_mean, 1), round(r.lat_p95_mean, 1), round(r.lat_p99_mean, 1), int(r.n_reps)])
T["T3_block_size"] = pd.DataFrame(rows, columns=["MaxMessageCount", "Offered load (TPS)", "Achieved TPS (mean ± SD)", "P50 (ms)", "P95 (ms)", "P99 (ms)", "Repetitions"])
# Table 4: saturation summary
rows = []
for n, lab in list(LAB.items()) + [(f"ldb_maj_100ms_b{b}", f"LevelDB, both orgs, MaxMessageCount={b}") for b in (10, 50, 250)]:
    d = load(n); d = d[(d.op == "write") & (d.clients >= 300)]
    rows.append([lab, round(d.tps_mean.mean(), 0), round(d.lat_p95_mean.mean(), 0)])
T["T4_saturation"] = pd.DataFrame(rows, columns=["Configuration", "Saturation write TPS (mean over offered 300-600)", "P95 at saturation (ms)"])
# Table 5: run-to-run comparison (write TPS at offered 600)
rows = []
for n in sorted(os.listdir(f"{D}/final")):
    a = pd.read_csv(f"{D}/final/{n}/summary.csv") if os.path.exists(f"{D}/final/{n}/summary.csv") else _read(f"{D}/final", n, "summary.csv")
    b = _read(f"{D}/final_run2", n, "summary.csv")
    g = lambda s: float(s[(s.op == "write") & (s.clients == 600)].tps_mean.iloc[0])
    rows.append([n, round(g(a), 1), round(g(b), 1), round(100 * (g(b) - g(a)) / g(a), 1)])
T["T5_run_to_run"] = pd.DataFrame(rows, columns=["Configuration", "Run 1 write TPS @600", "Run 2 write TPS @600", "Difference (%)"])
# Table 6: failures
fa = json.load(open(f"{D}/final_run2/failure_audit.json"))
T["T6_failure_audit_run2"] = pd.DataFrame([[k, v["transactions"], v["failed"], round(100 * v["failed"] / v["transactions"], 4), v["failed_in_first_second_of_a_worker"], v["log_lines_no_endorsement_plan_available"]] for k, v in fa.items()],
    columns=["Configuration", "Transactions", "Failed", "Failure (%)", "Failed in first second of a worker", "Log: 'No endorsement plan available'"])
# Table 7: host CPU at saturation
rows = []
for n, lab in LAB.items():
    r = _read(final, n, "resources.csv"); r2 = _read(final + "_run2", n, "resources.csv")
    for x in (r, r2):
        if x is None: continue
    cat = pd.concat([r, r2]); d = cat[(cat.op == "write") & (cat.container == "HOST")].groupby("clients").cpu_pct_mean.mean()
    for c, v in d.items(): rows.append([lab, int(c), round(v, 1)])
T["T7_host_cpu"] = pd.DataFrame(rows, columns=["Configuration", "Offered load (TPS)", "Host CPU, mean over rounds (%)"])
# Table 8: cross-cluster
s = pd.read_csv(f"{D}/xc/summary.csv")
cr = s[s.phase.isin(["cross", "intra"])].copy(); cr["rtt"] = cr.param.str.extract(r"rtt(\d+)")[0]; cr["conc"] = cr.param.str.extract(r"conc(\d+)")[0]
rows = []
for (ph, rtt, conc), g in cr.groupby([cr.phase, cr.rtt.fillna("-"), cr.conc.fillna("1")], sort=False):
    rows.append([("intra-cluster" if ph == "intra" else "cross-cluster"), rtt, conc, round(g.tps.mean(), 1), round(g.mean_ms.mean(), 1), round(g.p50_ms.mean(), 1), round(g.p95_ms.mean(), 1), round(g.p99_ms.mean(), 1), round(g.fetch_ms.mean(), 1), round(g.verify_ms.mean(), 2), round(g.receipt_ms.mean(), 1), int(g.n.sum() - g.ok.sum()), len(g)])
T["T8_cross_cluster"] = pd.DataFrame(rows, columns=["Path", "Emulated RTT (ms)", "Clients", "Reads/s", "Mean (ms)", "P50 (ms)", "P95 (ms)", "P99 (ms)", "Remote fetch (ms)", "Hash+AES-GCM verify (ms)", "Local receipt commit (ms)", "Failed", "Repetitions"])
# Table 9: functional cases
T["T9_bridge_functional"] = pd.DataFrame([[c["case"], c["n"], c["allowed"], c["denied"], "; ".join(f"{k}: {v}" for k, v in c["reasons"].items())[:80]] for c in json.load(open(f"{D}/xc/functional.json"))], columns=["Case", "Requests", "Allowed", "Denied", "Denial reason"])
# Table 10: scale-out
sc = s[s.phase.isin(["scale1", "scale2"])].copy(); sc["rate"] = sc.param.str.extract(r"rate(\d+)")[0].astype(int)
rows = [[("1 cluster" if ph == "scale1" else "2 clusters (aggregate)"), r, round(g.tps.mean(), 1), round(g.tps.std(), 2), round(g.mean_ms.mean(), 0), round(g.p95_ms.mean(), 0), round(g.host_cpu_pct.mean(), 0), int(g.n.sum() - g.ok.sum())] for (ph, r), g in sc.groupby(["phase", "rate"])]
T["T10_scale_out"] = pd.DataFrame(rows, columns=["Deployment", "Offered write rate per cluster (TPS)", "Achieved TPS (aggregate)", "SD", "Mean latency (ms)", "P95 (ms)", "Host CPU (%)", "Failed tx"])
# Table 11: FHIR
cf = json.load(open(f"{D}/fhir/conformance.json")); v = cf.pop("_validator")
rows = [[k, x["attempted"], x["created"], x["read_ok"], x["byte_identical_roundtrip"]] for k, x in cf.items()]
T["T11_fhir_roundtrip"] = pd.DataFrame(rows, columns=["Resource type", "Attempted", "Created (201)", "Read back (200)", "Byte-identical round trip"])
T["T12_fhir_validator"] = pd.DataFrame([[v["fhir_version"], v["resources_validated"], v["resources_with_errors"], v["errors"], v["warnings"], v["terminology"]]], columns=["FHIR version", "Resources validated", "Resources with errors", "Errors", "Warnings", "Terminology"])
T["T13_fhir_negative"] = pd.DataFrame(json.load(open(f"{D}/fhir/negative.json")))[["case", "expected", "got", "pass"]].rename(columns={"case": "Case", "expected": "Expected HTTP", "got": "Observed HTTP", "pass": "Pass"})
fl = pd.read_csv(f"{D}/fhir/summary.csv")
T["T14_fhir_load"] = fl.groupby(["phase", "rate"]).agg(n=("n", "mean"), ok=("ok", "mean"), tps=("tps", "mean"), mean_ms=("mean_ms", "mean"), p50_ms=("p50_ms", "mean"), p95_ms=("p95_ms", "mean"), p99_ms=("p99_ms", "mean"), host_cpu=("host_cpu_pct", "mean")).round(1).reset_index()
with pd.ExcelWriter(f"{OUT}/all_tables.xlsx", engine="openpyxl") as w:
    for k, df in T.items():
        df.to_excel(w, sheet_name=k[:31], index=False); df.to_csv(f"{OUT}/csv/{k}.csv", index=False)
        ws = w.sheets[k[:31]]
        for i, c in enumerate(df.columns, 1):
            ws.column_dimensions[ws.cell(1, i).column_letter].width = min(48, max(len(str(c)), *(len(str(x)) for x in df[c])) + 2)
            ws.cell(1, i).font = ws.cell(1, i).font.copy(bold=True)
        ws.freeze_panes = "A2"
print("tables:", len(T))

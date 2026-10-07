#!/usr/bin/env python3
"""Build paper figures from the measured CSVs. No smoothing, no selection: every plotted point is a measured mean, error bars are SD over repetitions.
Usage: make_figures.py <final_dir_with_config_subdirs> [xc_dir] [out_dir]
  final_dir/<config>/results/<config>/{summary.csv,resources.csv}   (as produced by analyze.py)  or  final_dir/<config>/{summary.csv,...}
  xc_dir/summary.csv  (from xc/bench.js)"""
import sys, glob, os
import pandas as pd, numpy as np
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt

# categorical slots 1-4 of the validated reference palette (light), fixed order
C = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100"]
INK, MUTED, GRID = "#0b0b0b", "#52514e", "#e4e3df"
plt.rcParams.update({"font.size": 9, "axes.edgecolor": MUTED, "axes.labelcolor": INK, "xtick.color": MUTED, "ytick.color": MUTED,
    "axes.spines.top": False, "axes.spines.right": False, "axes.grid": True, "grid.color": GRID, "grid.linewidth": .6,
    "axes.axisbelow": True, "legend.frameon": False, "lines.linewidth": 2, "lines.markersize": 5, "figure.dpi": 150, "figure.constrained_layout.use": True, "savefig.bbox": "tight"})

final = sys.argv[1]; xc = sys.argv[2] if len(sys.argv) > 2 else None; out = sys.argv[3] if len(sys.argv) > 3 else "figures"
os.makedirs(out, exist_ok=True)

def load(name, fname="summary.csv"):
    for p in (f"{final}/{name}/results/{name}/{fname}", f"{final}/{name}/{fname}", f"{final}/{name}/results/{fname}"):
        if os.path.exists(p): return pd.read_csv(p)
    return None
def save(fig, n):
    for ext in ("png", "pdf"): fig.savefig(f"{out}/{n}.{ext}")
    plt.close(fig); print("wrote", n)

LAB = {"ldb_maj_100ms_b100": "LevelDB, both orgs endorse", "ldb_any_100ms_b100": "LevelDB, 1-of-2 endorse", "couch_maj_100ms_b100": "CouchDB, both orgs endorse"}
def series(ax, df, op, col, sd, color, label, marker="o"):
    d = df[df.op == op].sort_values("clients")
    ax.errorbar(d.clients, d[col], yerr=d[sd], color=color, marker=marker, capsize=2, label=label)

# F1/F2: write throughput and latency vs offered load, three configurations (block = 100 messages, BatchTimeout 100 ms)
fig1, a1 = plt.subplots(figsize=(3.4, 2.6)); fig2, a2 = plt.subplots(figsize=(3.4, 2.6)); have = False
for i, (n, lab) in enumerate(LAB.items()):
    df = load(n)
    if df is None: continue
    have = True; series(a1, df, "write", "tps_mean", "tps_sd", C[i], lab); series(a2, df, "write", "lat_p95_mean", "lat_p95_sd", C[i], lab)
if have:
    lim = max(a1.get_xlim()); a1.plot([0, lim], [0, lim], color=MUTED, lw=1, ls=":", label="ideal (achieved = offered)")
    a1.set(xlabel="Offered load (TPS)", ylabel="Achieved write TPS"); a1.legend(fontsize=7, loc="lower right"); save(fig1, "fig_write_throughput")
    a2.set(xlabel="Offered load (TPS)", ylabel="Write latency P95 (ms)"); a2.legend(fontsize=7); save(fig2, "fig_write_latency_p95")

# F3: block-size factor (MaxMessageCount) on write TPS and P95, LevelDB + both orgs
fig, ax = plt.subplots(1, 2, figsize=(6.8, 2.6)); have = False
for i, b in enumerate([10, 50, 100, 250]):
    df = load(f"ldb_maj_100ms_b{b}")
    if df is None: continue
    have = True; series(ax[0], df, "write", "tps_mean", "tps_sd", C[i], f"{b} msgs/block"); series(ax[1], df, "write", "lat_p95_mean", "lat_p95_sd", C[i], f"{b} msgs/block")
if have:
    ax[0].set(xlabel="Offered load (TPS)", ylabel="Achieved write TPS"); ax[1].set(xlabel="Offered load (TPS)", ylabel="Write latency P95 (ms)"); ax[0].legend(fontsize=7); save(fig, "fig_block_size")

# F4: reads (evaluate path) throughput and latency, LevelDB vs CouchDB
fig, ax = plt.subplots(1, 2, figsize=(6.8, 2.6)); have = False
for i, n in enumerate(["ldb_maj_100ms_b100", "couch_maj_100ms_b100"]):
    df = load(n)
    if df is None: continue
    have = True; series(ax[0], df, "read", "tps_mean", "tps_sd", C[i], LAB[n]); series(ax[1], df, "read", "lat_p95_mean", "lat_p95_sd", C[i], LAB[n])
if have:
    ax[0].set(xlabel="Offered load (TPS)", ylabel="Achieved read TPS"); ax[1].set(xlabel="Offered load (TPS)", ylabel="Read latency P95 (ms)"); ax[0].legend(fontsize=7); save(fig, "fig_read")

# F5: whole-VM CPU during write rounds (shows where the single-host testbed saturates)
fig, ax = plt.subplots(figsize=(3.4, 2.6)); have = False
for i, n in enumerate(LAB):
    r = load(n, "resources.csv")
    if r is None: continue
    d = r[(r.op == "write") & (r.container == "HOST")].sort_values("clients"); have = True
    ax.plot(d.clients, d.cpu_pct_mean, color=C[i], marker="o", label=LAB[n])
if have: ax.set(xlabel="Offered load (TPS)", ylabel="Host CPU, mean (%)", ylim=(0, 100)); ax.legend(fontsize=7); save(fig, "fig_host_cpu")

# ---- cross-cluster figures ----
if xc and os.path.exists(f"{xc}/summary.csv"):
    s = pd.read_csv(f"{xc}/summary.csv")
    cr = s[s.phase == "cross"].copy(); cr["rtt"] = cr.param.str.extract(r"rtt(\d+)").astype(int); cr["conc"] = cr.param.str.extract(r"conc(\d+)").astype(int)
    intra = s[s.phase == "intra"]
    if len(cr):
        fig, ax = plt.subplots(1, 2, figsize=(6.8, 2.8))
        g = cr[cr.conc == 1].groupby("rtt")
        # stacked mean latency per stage (fetch, verify, receipt); segments separated by white gap
        stages = [("auth_ms", "token check"), ("fetch_ms", "remote anchor read"), ("verify_ms", "hash + AES-GCM verify"), ("receipt_ms", "local receipt commit")]
        m = g[[k for k, _ in stages]].mean(); x = np.arange(len(m)); bot = np.zeros(len(m))
        for i, (k, lab) in enumerate(stages):
            ax[0].bar(x, m[k], bottom=bot, color=C[i], edgecolor="white", linewidth=1.5, width=.6, label=lab); bot += m[k].values
        if len(intra): ax[0].axhline(intra.mean_ms.mean(), color=MUTED, ls=":", lw=1.2); ax[0].text(len(m) - .5, intra.mean_ms.mean(), "intra-cluster", ha="right", va="bottom", fontsize=7, color=MUTED)
        ax[0].set_xticks(x); ax[0].set_xticklabels([str(i) for i in m.index]); ax[0].set(xlabel="Emulated WAN RTT (ms)", ylabel="Mean latency per cross-cluster read (ms)"); ax[0].legend(fontsize=6.5)
        for i, c in enumerate([1, 8]):
            d = cr[cr.conc == c].groupby("rtt")
            mu, sd = d.mean_ms.mean(), d.mean_ms.std(); p95 = d.p95_ms.mean()
            ax[1].errorbar(mu.index, mu.values, yerr=sd.fillna(0).values, color=C[i], marker="o", capsize=2, label=f"mean, {c} client{'s' if c > 1 else ''}")
            ax[1].plot(p95.index, p95.values, color=C[i], marker="s", ls="--", lw=1.2, label=f"P95, {c} client{'s' if c > 1 else ''}")
        ax[1].set(xlabel="Emulated WAN RTT (ms)", ylabel="End-to-end latency (ms)"); ax[1].legend(fontsize=6.5); save(fig, "fig_cross_cluster_latency")
    sc = s[s.phase.isin(["scale1", "scale2"])].copy()
    if len(sc):
        sc["rate"] = sc.param.str.extract(r"rate(\d+)").astype(int)
        fig, ax = plt.subplots(1, 2, figsize=(6.8, 2.6))
        for i, (ph, lab) in enumerate([("scale1", "1 cluster"), ("scale2", "2 clusters (aggregate)")]):
            d = sc[sc.phase == ph].groupby("rate"); mu, sd = d.tps.mean(), d.tps.std().fillna(0)
            ax[0].errorbar(mu.index, mu.values, yerr=sd.values, color=C[i], marker="o", capsize=2, label=lab)
            q = d.p95_ms.mean(); ax[1].plot(q.index, q.values, color=C[i], marker="o", label=lab)
        ax[0].set(xlabel="Offered write rate per cluster (TPS)", ylabel="Achieved write TPS"); ax[1].set(xlabel="Offered write rate per cluster (TPS)", ylabel="Write latency P95 (ms)")
        ax[0].legend(fontsize=7); save(fig, "fig_scale_out")

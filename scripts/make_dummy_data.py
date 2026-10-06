#!/usr/bin/env python3
"""SYNTHETIC data to test analyze.py only. NEVER use for the paper."""
import json, os, random, sys
out = sys.argv[1]
random.seed(1)
for b in (10, 50):
    for c in (10, 50):
        for rep in (1, 2, 3):
            d = os.path.join(out, f"b{b}", f"c{c}", f"rep{rep}"); os.makedirs(d, exist_ok=True)
            for op, base in (("write", 300), ("read", 120)):
                for w in (0, 1):
                    t = 1_000_000; rows = []
                    for _ in range(2000):
                        lat = max(5, random.gauss(base, 40)); ok = random.random() > 0.03
                        rows.append(dict(s=int(t), e=int(t + lat), ok=int(ok),
                                         err="" if ok else random.choice(["MVCC_READ_CONFLICT", "timeout", "weird"])))
                        t += random.uniform(1, 8)
                    open(os.path.join(d, f"{op}_w{w}.jsonl"), "w").write("\n".join(map(json.dumps, rows)) + "\n")
            open(os.path.join(d, "docker_stats.csv"), "w").write("peer0.org1.example.com,45.2%,812MiB / 3.8GiB,1MB / 2MB,0B / 1MB\ncouchdb0,12.0%,1.1GiB / 3.8GiB,1MB / 2MB,0B / 1MB\n")

#!/usr/bin/env python3
"""Wall time for a PR head SHA's required checks to all go green (pull_request event):
max(updated_at) - min(created_at) over the required workflows, for SHAs where all of them succeeded.
Also the same for merge_group SHAs (one queue build)."""
import json, statistics as st
from datetime import datetime
from collections import defaultdict
def t(s): return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ")
R = json.load(open("runs_all.json"))
REQ = {"typecheck", "changelog-fragment-check", "test", "browser-test", "lint", "credential-free-build"}
def pct(xs, q):
    xs = sorted(xs); k = (len(xs) - 1) * q; f = int(k); c = min(f + 1, len(xs) - 1)
    return xs[f] + (xs[c] - xs[f]) * (k - f)
for ev in ("pull_request", "merge_group"):
    for lo in ("2026-08-20", "2026-09-12"):
        g = defaultdict(list)
        for r in R:
            if r["event"] == ev and r["name"] in REQ and r["created_at"] >= lo and r["run_attempt"] == 1:
                g[r["head_sha"]].append(r)
        walls, slow = [], defaultdict(int)
        for sha, rs in g.items():
            if not {"test", "typecheck", "browser-test"} <= {r["name"] for r in rs}: continue
            if any(r["conclusion"] != "success" for r in rs): continue
            walls.append((max(t(r["updated_at"]) for r in rs) - min(t(r["created_at"]) for r in rs)).total_seconds() / 60)
            slow[max(rs, key=lambda r: t(r["updated_at"]))["name"]] += 1
        print(f"{ev} since {lo}: all-green SHAs {len(walls)}; wall to all-required-green median {pct(walls,.5):.1f}m p75 {pct(walls,.75):.1f}m p90 {pct(walls,.9):.1f}m; last-to-finish: {dict(slow)}")

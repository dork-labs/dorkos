#!/usr/bin/env python3
"""Exact (second-precision) job concurrency for the 2026-09-15 census, plus job queue-wait by
ISO week across every job we hold (S1+S2+S3), and the date sharding first appears."""
import json, glob, statistics as st
from datetime import datetime, timezone
from collections import defaultdict
def t(s): return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
R = {r["id"]: r for r in json.load(open("runs_all.json"))}
S = json.load(open("sample_ids.json"))
J = {}
for f in glob.glob("jobs/*.json"):
    d = json.load(open(f)); J[d["run_id"]] = d["jobs"]
def real(j): return j["conclusion"] not in ("skipped", None) and j["started_at"] and j["completed_at"]
ev = []
for rid in S["S3"]:
    for j in J.get(rid, []):
        if real(j):
            lab = ",".join(j.get("labels") or [])
            ev.append((t(j["started_at"]), 1, lab)); ev.append((t(j["completed_at"]), -1, lab))
ev.sort(key=lambda x: (x[0], x[1]))
cur = peak = 0; lin = linpeak = 0; above = 0.0; last = None
for ts, d, lab in ev:
    if last is not None and cur >= 20: above += (ts - last).total_seconds()
    cur += d; last = ts
    if "ubuntu" in lab: lin += d
    peak = max(peak, cur); linpeak = max(linpeak, lin)
print(f"2026-09-15 exact peak concurrent jobs: {peak} (ubuntu only {linpeak}); time with >=20 running: {above/60:.0f} min")
wk = defaultdict(list); wk_mg = defaultdict(list)
for rid, jobs in J.items():
    r = R.get(rid)
    if not r: continue
    for j in jobs:
        if real(j) and j["run_attempt"] == 1:
            w = t(j["created_at"]).strftime("%G-W%V")
            q = (t(j["started_at"]) - t(j["created_at"])).total_seconds() / 60
            wk[w].append(q)
def pct(xs, q):
    xs = sorted(xs); k = (len(xs) - 1) * q; f = int(k); c = min(f + 1, len(xs) - 1)
    return xs[f] + (xs[c] - xs[f]) * (k - f)
print("| ISO week | jobs sampled | queue-wait median | p90 | p99 | max | share >2m | share >10m |\n|---|---|---|---|---|---|---|---|")
for w in sorted(wk):
    xs = wk[w]
    print(f"| {w} | {len(xs)} | {pct(xs,.5)*60:.0f}s | {pct(xs,.9)*60:.0f}s | {pct(xs,.99):.1f}m | {max(xs):.1f}m | {100*sum(1 for x in xs if x>2)/len(xs):.1f}% | {100*sum(1 for x in xs if x>10)/len(xs):.1f}% |")
# first appearance of sharded jobs
first = {}
for rid, jobs in J.items():
    r = R.get(rid)
    if not r: continue
    for j in jobs:
        for key in ("test-shard", "browser-shard"):
            if j["name"].startswith(key) and real(j):
                if key not in first or j["created_at"] < first[key][0]: first[key] = (j["created_at"], r["event"])
print("first sharded jobs seen:", first)
# per-day long waits
dd = defaultdict(list)
for rid, jobs in J.items():
    for j in jobs:
        if real(j) and j["run_attempt"] == 1:
            q = (t(j["started_at"]) - t(j["created_at"])).total_seconds() / 60
            if q > 5: dd[j["created_at"][:10]].append(round(q, 1))
print("days with >5m job waits (sampled):", {k: (len(v), max(v)) for k, v in sorted(dd.items())})

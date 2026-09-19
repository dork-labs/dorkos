#!/usr/bin/env python3
"""Choose run ids whose job-level timings we fetch. Writes sample_ids.json {set: [ids]}.
S1 stratified: 20 random (30d) + 10 random (7d) completed success/failure runs per heavy workflow/event (seed 42).
S2 every merge_group failure of test / browser-test (30d).
S3 every non-skipped run created on 2026-09-15 UTC (full-day census for concurrency)."""
import json, random
R = json.load(open("runs_all.json"))
random.seed(42)
S1 = []
for wf in ["test", "browser-test", "typecheck", "lint", "claude-code-review"]:
    for ev in ["pull_request", "merge_group"]:
        pool = [r for r in R if r["name"] == wf and r["event"] == ev and r["conclusion"] in ("success", "failure")]
        if not pool: continue
        old = [r for r in pool if r["created_at"] < "2026-09-12"]
        new = [r for r in pool if r["created_at"] >= "2026-09-12"]
        S1 += [r["id"] for r in random.sample(old, min(20, len(old)))]
        S1 += [r["id"] for r in random.sample(new, min(10, len(new)))]
S2 = [r["id"] for r in R if r["event"] == "merge_group" and r["name"] in ("test", "browser-test") and r["conclusion"] == "failure"]
S3 = [r["id"] for r in R if r["created_at"].startswith("2026-09-15") and r["conclusion"] != "skipped"]
json.dump({"S1": S1, "S2": S2, "S3": S3}, open("sample_ids.json", "w"))
print(len(S1), len(S2), len(S3), len(set(S1) | set(S2) | set(S3)))

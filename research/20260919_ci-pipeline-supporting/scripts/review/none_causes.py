#!/usr/bin/env python3
"""Why merged PRs got no verdict at all."""
import json, os, collections
from datetime import datetime, timedelta
HERE = os.path.dirname(os.path.abspath(__file__))
ts = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00"))
d = json.load(open(os.path.join(HERE, "review_dataset.json")))
END = max(ts(p["merged"]) for p in d)
out = {}
for W, days in (("30d", 31), ("7d", 7)):
    c = collections.Counter(); ex = collections.defaultdict(list)
    for p in d:
        if ts(p["merged"]) < END - timedelta(days=days) or p["verdicts"]: continue
        concl = [r["concl"] for r in p["runs"]]
        if p["skip_ever"]: k = "skip-review label"
        elif p["failnotes"]: k = "review failed (red check + notice)"
        elif "success" in concl: k = "run green but no verdict posted (pre-DOR-1665 silent green)"
        elif "cancelled" in concl: k = "opened-run cancelled by a same-second labeled run (label race)"
        elif "failure" in concl: k = "review failed, no notice"
        elif not concl: k = "no review run at all (opened while conflicting / event dropped)"
        else: k = "only skipped runs"
        c[k] += 1; ex[k].append(p["n"])
    out[W] = {"counts": dict(c), "examples": {k: v[:12] for k, v in ex.items()}}
    print(W, dict(c)); [print("  ", k, v[:14]) for k, v in ex.items()]
json.dump(out, open(os.path.join(HERE, "none_causes.json"), "w"), indent=1)

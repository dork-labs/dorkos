#!/usr/bin/env python3
"""Per important verdict: combine flagged-file blob change + own commits after -> action class."""
import json, os, collections
from datetime import datetime, timedelta
HERE = os.path.dirname(os.path.abspath(__file__))
ts = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00"))
fb = json.load(open(os.path.join(HERE, "flagged_blobs.json")))
rows = json.load(open(os.path.join(HERE, "imp_timing.json")))
d = {p["n"]: p for p in json.load(open(os.path.join(HERE, "review_dataset.json")))}
END = max(ts(p["merged"]) for p in d.values())
res = {}
for W, days in (("30d", 31), ("7d", 7)):
    c = collections.Counter(); per = []
    for r in rows:
        if ts(d[r["n"]]["merged"]) < END - timedelta(days=days): continue
        f = [o for o in fb.values() if o["n"] == r["n"] and o["verdict_t"] == r["t"]]
        fchg = any(o["changed"] or (o["resolved"] and o["author_reply"]) for o in f); has_inline = bool(f)
        own = r["change"] == "new PR commits after finding"
        if fchg: k = "acted: flagged file changed (or thread resolved with author fix reply)"
        elif own: k = "new commits, flagged file untouched" if has_inline else "new commits (finding had no inline anchor)"
        elif r["change"] == "no change at all": k = "merged with zero change after finding"
        else: k = "only rebase/merge-main after; flagged file untouched" if has_inline else "only rebase/merge-main after (no inline anchor)"
        c[k] += 1; per.append({"n": r["n"], "t": r["t"], "class": k, "state": r["state"], "min_to_merge": r["min_to_merge"], "rereviewed": r["rereviewed"]})
    res[W] = {"counts": dict(c), "n": sum(c.values()), "rows": per}
    print(W, sum(c.values()), dict(c))
    cs = collections.Counter((x["class"].startswith("acted"), x["state"]) for x in per); print("  (acted, merge state at verdict):", dict(cs))
json.dump(res, open(os.path.join(HERE, "action_final.json"), "w"), indent=1)

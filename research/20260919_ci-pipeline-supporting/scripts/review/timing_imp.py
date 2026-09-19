#!/usr/bin/env python3
"""For each important-finding verdict: was auto-merge armed / PR in queue when it landed,
and how long until merge. Also thread resolution + author replies."""
import json, os, statistics, collections
from datetime import datetime
HERE = os.path.dirname(os.path.abspath(__file__)); PARENT = os.path.dirname(HERE)
tl = json.load(open(os.path.join(PARENT, "pr_timelines.json")))
d = {p["n"]: p for p in json.load(open(os.path.join(HERE, "review_dataset.json")))}
rows = json.load(open(os.path.join(HERE, "analysis.json")))["30d"]["imp_rows"]
ts = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00"))
agg = collections.Counter(); mins = collections.defaultdict(list); out = []
for r in rows:
    t = ts(r["t"]); p = d[r["n"]]; items = tl[str(r["n"])]["timelineItems"]["nodes"]
    armed = [ts(i["createdAt"]) for i in items if i["__typename"] == "AutoMergeEnabledEvent"]
    disarmed = [ts(i["createdAt"]) for i in items if i["__typename"] == "AutoMergeDisabledEvent"]
    q_in = [ts(i["createdAt"]) for i in items if i["__typename"] == "AddedToMergeQueueEvent"]
    q_out = [ts(i["createdAt"]) for i in items if i["__typename"] == "RemovedFromMergeQueueEvent"]
    armed_at = any(a <= t for a in armed) and not any(a < x <= t for a in armed for x in disarmed if a <= t)
    inq = any(a <= t for a in q_in) and sum(1 for a in q_in if a <= t) > sum(1 for x in q_out if x <= t)
    m = (ts(p["merged"]) - t).total_seconds() / 60
    st = "in queue at verdict" if inq else "armed at verdict" if armed_at else "not armed at verdict"
    agg[(st, r["change"])] += 1; mins[r["change"]].append(m)
    near = [th for th in p["threads"] if abs((ts(th["t"]) - t).total_seconds()) < 1800]
    out.append({**r, "state": st, "min_to_merge": round(m), "threads": len(near), "resolved": sum(th["resolved"] for th in near),
                "author_replied": sum(1 for th in near for x in th["replies"] if x["a"] != "claude")})
for k, v in sorted(agg.items()): print(k, v)
for k, v in mins.items(): print(k, "median min verdict->merge", round(statistics.median(v)), "n", len(v))
json.dump(out, open(os.path.join(HERE, "imp_timing.json"), "w"), indent=1)
c = collections.Counter((o["change"] != "new PR commits after finding", o["resolved"] > 0, o["author_replied"] > 0) for o in out)
print("(no-own-change, any-resolved, author-replied):", dict(c))
print("threads total", sum(o["threads"] for o in out), "resolved", sum(o["resolved"] for o in out))

#!/usr/bin/env python3
"""Q6: review run durations, conclusion mix, failure causes (from run_log_facts.json + a few
full logs read by hand), turns/cost on a random sample of 60 successful runs."""
import json, os, collections, statistics
from datetime import datetime, timedelta
HERE = os.path.dirname(os.path.abspath(__file__)); PARENT = os.path.dirname(HERE)
ts = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00"))
runs = [r for r in json.load(open(os.path.join(PARENT, "runs_all.json"))) if r["name"] == "claude-code-review"]
facts = json.load(open(os.path.join(HERE, "run_log_facts.json")))
# causes established by reading full logs of the 12 runs with no result message
NORESULT = {"32811424192": "dependabot actor refused", "33365151117": "dependabot actor refused", "33954833460": "dependabot actor refused",
            "34815421146": "dependabot actor refused", "34852304867": "dependabot actor refused",
            "34286757769": "action: native claude binary not found", "34288344922": "action: native claude binary not found",
            "34288476544": "action: native claude binary not found", "34291148698": "action: native claude binary not found",
            "34175784994": "PR edits the workflow (validation skip)", "34353041139": "PR edits the workflow (validation skip)", "35411685741": "PR edits the workflow (validation skip)"}
END = max(ts(r["created_at"]) for r in runs)
def pc(xs, q): xs = sorted(xs); return xs[min(len(xs) - 1, int(q * len(xs)))]
for W, days in (("30d", 31), ("7d", 7)):
    rs = [r for r in runs if ts(r["created_at"]) >= END - timedelta(days=days)]
    c = collections.Counter(r["conclusion"] for r in rs)
    dur = lambda r: (ts(r["updated_at"]) - ts(r["run_started_at"])).total_seconds() / 60
    succ = [dur(r) for r in rs if r["conclusion"] == "success"]
    canc = [dur(r) for r in rs if r["conclusion"] == "cancelled"]
    print(W, dict(c), "success dur min median/p90/max", round(statistics.median(succ), 1), round(pc(succ, .9), 1), round(max(succ), 1),
          "| cancelled <1min:", sum(1 for x in canc if x < 1), ">=1min:", sum(1 for x in canc if x >= 1))
    causes = collections.Counter()
    for r in rs:
        if r["conclusion"] != "failure": continue
        f = facts.get(str(r["id"]))
        if not f: causes["(log not sampled)"] += 1; continue
        if str(r["id"]) in NORESULT: causes[NORESULT[str(r["id"])]] += 1
        elif f["subtype"] == "error_max_turns": causes["ran out of turns (error_max_turns)"] += 1
        elif f["subtype"] == "success" and f["overshoot"]: causes["finished, then action threw on turn overshoot (verdict posted)"] += 1
        elif f["subtype"] == "success": causes["finished cleanly, other machinery failure / no verdict"] += 1
        else: causes["other"] += 1
    print("  failure causes:", dict(causes))
s = [v for v in facts.values() if v["concl"] == "success" and v["num_turns"]]
t = [int(v["num_turns"]) for v in s]; cost = [float(v["cost"]) for v in s if v["cost"]]
print("success sample n", len(s), "turns median", statistics.median(t), "p90", pc(t, .9), "max", max(t), ">=45:", sum(1 for x in t if x >= 45))
print("cost (API-equivalent USD) median", round(statistics.median(cost), 2), "mean", round(statistics.mean(cost), 2), "p90", round(pc(cost, .9), 2))
mt = [v for v in facts.values() if v["subtype"] == "error_max_turns"]
print("max_turns failures: files changed median", statistics.median(int(v["files"]) for v in mt if v["files"]), "cost mean", round(statistics.mean(float(v["cost"]) for v in mt), 2))

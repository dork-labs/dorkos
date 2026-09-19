#!/usr/bin/env python3
"""Coverage, verdict distribution and action-rate tables from review_dataset.json."""
import json, os, re, collections, statistics
from datetime import datetime, timedelta
HERE = os.path.dirname(os.path.abspath(__file__))
d = json.load(open(os.path.join(HERE, "review_dataset.json")))
def ts(s): return datetime.fromisoformat(s.replace("Z", "+00:00"))
END = max(ts(p["merged"]) for p in d)
def size(p):
    l = p["add"] + p["del"]
    return "XS <10" if l < 10 else "S 10-49" if l < 50 else "M 50-249" if l < 250 else "L 250-999" if l < 1000 else "XL 1000+"
def reviewed_sha(v): return v["run_sha"] or v["head_at"]
def after(p, t):
    t = ts(t)
    nc = [c for c in p["commits"] if ts(c[1]) > t]
    fp = [f for f in p["force_pushes"] if ts(f[0]) > t]
    return nc, fp
CMP = json.load(open(os.path.join(HERE, "compare.json"))); REV = json.load(open(os.path.join(HERE, "compare_rev.json")))
MAINSQ = re.compile(r"\(#\d+\)$|^Merge (branch|remote)|^merge (origin/)?main", re.I)
def own_after(p, v):
    """PR-authored commits in final that the reviewed SHA did not contain (rebased copies and main merges excluded)."""
    s = reviewed_sha(v)
    if not s or s == p["final_sha"]: return []
    c = CMP.get(f"{s}...{p['final_sha']}")
    if not c or "commits" not in c: return None
    old = set(REV.get(f"{s}...{p['final_sha']}") or [])
    return [m for m in c["commits"] if not MAINSQ.search(m["msg"].strip()) and m["msg"] not in old]
def pct(a, b): return f"{a}/{b} ({100*a/b:.0f}%)" if b else "0/0"
res = {}
for W, days in (("30d", 31), ("7d", 7)):
    ps = [p for p in d if ts(p["merged"]) >= END - timedelta(days=days)]
    N = len(ps); R = {}
    cov = collections.Counter(); nonecause = collections.Counter()
    for p in ps:
        vs = p["verdicts"]
        if not vs:
            if p["skip_ever"]: c = "none: skip-review"
            elif p["failnotes"]: c = "none: review failed (red notice)"
            elif any(r["concl"] in ("success", "failure", "cancelled") for r in p["runs"]): c = "none: ran, no verdict"
            else: c = "none: no run"
            cov["none"] += 1; nonecause[c] += 1; p["_cov"] = "none"; continue
        shas = {reviewed_sha(v) for v in vs}
        if p["final_sha"] in shas: p["_cov"] = "final"
        else:
            own = own_after(p, vs[-1])
            p["_cov"] = "earlier: rebase/merge-main only" if own == [] else "earlier: unknown" if own is None else "earlier: new PR commits after review"
        cov[p["_cov"]] += 1
    R["N"] = N; R["cov"] = dict(cov); R["nonecause"] = dict(nonecause)
    R["skip_label_share"] = sum(1 for p in ps if p["skip_ever"])
    R["light"] = sum(1 for p in ps if "review:light" in p["labels"]); R["deep"] = sum(1 for p in ps if "review:deep" in p["labels"])
    # verdicts: first full review per PR (first verdict) and all verdicts
    firsts = [(p, p["verdicts"][0]) for p in ps if p["verdicts"]]
    allv = [(p, v) for p in ps for v in p["verdicts"]]
    R["n_first"] = len(firsts); R["n_all"] = len(allv)
    R["first_imp_ge1"] = sum(1 for p, v in firsts if v["imp"] >= 1)
    R["first_imp_dist"] = dict(sorted(collections.Counter(min(v["imp"], 5) for p, v in firsts).items()))
    R["first_nit_ge1"] = sum(1 for p, v in firsts if v["nits"] >= 1)
    R["all_imp_ge1"] = sum(1 for p, v in allv if v["imp"] >= 1)
    R["total_imp_first"] = sum(v["imp"] for p, v in firsts)
    R["pr_any_imp"] = sum(1 for p in ps if any(v["imp"] >= 1 for v in p["verdicts"]))
    bysz = collections.defaultdict(lambda: [0, 0, 0])
    for p, v in firsts:
        b = bysz[size(p)]; b[0] += 1; b[1] += v["imp"] >= 1; b[2] += v["imp"]
    R["by_size"] = {k: bysz[k] for k in ["XS <10", "S 10-49", "M 50-249", "L 250-999", "XL 1000+"] if k in bysz}
    bylab = collections.defaultdict(lambda: [0, 0])
    for p, v in firsts:
        k = "review:light" if "review:light" in p["labels"] else "review:deep" if "review:deep" in p["labels"] else "standard"
        bylab[k][0] += 1; bylab[k][1] += v["imp"] >= 1
    R["by_label"] = dict(bylab)
    byfiles = collections.defaultdict(lambda: [0, 0])
    for p, v in firsts:
        k = "files<=30 (50 turns)" if p["files"] <= 30 else "files>30 (100 turns)"
        byfiles[k][0] += 1; byfiles[k][1] += v["imp"] >= 1
    R["by_files"] = dict(byfiles)
    # action rate: every verdict with imp>=1
    act = collections.Counter(); rr = collections.Counter(); rows = []
    for p, v in allv:
        if v["imp"] < 1: continue
        own = own_after(p, v)
        k = "unknown" if own is None else "new PR commits after finding" if own else ("rebase/merge-main only" if reviewed_sha(v) != p["final_sha"] else "no change at all")
        act[k] += 1
        later = [x for x in p["verdicts"] if ts(x["t"]) > ts(v["t"])]
        rrl = [t for t in p["rereview_labeled"] if ts(t) > ts(v["t"])]
        if rrl or later:
            rr["re-review after"] += 1
            if later:
                rr["later verdict clean" if later[-1]["imp"] == 0 else "later verdict still important"] += 1
            else: rr["re-review label but no later verdict"] += 1
        else: rr["no re-review"] += 1
        rows.append({"n": p["n"], "imp": v["imp"], "t": v["t"], "change": k, "own": [m["msg"] for m in (own or [])], "size": size(p), "labels": p["labels"], "rereviewed": bool(rrl or later)})
    R["action"] = dict(act); R["rr"] = dict(rr); R["imp_rows"] = rows
    # re-review label stats
    R["prs_rr_label"] = sum(1 for p in ps if p["rereview_labeled"]); R["rr_labels"] = sum(len(p["rereview_labeled"]) for p in ps)
    res[W] = R
json.dump(res, open(os.path.join(HERE, "analysis.json"), "w"), indent=1, default=str)
for W, R in res.items():
    print("=====", W)
    for k, v in R.items():
        if k != "imp_rows": print(k, v)

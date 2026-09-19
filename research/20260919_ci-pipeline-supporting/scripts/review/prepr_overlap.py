#!/usr/bin/env python3
"""Q7: does the CI review still find Important issues on PRs whose body says a pre-PR
(adversarial/independent) review already ran?"""
import json, os, re, collections
from datetime import datetime, timedelta
HERE = os.path.dirname(os.path.abspath(__file__)); PARENT = os.path.dirname(HERE)
bodies = {p["number"]: p["body"] or "" for p in json.load(open(os.path.join(PARENT, "prs_bodies.json")))}
d = json.load(open(os.path.join(HERE, "review_dataset.json")))
ts = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00"))
END = max(ts(p["merged"]) for p in d)
RX = re.compile(r"adversarial(ly)?\s+(re-?)?review|independent (re-?)?review|fresh(-eyes)? reviewer|review rounds?|reviewer (agent|subagent)|\bround [1-9]\b.*review|code-reviewer|pre-PR review|reviewed adversarially|SAFE TO PR", re.I)
def size(p):
    l = p["add"] + p["del"]
    return "S/M <250" if l < 250 else "L 250-999" if l < 1000 else "XL 1000+"
out = {}
for W, days in (("30d", 31), ("7d", 7)):
    rows = collections.defaultdict(lambda: [0, 0, 0])
    for p in d:
        if ts(p["merged"]) < END - timedelta(days=days) or not p["verdicts"]: continue
        pre = bool(RX.search(bodies.get(p["n"], "")))
        v = p["verdicts"][0]
        for k in (("pre-PR review mentioned" if pre else "not mentioned"), (("pre" if pre else "none") + " / " + size(p))):
            rows[k][0] += 1; rows[k][1] += v["imp"] >= 1; rows[k][2] += v["imp"]
    out[W] = dict(rows)
    print(W)
    for k in sorted(rows): print(f"  {k}: n={rows[k][0]} imp>=1={rows[k][1]} ({100*rows[k][1]/rows[k][0]:.0f}%) total_imp={rows[k][2]}")
json.dump(out, open(os.path.join(HERE, "prepr_overlap.json"), "w"), indent=1)
# list PRs with pre-PR review AND CI important
for p in d:
    if p["verdicts"] and p["verdicts"][0]["imp"] >= 1 and RX.search(bodies.get(p["n"], "")):
        print(p["n"], p["verdicts"][0]["imp"], RX.search(bodies[p["n"]]).group(0))

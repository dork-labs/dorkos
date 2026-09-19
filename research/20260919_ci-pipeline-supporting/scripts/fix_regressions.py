#!/usr/bin/env python3
"""Change-failure proxy: fix PRs (30d) whose body both uses regression language and cites a PR merged <=7d before."""
import json,re,statistics
from datetime import datetime
B=json.load(open("prs_bodies.json")); ma={p["number"]:p["mergedAt"] for p in B}
def t(s): return datetime.strptime(s,"%Y-%m-%dT%H:%M:%SZ")
fix=[p for p in B if re.match(r"(?i)^(fix|hotfix)(\(|:|!)",p["title"])]
hits=[]
for p in fix:
    body=p["body"] or ""
    if not re.search(r"(?i)regress|introduced (in|by)|broke|caused by|shipped (in|with|by)|landed (in|with|by)", body): continue
    for r in re.findall(r"#(\d{3,5})", body):
        r=int(r)
        if r in ma and r!=p["number"]:
            gap=(t(p["mergedAt"])-t(ma[r])).total_seconds()/3600
            if 0<=gap<=7*24: hits.append((p["number"],r,round(gap,1))); break
print(f"fix PRs: {len(fix)}; with regression language + a cited PR merged <=7d earlier: {len(hits)} ({100*len(hits)/len(B):.1f}% of all merged); median gap {statistics.median([h[2] for h in hits]) if hits else '-'}h")
print(hits)

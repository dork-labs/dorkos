#!/usr/bin/env python3
"""Read-only: for every inline Important finding on a verdict with >=1 important, compare the
flagged file's blob SHA at the reviewed commit vs the PR's final head. A changed blob is the
best available proxy for 'the author touched what was flagged' (catches amend+force-push
fixes that commit-message comparison misses). -> flagged_blobs.json"""
import json, os, subprocess, urllib.parse
from datetime import datetime
HERE = os.path.dirname(os.path.abspath(__file__))
ts = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00"))
d = {p["n"]: p for p in json.load(open(os.path.join(HERE, "review_dataset.json")))}
path = os.path.join(HERE, "flagged_blobs.json")
out = json.load(open(path)) if os.path.exists(path) else {}
cache = {}
def blob(sha, fp):
    k = (sha, fp)
    if k in cache: return cache[k]
    r = subprocess.run(["gh", "api", f"repos/dork-labs/dorkos/contents/{urllib.parse.quote(fp)}?ref={sha}", "--jq", ".sha"], capture_output=True, text=True)
    cache[k] = r.stdout.strip() if r.returncode == 0 else "MISSING"
    return cache[k]
for n, p in d.items():
    for v in p["verdicts"]:
        if v["imp"] < 1: continue
        rs = v["run_sha"] or v["head_at"]
        for th in p["threads"]:
            if abs((ts(th["t"]) - ts(v["t"])).total_seconds()) > 1800: continue
            if not ("🔴" in th["body"] or "mportant" in th["body"][:120]): continue
            key = f"{n}|{v['t']}|{th['path']}|{th['line']}"
            if key in out: continue
            a = blob(rs, th["path"]) if rs else None; b = blob(p["final_sha"], th["path"])
            out[key] = {"n": n, "verdict_t": v["t"], "path": th["path"], "line": th["line"], "reviewed": rs, "final": p["final_sha"],
                        "blob_reviewed": a, "blob_final": b, "changed": (a != b) if a and b else None,
                        "resolved": th["resolved"], "outdated": th["outdated"], "author_reply": any(x["a"] != "claude" for x in th["replies"])}
json.dump(out, open(path, "w"), indent=1)
import collections
print(len(out), collections.Counter((o["changed"], o["outdated"]) for o in out.values()))

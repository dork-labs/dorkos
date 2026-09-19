#!/usr/bin/env python3
"""Join PR detail + claude-code-review runs into one per-PR record (review_dataset.json)."""
import json, os, re, bisect
from datetime import datetime, timezone
HERE = os.path.dirname(os.path.abspath(__file__)); PARENT = os.path.dirname(HERE)
det = json.load(open(os.path.join(HERE, "pr_review_detail.json")))
runs = [r for r in json.load(open(os.path.join(PARENT, "runs_all.json"))) if r["name"] == "claude-code-review"]
def ts(s): return datetime.fromisoformat(s.replace("Z", "+00:00"))
by_branch = {}
for r in runs:
    by_branch.setdefault(r["head_branch"], []).append(r)
VERDICT = re.compile(r"[0-9]+ important|[0-9]+ nits?|No blocking issues|No factual issues")
IMP = re.compile(r"(\d+)\s+important", re.I); NIT = re.compile(r"(\d+)\s+nits?", re.I)
FAILNOTE = re.compile(r"This check is red|hit an error|ran out of its turn budget|never posted a verdict", re.I)
out = []
for k, v in det.items():
    n = int(k)
    labels = [l["name"] for l in v["labels"]["nodes"]]
    tl = v["timelineItems"]["nodes"]
    commits = [(c["commit"]["oid"], c["commit"]["committedDate"]) for c in tl if c["__typename"] == "PullRequestCommit"]
    fps = [(e["createdAt"], (e.get("afterCommit") or {}).get("oid")) for e in tl if e["__typename"] == "HeadRefForcePushedEvent"]
    lab = [(e["createdAt"], e["label"]["name"], e["__typename"]) for e in tl if e["__typename"] in ("LabeledEvent", "UnlabeledEvent")]
    rr = [t for t, name, typ in lab if name == "re-review" and typ == "LabeledEvent"]
    skip_ever = any(name == "skip-review" for _, name, typ in lab if typ == "LabeledEvent") or "skip-review" in labels
    prruns = [r for r in by_branch.get(v["headRefName"], []) if ts(r["created_at"]) <= ts(v["mergedAt"]) and ts(r["created_at"]) >= ts(v["createdAt"]).replace(second=0) ]
    verdicts, failnotes, other_claude = [], [], []
    for c in v["comments"]["nodes"]:
        a = (c.get("author") or {}).get("login")
        if a not in ("claude", "github-actions"): continue
        body = c["body"] or ""
        head = body[:400]
        if a == "github-actions" or FAILNOTE.search(head):
            if FAILNOTE.search(head): failnotes.append({"t": c["createdAt"], "body": body[:300], "author": a})
            continue
        if VERDICT.search(head) or head.startswith("Re-review"):
            m = IMP.search(head); m2 = NIT.search(head)
            imp = int(m.group(1)) if m else 0
            nits = int(m2.group(1)) if m2 else 0
            # match run whose window contains the comment
            t = ts(c["createdAt"]); run = None
            for r in prruns + [x for x in runs if x["event"] == "workflow_dispatch"]:
                if ts(r["run_started_at"]) <= t <= ts(r["updated_at"]):
                    run = r; break
            # head at time t from timeline (fallback)
            head_at = None
            evs = [(cd, oid) for oid, cd in commits] + [(fa, oid) for fa, oid in fps if oid]
            evs = [e for e in evs if ts(e[0]) <= t]
            if evs: head_at = max(evs)[1]
            verdicts.append({"t": c["createdAt"], "imp": imp, "nits": nits, "body": body,
                             "run_id": run["id"] if run else None, "run_event": run["event"] if run else None,
                             "run_sha": run["head_sha"] if run and run["event"] == "pull_request" else None,
                             "run_secs": (ts(run["updated_at"]) - ts(run["run_started_at"])).total_seconds() if run else None,
                             "head_at": head_at})
        else:
            other_claude.append({"t": c["createdAt"], "body": body[:200]})
    threads = []
    for th in v["reviewThreads"]["nodes"]:
        cs = th["comments"]["nodes"]
        if not cs: continue
        first = cs[0]
        if (first.get("author") or {}).get("login") != "claude": continue
        threads.append({"path": th["path"], "line": th["line"] or th["originalLine"], "resolved": th["isResolved"], "outdated": th["isOutdated"],
                        "t": first["createdAt"], "body": first["body"], "orig_commit": (first.get("originalCommit") or {}).get("oid"),
                        "replies": [{"a": (x.get("author") or {}).get("login"), "t": x["createdAt"], "body": x["body"][:600]} for x in cs[1:]]})
    out.append({"n": n, "title": v["title"], "created": v["createdAt"], "merged": v["mergedAt"], "final_sha": v["headRefOid"], "branch": v["headRefName"],
                "add": v["additions"], "del": v["deletions"], "files": v["changedFiles"], "labels": labels, "skip_ever": skip_ever,
                "commits": commits, "force_pushes": fps, "rereview_labeled": rr, "verdicts": sorted(verdicts, key=lambda x: x["t"]),
                "failnotes": failnotes, "other_claude": other_claude, "threads": threads,
                "runs": [{"id": r["id"], "event": r["event"], "concl": r["conclusion"], "sha": r["head_sha"], "start": r["run_started_at"], "end": r["updated_at"]} for r in prruns]})
json.dump(out, open(os.path.join(HERE, "review_dataset.json"), "w"), indent=1)
print(len(out))

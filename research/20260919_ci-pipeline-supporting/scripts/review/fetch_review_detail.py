#!/usr/bin/env python3
"""Read-only: fetch per-PR review detail for every merged PR in ../prs_merged.json.

For each PR: head SHA at merge, full Claude comment bodies, review threads (inline
findings with the commit they were made on), commit oids + dates, force-push events,
label events. Writes pr_review_detail.json (dict number -> node). Resumable.
"""
import json, subprocess, sys, os
HERE = os.path.dirname(os.path.abspath(__file__))
PARENT = os.path.dirname(HERE)
nums = sorted(p["number"] for p in json.load(open(os.path.join(PARENT, "prs_merged.json"))))
out_path = os.path.join(HERE, "pr_review_detail.json")
out = json.load(open(out_path)) if os.path.exists(out_path) else {}
todo = [n for n in nums if str(n) not in out]
print(f"{len(nums)} PRs, {len(todo)} to fetch", file=sys.stderr)
FRAG = """
  number title createdAt mergedAt headRefOid headRefName additions deletions changedFiles
  labels(first: 30) { nodes { name } }
  comments(first: 100) { nodes { author { login } createdAt body } }
  reviewThreads(first: 100) { nodes { isResolved isOutdated path line originalLine
     comments(first: 10) { nodes { author { login } body createdAt commit { oid } originalCommit { oid } } } } }
  timelineItems(first: 250, itemTypes: [PULL_REQUEST_COMMIT, HEAD_REF_FORCE_PUSHED_EVENT,
     LABELED_EVENT, UNLABELED_EVENT, READY_FOR_REVIEW_EVENT, MERGED_EVENT]) {
    pageInfo { hasNextPage }
    nodes { __typename
      ... on PullRequestCommit { commit { oid committedDate authoredDate } }
      ... on HeadRefForcePushedEvent { createdAt beforeCommit { oid } afterCommit { oid } }
      ... on LabeledEvent { createdAt label { name } actor { login } }
      ... on UnlabeledEvent { createdAt label { name } actor { login } }
      ... on ReadyForReviewEvent { createdAt }
      ... on MergedEvent { createdAt commit { oid } }
    } }
"""
B = 6
for i in range(0, len(todo), B):
    chunk = todo[i:i + B]
    parts = [f"p{n}: pullRequest(number: {n}) {{ {FRAG} }}" for n in chunk]
    q = "query { repository(owner: \"dork-labs\", name: \"dorkos\") { " + " ".join(parts) + " } }"
    r = subprocess.run(["gh", "api", "graphql", "-f", f"query={q}"], capture_output=True, text=True)
    if r.returncode != 0:
        print("ERR", chunk, r.stderr[:500], file=sys.stderr); continue
    data = json.loads(r.stdout)["data"]["repository"]
    for k, v in data.items():
        if not v: continue
        for c in v["comments"]["nodes"]:
            login = (c.get("author") or {}).get("login") or ""
            if login not in ("claude", "github-actions", "claude[bot]"):
                c["body"] = (c.get("body") or "")[:300]
        out[str(v["number"])] = v
    if (i // B) % 10 == 0:
        json.dump(out, open(out_path, "w"))
        print(f"fetched {i + len(chunk)}/{len(todo)}", file=sys.stderr)
json.dump(out, open(out_path, "w"))
print("done", len(out), file=sys.stderr)

#!/usr/bin/env python3
"""Fetch GraphQL timeline data for every PR in prs_merged.json + prs_created.json.

Batches 15 PRs per GraphQL query via aliases. Writes pr_timelines.json
(dict number -> PR node). Read-only.
Usage: python3 fetch_timelines.py
"""
import json, subprocess, sys, os

HERE = os.path.dirname(os.path.abspath(__file__))
nums = set()
for f in ("prs_merged.json", "prs_created.json"):
    for p in json.load(open(os.path.join(HERE, f))):
        nums.add(p["number"])
nums = sorted(nums)

out_path = os.path.join(HERE, "pr_timelines.json")
out = json.load(open(out_path)) if os.path.exists(out_path) else {}
todo = [n for n in nums if str(n) not in out]
print(f"{len(nums)} PRs, {len(todo)} to fetch", file=sys.stderr)

FRAG = """
  number title createdAt mergedAt closedAt isDraft state
  additions deletions changedFiles
  author { login }
  labels(first: 30) { nodes { name } }
  commits(first: 1) { totalCount nodes { commit { authoredDate committedDate } } }
  lastCommits: commits(last: 1) { nodes { commit { committedDate } } }
  reviews(first: 5) { nodes { author { login } submittedAt state } }
  comments(first: 40) { nodes { author { login } createdAt body } }
  timelineItems(first: 100, itemTypes: [READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT,
     ADDED_TO_MERGE_QUEUE_EVENT, REMOVED_FROM_MERGE_QUEUE_EVENT, AUTO_MERGE_ENABLED_EVENT,
     AUTO_MERGE_DISABLED_EVENT, MERGED_EVENT, CLOSED_EVENT, REOPENED_EVENT,
     HEAD_REF_FORCE_PUSHED_EVENT, LABELED_EVENT, UNLABELED_EVENT]) {
    pageInfo { hasNextPage }
    nodes {
      __typename
      ... on ReadyForReviewEvent { createdAt }
      ... on ConvertToDraftEvent { createdAt }
      ... on AddedToMergeQueueEvent { createdAt enqueuer { login } }
      ... on RemovedFromMergeQueueEvent { createdAt reason actor { login } }
      ... on AutoMergeEnabledEvent { createdAt actor { login } }
      ... on AutoMergeDisabledEvent { createdAt reason reasonCode actor { login } }
      ... on MergedEvent { createdAt actor { login } }
      ... on ClosedEvent { createdAt }
      ... on ReopenedEvent { createdAt }
      ... on HeadRefForcePushedEvent { createdAt }
      ... on LabeledEvent { createdAt label { name } actor { login } }
      ... on UnlabeledEvent { createdAt label { name } actor { login } }
    }
  }
"""

B = 15
for i in range(0, len(todo), B):
    chunk = todo[i:i + B]
    parts = [f"p{n}: pullRequest(number: {n}) {{ {FRAG} }}" for n in chunk]
    q = "query { repository(owner: \"dork-labs\", name: \"dorkos\") { " + " ".join(parts) + " } }"
    r = subprocess.run(["gh", "api", "graphql", "-f", f"query={q}"], capture_output=True, text=True)
    if r.returncode != 0:
        print("ERR", chunk, r.stderr[:500], file=sys.stderr)
        continue
    data = json.loads(r.stdout)["data"]["repository"]
    for k, v in data.items():
        if v:
            # trim comment bodies to keep file small
            for c in v["comments"]["nodes"]:
                c["body"] = (c.get("body") or "")[:200]
            out[str(v["number"])] = v
    json.dump(out, open(out_path, "w"))
    print(f"fetched {i + len(chunk)}/{len(todo)}", file=sys.stderr)

print("done", len(out), file=sys.stderr)

#!/usr/bin/env python3
"""Read-only: for each verdict whose reviewed SHA != the PR's final SHA, fetch
compare(reviewed...final): status, ahead/behind, commit messages, files. -> compare.json"""
import json, os, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__))
d = json.load(open(os.path.join(HERE, "review_dataset.json")))
path = os.path.join(HERE, "compare.json")
out = json.load(open(path)) if os.path.exists(path) else {}
pairs = set()
for p in d:
    for v in p["verdicts"]:
        s = v["run_sha"] or v["head_at"]
        if s and s != p["final_sha"]:
            pairs.add((p["n"], s, p["final_sha"]))
todo = [x for x in pairs if f"{x[1]}...{x[2]}" not in out]
print(len(pairs), "pairs", len(todo), "todo", file=sys.stderr)
for i, (n, a, b) in enumerate(sorted(todo)):
    r = subprocess.run(["gh", "api", f"repos/dork-labs/dorkos/compare/{a}...{b}",
                        "--jq", "{status, ahead_by, behind_by, commits: [.commits[] | {sha: .sha[0:10], msg: (.commit.message | split(\"\\n\")[0]), date: .commit.committer.date}], files: [.files[] | {filename, additions, deletions}]}"],
                       capture_output=True, text=True)
    out[f"{a}...{b}"] = {"n": n, **(json.loads(r.stdout) if r.returncode == 0 else {"error": r.stderr[:200]})}
    if i % 25 == 0:
        json.dump(out, open(path, "w")); print(i, file=sys.stderr)
json.dump(out, open(path, "w"))

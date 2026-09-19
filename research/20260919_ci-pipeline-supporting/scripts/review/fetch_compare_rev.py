#!/usr/bin/env python3
"""Read-only: for diverged pairs, fetch the reverse compare (final...reviewed) so rebased
copies of already-reviewed commits can be told apart from genuinely new commits."""
import json, os, subprocess
HERE = os.path.dirname(os.path.abspath(__file__))
c = json.load(open(os.path.join(HERE, "compare.json")))
path = os.path.join(HERE, "compare_rev.json")
out = json.load(open(path)) if os.path.exists(path) else {}
for k, v in c.items():
    if v.get("status") != "diverged" or k in out: continue
    a, b = k.split("...")
    r = subprocess.run(["gh", "api", f"repos/dork-labs/dorkos/compare/{b}...{a}", "--jq", "[.commits[] | (.commit.message | split(\"\\n\")[0])]"], capture_output=True, text=True)
    out[k] = json.loads(r.stdout) if r.returncode == 0 else None
json.dump(out, open(path, "w"))
print(len(out))

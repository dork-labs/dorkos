---
id: 261123-220000
title: The Claude review also reviews as DorkOS Security and posts a fixed-shape verdict, read by an advisory security-verdict check
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.claude-code-review.security-verdict
prs: []
ratchet-release: []
field-changes: []
---

Step 1 of DOR-5098 (every merge gate in the cloud, then auto-merge at PR open): DOR-5099, with
the first slice of DOR-5100. Today the Security verdict comes from a local agent's review and a
label. The label is applied by the one GitHub login every agent shares, so it proves nothing on
its own. The whole path also stops when the laptop does.

- **The lens.** `ci/security/review-lens.md` holds Security's severity bar and review criteria.
  It contains no known open issues and no exploit paths, because the repo is public. The review
  job reads main's copy, so a PR cannot edit its own criteria.
- **The review.** `claude-code-review.yml`'s reviewer runs a second pass over the same diff with
  that lens.
- **The verdict.** The reviewer posts it through `review-gh.sh security-verdict`, choosing only
  pass or fail, a Must count and categories from a fixed list. The helper writes every other byte
  of the comment, including the head SHA from the workflow, so a verdict never carries a finding.
- **The check.** A new `security-verdict` job reads that verdict with
  `scripts/security-verdict-check.sh`. It passes only on a bot's `pass` for this exact head.

**Advisory.** The local Security agent keeps reviewing. The comparison is on heads both reviewed:
cloud verdict against Security's label, with a target of 100% agreement on Musts. Before the check
becomes required, three things are needed:

- runs on every push, not only at open;
- somewhere private for Must details;
- the org rule (DOR-5101).

Hygiene, not an experiment: it moves a gate's evidence into the cloud rather than moving a
collected metric. Revert if the lens pass makes the code review lose its own verdict (the
`claude-code-review` check's turn-budget failures rise), or if a verdict ever carries a finding.

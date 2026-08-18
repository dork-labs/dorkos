# Jordan Lyall findings (0.61.0, 2026-08-17) — ideation

**Brief.** A friend-tester (Jordan Lyall) spent ~90 minutes on DorkOS 0.61.0 — the Mac app, the npm install, and a `/flow:init` — and wrote up 16 findings plus a "better than they need to be" list. The raw notes are preserved verbatim in [`00-findings.md`](00-findings.md). This spec fixes or improves every one of them.

**Why now.** Three of the four "blockers" are in the Mac app, which is the shipped, notarized surface at `dorkos.ai/download/mac`. Two of them ("Claude Code missing when it's installed", "Install Claude does nothing") happen on the first screen a new Mac user sees. The relay findings block the headline multi-agent story. The flow findings mean the marketplace plugin recommends a tracker it then rejects.

**Approach.** Root causes were traced by the orchestrator against the running 0.61.0 Mac app (launched with a Finder-like environment against a throwaway home), the extracted `app.asar`, a synthetic asar reproduction inside a real Electron `utilityProcess`, and the source. Every root cause below was reproduced, not inferred — see `02-specification.md` for the evidence per finding. Implementation is delegated per work item to agents in isolated worktrees, each branch adversarially reviewed against `REVIEW.md` before its PR opens, and browser/packaged-app verified.

**Out of scope.** Codex behaviour beyond "it is registered and its status is honest" (Jordan never exercised Codex). A namespace-model redesign for mesh (filed as a follow-up; §D chooses the surfacing fix over a migration).

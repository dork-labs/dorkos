---
slug: agent-computer-mvp
number: 261012-205009
created: 2026-10-12
status: validated
---

# One persistent local agent computer

The human authorized this new MVP session to deliver DOR-2748, reusing unfinished Browser work rather than restarting its programme. The Oct 6 detailed design and later founder decisions are the validated input; no new broad ideation or research phase is needed.

One Linux computer runs on the current Apple Silicon Mac, behind an experiment. Its runtime, files, browser and vendor login live inside it. The person sees that same desktop in DorkOS and can take over. Creation, start, stop and reconnect are automatic. Projects and home survive a stop. Unknown cleanup stays unknown.

Cloud computers, transfer, shared-drive management, fleets, other host platforms and the trusted-default rollout are deferred. Current admission, audit, pause and permissions remain in force. No paid model or cloud use is authorized by bootstrap.

## Source custody and bounded salvage

Browser owner explicitly transferred logical implementation ownership of `codex/browser-production-authority` at `8bb1d4227a6483542f5852847e4a21662dd1bca4`. Derive successors in this chat's managed worktree. Preserve that original checkout, six other Browser checkouts, immutable source packets/PINS, failed VM homes and all unknown/HELD resources. PR 2686 stays draft and unmerged.

Durable handoff: `/Users/doriancollier/Keep/dork-os/.workspace/browser-channel-evidence/browser-integrated-repair-handoff-source9-20261006/AGENT-COMPUTER-MVP-HANDOFF-20261012.md`.

The Browser QEMU stack has no accepted complete asset export, first frame or durable reopen/crash proof. Its guest starts a fixed browser driver, not a desktop or general runtime process. Reusing the whole stack requires the old qualification programme before adding this scope. Preserve its display/input correlation, ownership and lifecycle ideas, and its confined credential/egress source; do not turn receipts into authority or silently weaken its original gates.

A bounded independent read-only analysis recommends direct Lima/VZ Linux and the existing OpenCode HTTP runtime seam. No Podman is needed for one VM. Lima's default host mounts and host-loopback network access must be explicitly removed or blocked. OpenCode HTTP-native history avoids a rewrite of Claude's host transcript readers.

## Decisions already resolved

- One local Apple Silicon computer; no competing cloud or platform work.
- One real OpenCode runtime inside the guest for this increment; existing host runtimes remain usable.
- Real vendor-program login inside this guest; no shared sign-in drive or imported host credentials.
- Direct Linux VM, no container layer. Backend chosen from bounded salvage evidence, not frozen by earlier research.
- Guest-owned persistent disk, no host mounts, non-root agent, host/LAN denial. Host credentials never enter the guest environment.

## References

- DOR-2748; related paused Browser DOR-2667 and DOR-2672.
- `research/20261006_agent-linux-desktop.md`.
- `research/20261006_agent-computer-bootstrap-and-vendor-logins.md`.
- `plans/2026-10-vision-reset-decisions.md`, item 7.
- `meta/VISION.md`, `PRINCIPLES.md`, `VOICE.md`, `ROADMAP.md`, `PROACTIVE-AGENTS.md`.

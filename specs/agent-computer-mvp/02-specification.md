---
slug: agent-computer-mvp
number: 261012-205009
created: 2026-10-12
status: specified
---

# One persistent local agent computer

**Status:** Approved scope; implementation and acceptance pending.
**Author:** Codex, under the human's new-session authorization.
**Date:** 2026-10-12

## Overview

Enable one persistent Linux agent computer on an Apple Silicon Mac through a default-off experiment. OpenCode runs inside it. A person chats through the existing DorkOS session surface and watches or takes over the same desktop and browser. DorkOS provisions and reconnects it without requiring a terminal, Docker, compiler or separately managed daemon.

## Background / Problem Statement

Today's runtimes work directly on the person's machine. A founder cannot give an agent a separate persistent computer and watch its actual desktop. The Browser predecessor has useful control and ownership source but no accepted VM asset build, first frame or durable recovery. Extending its browser-specific image/opaque protocol would restart a much larger qualification programme. The Oct 6 design already resolves the product shape; this increment cuts it to one actual end-to-end path.

## Goals

- Create, start, stop and reconnect one Linux computer from the app.
- Run the actual OpenCode CLI/sidecar inside it with native shell and file tools.
- Chat, history, interrupt, approvals, audit and pause pass through current AgentRuntime admission.
- Preserve guest home, project files, Chromium profile and vendor login across a stop and server restart.
- Show the same visible desktop/browser to person and agent, with observe and exclusive takeover.
- Report setup, failure and uncertain stop truthfully. Verify the installed CLI/app path before shipment.

## Non-Goals

Cloud hosting/migration, shared drives UI, fleets, templates, Windows/Linux/Intel hosts, all runtime backends, Community convergence, full trusted defaults and TanStack Sandboxes. The old Browser programme remains paused. This PR references DOR-2748 without closing the broader transfer scope.

## Technical Dependencies

- Managed pinned Lima release for darwin/arm64, VZ backend; install into DorkOS-owned storage with SHA-256 verification and bounded download. Never invoke arbitrary customer executables or shell-selected paths.
- Pinned ARM64 Linux image with digest verification, Node/git, OpenCode, Chromium, Xvfb/Openbox and a bounded PNG framebuffer and typed input helper. Package/bootstrap commands are DorkOS-owned and reproducible. No dependency installed globally on the host.
- Existing `@opencode-ai/sdk`, OpenCodeRuntime, session map, Hono request chain, Transport, experiment registry and shared UI.
- Official Lima docs: `https://lima-vm.io/docs/installation/`, `https://lima-vm.io/docs/config/mount/`, `https://lima-vm.io/docs/config/network/user/`.
- OpenCode server API: `https://opencode.ai/docs/server/`.

## Detailed Design

### Control and execution

The host DorkOS remains the control plane. A small `services/computers/` domain owns a computer record, isolated Lima home, lifecycle journal and backend. The guest runs a non-root `agent` user, one display, one persistent Chromium profile and authenticated OpenCode sidecar. Host administration is separate from the agent user. No host filesystem mounts, forwarded SSH agent, copied vendor auth or inherited model environment is permitted.

The backend exposes typed create/start/status/stop/exec/endpoint operations with bounded subprocess output and deadlines. All subprocesses use argument arrays and explicit environments. Only exact owned instance names under the isolated DorkOS Lima home are touched. The persistent disk is never deleted by stop, experiment disable or server shutdown. Each action records intent before entry and outcome after observation; absence of a process is not cleanup proof. Ownership mismatch or unfinished observation returns `uncertain`, retains data and prevents an automatic replacement. Stale operations cannot publish a newer generation as ready.

### Runtime admission

Register a distinct computer-scoped OpenCodeRuntime instance backed by its authenticated guest endpoint, with durable session bindings and a stable runtime id. Existing host runtimes stay registered. A host metadata-only workspace anchor keeps current host path/agent-identity admission valid; a narrowly scoped wire mapping translates that exact anchor to the guest's `/home/agent/project`. It must preserve canonical directories in session/history/events without replacing prose, tool content or arbitrary paths. Unknown or foreign directories are refused.

Computer session creation is through its authenticated host route and the normal registry/settings path. No caller may supply a sidecar URL, executable, credential, mount or runtime id. Disabling the experiment fences all new guest work and revokes viewing/control, then joins exact owned stop; no fallback to a host runtime. Runtime/provider loss ends the affected turn visibly; no automatic replay. Computer runtimes refuse DorkOS credits for this increment. Login failures become a Sign in action rather than silently choosing another bill.

MCP access uses a narrowly scoped authenticated bridge reachable by this guest; existing actor identity, permissions, audit, pause and Rooms rules continue to govern. Local host URLs and arbitrary stdio MCP configurations cannot be blindly projected into a guest. Only implemented reachable capabilities are advertised. Any unavailable managed tool is explicitly refused rather than granting broad host access.

### Desktop and control

The guest's display is the source of both screenshots and person viewing. A root-owned authenticated helper supplies bounded PNG frames and typed input; no VNC service is required. Chromium runs visibly there under a separate desktop user, with a persistent profile and no unauthenticated CDP listener. The agent cannot read the Xauthority cookie or reconfigure the root-owned desktop. A guest computer/browser tool targets that same display; it never opens a host Chrome or another hidden browser.

Host Hono routes proxy the desktop stream with current request/session authority. Guest stream, OpenCode and debug ports are not exposed on LAN. View is observe-only by default. Takeover obtains an exclusive generation-bound control lease, interrupts/pauses conflicting agent input, and closes previous controllers. Control messages require that live lease; revocation releases held input and rejects delayed messages. Closing a viewer leaves the computer running. Touch/keyboard/pointer behavior is verified on the real surface; no terminal-only delivery.

### Login, persistence and network

Sign in starts the unmodified vendor program inside the guest and displays its terminal/browser in the app. Auth data remains vendor-owned inside that computer. DorkOS does not read, copy, log or intermediate Claude tokens or host vendor stores. Bootstrap never performs paid inference.

Guest firewall rules enforced outside the non-root agent deny host-loopback, private/LAN, link-local/metadata and unsupported IPv6 paths. DNS and narrowly scoped DorkOS bridge access are explicit exceptions. No arbitrary reverse port forward is handed to the agent. Test denial with actual guest commands. Retain scoped Browser egress/credential source as reference; do not claim that its Chrome proxy flags confine arbitrary guest shell traffic. API keys are not imported for this MVP. User login inside the actual guest program is the only supported inference source.

### API and data

Default-off `computers.enabled` uses the existing config/Experiments read/write path. Authenticated `/api/computers` operations return closed shared schemas: id/name, platform support, phase, observed generation, runtime/session anchors, readiness and safe error code. Create is singleton/idempotent; start reconnects the retained computer; stop retains disk; takeover is separately scoped. Credentials, raw diagnostics and filesystem internals stay private. Lifecycle storage is under resolved DorkOS home, owner-only and symlink guarded. No schema for cloud/transfer is shipped prematurely.

## User Experience

Enable Agent computer in Settings → Experiments. Open the computer from the Team/agent surface or experiment action. Create shows download/setup progress and a retryable failure. Once ready, Sign in opens the actual vendor program, Chat opens a normal DorkOS session, and View opens the desktop. The viewer offers Take over, Return control and Stop. Stopped computer shows Start and retains its data. Unsupported hosts get a concise reason. All app blocks follow the 15-word limit and current copy skills.

## Testing Strategy

Unit tests prove default-off/disable fencing, singleton concurrency, stale generations, restart reconciliation, ownership refusal and uncertainty retention. Runtime tests prove exact directory mapping, event/history routing, credentials-mode refusal and no host fallback. Route tests use the real Hono chain and authority failures. Viewer tests prove observe rejects input, exclusive takeover, revoked queued input and closing a viewer does not stop the VM.

Actual acceptance creates the computer through the built app, boots Linux, writes/reads a file through its runtime path, opens visible Chromium, captures its actual frame and exercises person takeover. Stop/start and host-server restart retain file/profile/history. Test host/LAN denial and guest privilege boundaries. A real-model reply requires separately existing explicit per-path authorization; absent that, do all non-inference acceptance and report that precise final blocker rather than billing or claiming full runtime proof. Record raw logs and visible proof; fixtures cannot establish VM readiness.

## Performance Considerations

One computer only, bounded memory/CPU and sparse persistent disk. First setup includes a Linux image download; show truthful progress, never promise a one-minute cold VM setup. Desktop stream runs when viewed; agent execution persists without a viewer. Collect actual boot, reconnect and first-frame timings.

## Security Considerations

Mac VZ boundary, guest non-root runtime, no host mounts/credentials/SSH forwarding, private authenticated endpoints and host/LAN denial. Existing platform authority is retained. Observe/takeover, disable and stale-generation checks run at every action boundary. Preserve failed/unknown resources and logs without leaking secrets.

## Documentation

Add an experimental local agent-computer guide with supported host/runtime, actual sign-in, stop/data semantics and troubleshooting. Add a plain changelog fragment only for proven behavior. Keep Cloud computers and transfer behind the demo-claim gate.

## Implementation Phases

1. Managed Linux backend and reproducible guest; prove shell/display/persistence/network before wider wiring.
2. Computer-scoped runtime and normal authenticated app path; experiment, chat, viewer, sign-in and takeover.
3. Independent adversarial review, meaningful fresh checks, normal hooks/push, protected merge, installed shipment verification and creator-owned cleanup.

## Open Questions

- ~~(RESOLVED) Reuse Browser VM wholesale?~~ Direct Lima/VZ Linux. Complete Browser assets, display and persistence remain unqualified; preserve source and reuse concrete patterns selectively.
- ~~(RESOLVED) First runtime?~~ OpenCode sidecar, whose history and events already use HTTP. Other runtime/backend support follows later.
- ~~(RESOLVED) Shared sign-in drive?~~ Retired by the founder; real vendor program signs in independently inside this computer.
- ~~(RESOLVED) Podman?~~ Unnecessary for one dedicated VM; omit it.

## Related ADRs

ADR-0308 (OpenCode), ADR-0310 (runtime-owned session storage), `261006-235237` through `261006-235242` (vision reset), `261009-192542` (Hono). This increment adds a proposed local-computer backend ADR; it does not claim transfer or trust-default implementation.

## References

DOR-2748; related Browser DOR-2667/DOR-2672 and preserved draft PR 2686. The detailed Oct 6 research and exact custody handoff are linked in `01-ideation.md`. Pinned source base: `f6178814c9b4bf564d2c7991df37c790940b5632`. Implementation worktree: `/Users/doriancollier/.codex/worktrees/agent-computer-mvp/dorkos`, branch `codex/agent-computer-mvp`.

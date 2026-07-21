---
title: 'Vercel Sandbox as an Agent Execution Environment (DOR-326)'
date: 2026-07-21
type: internal-architecture
status: active
tags:
  [
    vercel-sandbox,
    agent-runtime,
    workspace-provider,
    firecracker,
    microvm,
    e2b,
    daytona,
    modal,
    fly-machines,
    drives,
    oidc,
    container-registry,
    cost-model,
  ]
feature_slug: workspace-manager
searches_performed: 11
sources_count: 22
---

## Research Summary

DOR-326 asks whether DorkOS should run agents in Vercel Sandbox — disposable Firecracker microVMs — instead of (or alongside) local git worktrees. This is a **decision-grade update**, not a first look: `research/20260717_cloud-sandbox-workspace-provider.md` (4 days old) already did the deep comparative work and concluded **DEFER** on wiring any cloud sandbox into the shipped `WorkspaceProvider` hexagonal port, because that port hands back a local filesystem `path` that becomes `session.cwd` for a runtime executing **on the DorkOS host** — a remote sandbox's files are never on that host. This report confirms that conclusion still holds after re-verifying pricing/limits and researching three Vercel-specific capabilities the prior report didn't cover in depth — **Drives** (persistent cross-sandbox storage, private beta), **persistent sandboxes** (now the GA default, auto-snapshot/auto-resume), and **custom images via Vercel Container Registry** (`vcr.vercel.com`) — plus the **OIDC auth model** and the **exec/streaming surface** the SDK actually exposes. The net finding is unchanged and sharper: Vercel Sandbox is a well-built, cheap-at-idle, Firecracker-isolated execution primitive, but it is the substrate for a **remote `AgentRuntime`**, not a `WorkspaceProvider` — and even as a remote-runtime substrate it has a real gap DorkOS would have to design around: **no documented stdin/bidirectional-process API**, only run-to-completion or detached-with-log-tail commands, which doesn't map cleanly onto DorkOS's interactive permission-prompt UX.

## Key Findings

1. **The seam mismatch stands: `WorkspaceProvider.create()` must return a local `path`; Vercel Sandbox has no local path.** `packages/shared/src/workspace.ts` (read for this report) still ships exactly two providers, `worktree` and `clone`, and the `ProviderResult` contract is `{ path, branch }`. `WorkspaceManager` binds a session with `session.cwd = workspace.path`, and `validateBoundary()`/port allocation both assume that path is on the DorkOS host's own filesystem, under `~/.dork/workspaces/`. A Vercel Sandbox's filesystem lives inside its Firecracker microVM, reachable only through `@vercel/sandbox`'s `runCommand`/`fs.*` API — there is no host path to hand back. This is unchanged from the 2026-07-17 finding and is confirmed again by reading the current port interface (`packages/shared/src/workspace.ts:181-205`).

2. **Persistent sandboxes are now GA and are the _default_ behavior — a real improvement over the 2026-07-17 snapshot-management story.** As of the current docs (`last_updated: 2026-06-30`/2026-07-07), every `Sandbox.create()` is persistent unless you pass `persistent: false`: on `stop()` the filesystem auto-snapshots, and the next `runCommand`/`writeFiles` call **auto-resumes** a stopped sandbox from that snapshot with no manual snapshot bookkeeping. Sandboxes are addressed by a project-unique `name` (not an opaque id), and `Sandbox.getOrCreate({ name, onCreate, onResume })` is the documented pattern for long-lived agent workspaces: `onCreate` clones the repo and installs deps once; `onResume` restarts background processes (e.g. a dev server) every time a stopped sandbox wakes back up. Snapshot expiration is configurable per sandbox (`snapshotExpiration`, default 30 days from last use, `0`/`"none"` for indefinite) with a `keepLastSnapshots` cap to bound storage. — [Persistence](https://vercel.com/docs/sandbox/concepts/persistent-sandboxes) (accessed 2026-07-21)

3. **Drives (private beta, June 2026) fill the "shared, durable state across sandboxes" gap the prior report flagged as absent.** A Drive is storage independent of any one sandbox's lifecycle: up to 1 TiB (100 GiB default), mountable at a chosen path in up to 4 sandboxes' worth of mounts per run, persists until explicitly deleted (no 30-day expiry), and is **free during the beta**. It's positioned for exactly the DorkOS-relevant use case — "keeping agent workspaces across sandboxes," pnpm/build caches, shared datasets — but it is currently **single reader, single writer** ("support for multiple readers is coming soon"), so it does not yet support N concurrent agents sharing one warm dependency cache; each agent would need its own drive or serialize access. Snapshots remain the better fit for "this sandbox's own state," Drives for "state that outlives or is shared beyond one sandbox." — [Drives](https://vercel.com/docs/sandbox/concepts/drives) (accessed 2026-07-21)

4. **Custom images now go through Vercel Container Registry (`vcr.vercel.com`), a project-scoped, Docker-API-compatible OCI registry — but the workflow has real friction for a monorepo like DorkOS's.** You `docker buildx build --platform linux/amd64` (with zstd compression recommended, gzip/zstd only — uncompressed layers are rejected), `docker push` to `vcr.vercel.com/<team>/<project>/<repo>:<tag>`, then reference `image: 'my-repository:latest'` in `Sandbox.create()`. Two constraints matter for an agent-execution image: **Vercel Sandbox does not run the image's `ENTRYPOINT`/`CMD`** — you must start every process explicitly via `sandbox.runCommand()` after boot, which is fine for a build-time base image but means "docker-native" images built for `docker run` need adaptation; and images must resolve to a `Ready` state (`linux/amd64` manifest prepared) before use, so a freshly pushed image is not immediately usable (`image_not_ready`, retry). Building an image that tracks DorkOS's actual toolchain (Node 22/24, pnpm, the Claude Code/Codex/OpenCode CLIs, native modules like `better-sqlite3` this repo already finds finicky across platforms) is a standing maintenance line, not a one-time task — this restates finding 4 from the 2026-07-17 report with the concrete mechanics now confirmed. — [Images](https://vercel.com/docs/sandbox/concepts/images), [Container Registry](https://vercel.com/docs/container-registry) (accessed 2026-07-21)

5. **OIDC auth is clean for a Vercel-hosted caller, but DorkOS is not Vercel-hosted — it falls back to a static access-token model that is a real secret to manage.** The SDK prefers a `VERCEL_OIDC_TOKEN`, auto-issued and auto-rotated only for code running _on_ Vercel (Functions) or via `vercel env pull` in local dev (12 h expiry, manual refresh). Since DorkOS agents run from the user's own server (self-hosted, a VPS, or the local CLI) — never on Vercel — the only viable path is the **access-token method**: a long-lived `VERCEL_TOKEN` scoped to a team, plus `VERCEL_TEAM_ID`/`VERCEL_PROJECT_ID`, stored wherever DorkOS stores runtime credentials. That token is broader than a single sandbox — it authorizes the SDK's control-plane calls for the whole project/team — so treating it as a first-class secret (rotation, least-privilege team, never logged) is a hard requirement, and it reintroduces the "credentials leave the machine boundary" concern from the prior report, just for the _sandbox platform_ itself rather than for git/`.env`. — [Sandbox Authentication](https://vercel.com/docs/sandbox/concepts/authentication) (accessed 2026-07-21)

6. **The exec surface is run-to-completion or detached-with-log-tail — there is no documented stdin-write or PTY API.** `sandbox.runCommand()` either blocks for a `CommandFinished` or (with `detached: true`) returns a live `Command` you can `logs()` (an `AsyncGenerator<{stream, data}>`), `wait()`, or `kill(signal)`. The full SDK reference (fetched in full for this report) has no `write`/`stdin`/interactive-shell primitive — only file I/O (`sandbox.fs.*`, a `node:fs/promises`-compatible surface) and one-way log streaming out. **This is the sharpest fit gap for DorkOS specifically.** DorkOS's `AgentRuntime` conformance model assumes a runtime can carry a live, bidirectional turn — permission prompts routed to the cockpit UI and a user's approve/deny routed back into the still-running agent process. Vercel's own reference pattern for agent workloads (the "Using Vercel Sandbox to run Claude's Agent SDK" guide) runs the **entire agent loop headless inside the sandbox** with an Anthropic API key injected as an env var and no human-in-the-loop approval step — i.e., it sidesteps the interactive-permission problem rather than solving it. Reproducing DorkOS's interactive approval UX would require building an out-of-band channel (the in-sandbox agent process posts an approval request to the DorkOS server over HTTP/webhook, blocks, and the server calls back in — plausible, but it is new protocol design, not something the SDK hands you). — [JS SDK Reference](https://vercel.com/docs/sandbox/sdk-reference), [Using Vercel Sandbox to run Claude's Agent SDK](https://vercel.com/kb/guide/using-vercel-sandbox-claude-agent-sdk) (accessed 2026-07-21)

7. **Current limits and pricing are materially unchanged from the 2026-07-17 report and remain higher-friction than local worktrees on every dimension that matters for Kai's workload.** Re-verified directly from Vercel's pricing page (`last_updated: 2026-06-16`): $0.128/vCPU-hr **active** CPU (I/O-wait doesn't bill), $0.0212/GB-hr provisioned memory, $0.60/1M creations, $0.15/GB egress+exposed-port transfer, $0.08/GB-month snapshot storage, `iad1`-only region, **default timeout is 5 minutes** (must explicitly `extendTimeout()`), max runtime **45 min on Hobby / 24 h on Pro+**, max concurrent sandboxes 10 (Hobby) / 2,000 (Pro+), max 8 vCPU / 16 GB on Pro (32 vCPU / 64 GB Enterprise), 32 GB ephemeral NVMe disk fixed regardless of plan (Drives are the only way past 32 GB), $20/mo Pro credit. Nothing here changes the prior cost sketch materially: **~$40–75/month** for Kai's 10-agents × 2 h/day × 20-day (400 agent-hour) scenario at 2 vCPU/4 GB, against local worktrees' **$0**. — [Vercel Sandbox pricing and limits](https://vercel.com/docs/sandbox/pricing) (accessed 2026-07-21)

---

## Detailed Analysis

### What Vercel Sandbox actually is (2026-07-21 snapshot)

A Vercel Sandbox is a Firecracker microVM, one per sandbox, with a dedicated kernel (stronger isolation than a Docker container sharing the host kernel) — Vercel's own framing is explicitly for **running untrusted or AI-generated code**, not for hosting long-running services ("Sandboxes are not designed to run continuously... not suitable for permanent hosting"). Each sandbox boots from a built-in Amazon Linux 2023 runtime (`node22`/`node24`/`node26`/`python3.13`), a custom VCR image, or a saved snapshot; it gets a dedicated private filesystem, its own network namespace, kernel-level process isolation, and configurable firewalling via `NetworkPolicy` (`deny-all` etc.). Full root access is available inside. — [Understanding Sandboxes](https://vercel.com/docs/sandbox/concepts) (accessed 2026-07-21)

The two-level model matters for how DorkOS would think about it: a **Sandbox** (long-lived, named, survives across VM boots) contains a **Session** (one running VM instance; a fresh session starts from the last snapshot on every resume). This is the closest Vercel-native analog to a DorkOS `Workspace` (long-lived, keyed by unit-of-work) containing attached `Session`s (individual agent turns) — the _naming_ of the abstraction lines up well; the _filesystem locality_ does not.

### API surface mapped onto DorkOS's actual needs

| Need (from `WorkspaceProvider` + `AgentRuntime`)             | Vercel Sandbox primitive                                                             | Fit                                                                                                                |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Create/provision a working checkout                          | `Sandbox.create()` / `getOrCreate({ onCreate })` + `runCommand('git', ['clone', …])` | **Shim** — returns a sandbox handle, not a `path`                                                                  |
| Attach (bind session.cwd)                                    | —                                                                                    | **Breaks** — no local path exists to bind to                                                                       |
| Exec (agent runs commands, edits files)                      | `sandbox.runCommand()`, `sandbox.fs.*` (Node-fs-compatible)                          | **Fits**, but only for command-and-file-level automation                                                           |
| Interactive/streaming turn (permission prompts, live output) | `command.logs()` (one-way `AsyncGenerator`), no stdin-write/PTY                      | **Breaks** — one-way only; would need a new out-of-band approval channel                                           |
| Persist across runs                                          | Persistent sandboxes (auto-snapshot/auto-resume), Drives (shared, no-expiry)         | **Fits well** — materially better than the 2026-07-17 finding                                                      |
| Custom toolchain (node/pnpm/CLIs/native modules)             | VCR custom image (`vcr.vercel.com`), no `ENTRYPOINT`/`CMD`                           | **Shim** — works, standing build/push/track maintenance                                                            |
| Expose a dev server / preview URL                            | `sandbox.domain(port)`, ≤15 ports                                                    | **Fits** — replaces `localhost:PORT`, needs DOR-91 `hostname`/`url` (currently always `null` in `WorkspaceSchema`) |
| Dirty-state check before teardown                            | `runCommand('git', ['status', '--porcelain'])` inside the sandbox                    | **Shim** — feasible, off-host                                                                                      |
| Teardown                                                     | `sandbox.stop()` / `sandbox.delete()`                                                | **Fits** cleanly                                                                                                   |
| Auth from a self-hosted DorkOS server                        | Access token (`VERCEL_TOKEN`/`TEAM_ID`/`PROJECT_ID`) — OIDC is Vercel-hosting-only   | **Fits with a caveat** — a long-lived, team-scoped secret to manage                                                |

The pattern across this table repeats the 2026-07-17 conclusion: **teardown, dev-server exposure, and (now) persistence are clean fits; everything that assumes a local path or a bidirectional live process either breaks or needs a shim.**

### Cost sketch (re-verified 2026-07-21, unchanged from 2026-07-17)

Using the same Kai scenario (10 agents × 2 h/day × 20 working days = 400 agent-hours/month, 2 vCPU / 4 GB, ~15% active-CPU estimate for an I/O-bound coding agent):

| Scenario                                                   | Vercel Sandbox (active-CPU billing)                                                    | Local worktree |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------- |
| 1 agent-hour/day (≈20 agent-hours/month)                   | CPU ≈ $0.77 + mem ≈ $1.70 ≈ **~$2–3/mo** (inside the $20 Pro credit)                   | $0             |
| Kai: 10 agents × 2 h/day × 20 days (400 agent-hours/month) | CPU ≈ $15.36 + mem ≈ $33.92, minus $20 credit, plus variable transfer ≈ **~$40–75/mo** | $0             |

Vercel's own official example table (`/docs/sandbox/pricing#example-calculations`) corroborates the shape of this at smaller scale: a 30-minute, 4-vCPU/8-GB build-and-test run costs **~$0.34**; a 2-hour, 8-vCPU/16-GB long task costs **~$2.73** — both assuming 100% CPU utilization (a real coding-agent session, mostly waiting on model tokens, would cost less). The active-CPU billing model genuinely rewards DorkOS's actual usage pattern (agents idle on the model far more than they compute), which is Vercel Sandbox's strongest economic argument relative to Daytona/E2B/Fly's wall-clock-vCPU billing — but it is still **> $0** against a baseline that is exactly $0, on hardware the user already owns.

### Local-first / privacy posture (restated, one addition)

The 2026-07-17 findings on data leaving the machine, `iad1`-only residency, and Lil/Priya trust cost are unchanged. One addition from this pass: Vercel Sandbox's own security page states sandboxes run on "SOC 2 Type II certified" infrastructure and are "ephemeral" so they "do not persist data long-term" by design — but that framing is now in tension with **persistent sandboxes being the GA default** and **Drives having no expiry**. In practice, if DorkOS used Vercel Sandbox for agent workspaces the way it's now designed to be used (named, persistent, drive-backed), the "ephemeral, no long-term data" pitch doesn't describe the actual DorkOS usage pattern — the sandbox would functionally become a second, cloud-resident copy of the user's working tree that outlives any individual session, which is exactly the kind of standing off-machine data footprint the local-first thesis is trying to avoid.

---

## Alternatives Comparison Table

Carried forward from `research/20260717_cloud-sandbox-workspace-provider.md`, spot-checked 2026-07-21 (Daytona, E2B, Fly rates confirmed stable; Modal's sandbox-specific per-second rate converts to the same per-hour figure as before).

| Provider                        | Isolation                                  | Billing model                                            | CPU rate                             | Mem rate        | Base/monthly fee                                                    | Kai-scenario est. (400 agent-hrs) | Persistence                                        | Custom image                           | Notes                                                                                                   |
| ------------------------------- | ------------------------------------------ | -------------------------------------------------------- | ------------------------------------ | --------------- | ------------------------------------------------------------------- | --------------------------------- | -------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Local worktree (status quo)** | OS process, runtime-native sandboxing only | —                                                        | —                                    | —               | —                                                                   | **$0**                            | Indefinite, on disk                                | N/A (host toolchain)                   | Instant; zero data egress; no port/dev-server URL problem; no bidirectional-exec problem                |
| **Vercel Sandbox**              | Firecracker microVM                        | Active CPU + provisioned mem (wall-clock)                | $0.128/vCPU-hr (active only)         | $0.0212/GB-hr   | $20/mo Pro credit                                                   | **~$40–75**                       | GA, auto-snapshot/resume; Drives (beta, no expiry) | VCR (`vcr.vercel.com`), no ENTRYPOINT  | `iad1`-only; no stdin/PTY API; OIDC only if Vercel-hosted                                               |
| **Daytona**                     | Firecracker-class microVM                  | Wall-clock vCPU                                          | $0.0504/vCPU-hr                      | $0.0162/GiB-hr  | none; $200 one-time credit                                          | **~$66**                          | Declarative snapshots                              | Dockerfile-based                       | Fastest cold start (~90 ms, third-party benchmark); no monthly base = best steady-state value           |
| **E2B**                         | Firecracker microVM                        | Wall-clock + Pro base                                    | $0.0504/vCPU-hr                      | $0.0162/GiB-hr  | **$150/mo Pro** (Hobby free, 1 h session cap)                       | **~$216** (base-dominated)        | Pause/resume; 30-day pause TTL                     | `e2b template build` (Dockerfile)      | Cleanest SDK per multiple reviews; base fee makes it worst value at this scale                          |
| **Fly Machines / Sprites**      | Firecracker microVM                        | Per-second wall-clock                                    | ~$0.07/CPU-hr (Sprites, third-party) | ~$0.04375/GB-hr | none; $5 new-account trial credit (2026, down from prior free tier) | **~$126**                         | Volumes (persistent disks)                         | Docker image (native Fly deploy model) | DIY orchestration; best fit if DorkOS already wants general-purpose compute, not agent-specific tooling |
| **Modal Sandboxes**             | gVisor/microVM-class, function-oriented    | Wall-clock, sandbox tier priced above standard Functions | $0.1419/physical-core-hr (2 vCPU)    | $0.0242/GiB-hr  | $30/mo Starter or $250/mo Team credit-bearing plans                 | **~$95**                          | Volumes                                            | Python-first `Image` builder           | Weakest git-native workflow fit of the group; strongest for GPU/ML-adjacent sandboxed execution         |

Sources for the non-Vercel rows: [E2B Pricing](https://e2b.dev/pricing), [Daytona pricing](https://www.daytona.io/pricing), [Fly.io Resource Pricing](https://fly.io/docs/about/pricing/), [Fly.io Billing](https://fly.io/docs/about/billing/), Modal rate via Beam/Blaxel/Spheron secondary comparisons (Modal does not publish a dedicated Sandbox pricing page; treat as approximate) — see Research Gaps.

---

## Fit Analysis Against the WorkspaceProvider Seam

DorkOS's actual seam (`packages/shared/src/workspace.ts`, read in full for this report) is:

```ts
interface WorkspaceProvider {
  readonly type: WorkspaceProviderType; // 'worktree' | 'clone' today
  create(req: WorkspaceCreateRequest): Promise<ProviderResult>; // { path, branch }
  remove(workspace: Workspace, opts: { force: boolean }): Promise<void>;
  isDirty(workspace: Workspace): Promise<DirtyState>;
}
```

Binding is `session.cwd = workspace.path` — the whole integration claim of the shipped v1 spec (ADR 260616, `workspace-provider-hexagonal-port`, `server-is-the-port-authority`) is "no `AgentRuntime` changes; the provider hands back a path." Everything the seam needs maps like this:

- **create / attach**: breaks. No provider mechanics can synthesize a host-local `path` from a remote sandbox without one of two workarounds already identified in the 2026-07-17 report: (a) mount the remote FS locally (sshfs-style — high latency, fragile, defeats the purpose), or (b) run the agent **inside** the sandbox, which is an `AgentRuntime` concern, not a `WorkspaceProvider` concern.
- **exec**: the port doesn't define an exec verb at all today (`worktree`/`clone` assume the local FS provides everything past `create`). Vercel Sandbox's `runCommand`/`fs.*` would need a _new_ port method, not a fit into the existing one.
- **persist**: this is the one area meaningfully **improved** since 2026-07-17 — GA persistent sandboxes + beta Drives give Vercel Sandbox a coherent "keep this workspace around" story that used to be a metered, expiring liability. It still isn't free (snapshot storage $0.08/GB-month) or local (still off-machine), but it's no longer the sharpest objection.
- **port/dev-server access**: `sandbox.domain(port)` maps onto the `hostname`/`url` fields the `WorkspaceSchema` already reserves for v2 (currently always `null`) — this is a real, close fit _if_ DOR-91 ships first.
- **git identity/credentials**: still requires shipping git/SSH/API credentials into the sandbox for `create()`'s `git clone` and any later push — an unresolved trust-boundary cost independent of persistence improvements.
- **interactive/latency for the cockpit**: this is the fit dimension the earlier report under-weighted and this pass surfaces clearly — DorkOS's cockpit is built around a _live, bidirectional_ session (permission prompts routed to the UI, streamed turn events, the user able to steer or interrupt mid-turn). Vercel Sandbox's SDK exposes one-way log streaming and run-to-completion/detached commands, not a live process channel. Vercel's own reference pattern for agent workloads sidesteps this by running fully headless/auto-approved inside the sandbox — which is workable for unattended batch agents but is a materially different UX from DorkOS's interactive session model, and would require new protocol work (an approval-request/response channel over HTTP) to reproduce.

**Conclusion of the fit analysis**: the correct integration point, if DorkOS pursues this, is still a **`remote` `AgentRuntime`** under `services/runtimes/` (spawn the runtime inside the sandbox, treat the sandbox as the runtime's execution substrate, pass the `runtimeConformance` suite) — never the `WorkspaceProvider` port. Persistent sandboxes + Drives make that future runtime's _storage story_ meaningfully better than it looked four days ago; the _interactive-turn story_ is still unsolved and is the harder of the two problems.

---

## Recommendation

**PASS on Vercel Sandbox as a `WorkspaceProvider` — this is not a close call and both prior and current research agree.** The port's core contract (`create()` returns a local `path`; binding is `session.cwd = workspace.path`) cannot be satisfied by any remote sandbox without breaking the abstraction, and nothing in this pass's new research (Drives, GA persistence, VCR images, OIDC) changes that architectural fact.

**PILOT is defensible only for a narrowly scoped, different question: a `remote` `AgentRuntime` for unattended/headless agent execution — not for DorkOS's interactive cockpit sessions.** The single strongest reason to even consider a pilot: Vercel Sandbox's **active-CPU billing** genuinely fits a coding agent's real usage shape (mostly waiting on the model, not computing) better than every wall-clock-billed competitor, and **persistent sandboxes + Drives (now GA/beta)** finally give it a coherent "keep the workspace warm across runs" story that didn't exist in the earlier evaluation. If DorkOS ever ships a "run this while my laptop is closed" or "run this unattended overnight" capability, Vercel Sandbox is a credible, cheap-at-idle substrate for that _specific_ mode — headless, auto-approved, no live interactive UI required — which sidesteps the stdin/PTY gap entirely because there's no live turn to stream back.

**Do not pursue this for DOR-326's implied general case (agents in the cockpit, today).** The reasons, in order of weight: (1) the architectural seam mismatch is unconditional — it doesn't matter how good the pricing or persistence story gets if the port can't return a usable path; (2) the interactive/bidirectional exec gap is a second, independent blocker specific to DorkOS's cockpit UX that the 2026-07-17 report didn't fully weigh; (3) it remains strictly more expensive than $0 and a strictly worse privacy posture than "your own machine" for a product whose thesis is local-first.

**If a pilot is greenlit anyway** (e.g. to validate the "unattended overnight agent" product idea specifically), scope it to:

1. A spike implementing a **headless `remote` `AgentRuntime`** (not a `WorkspaceProvider`) that runs the Claude Agent SDK inside a persistent, named Vercel Sandbox in auto-approve mode, following Vercel's own reference guide.
2. Bind it to a **single, opt-in, explicitly-labeled "cloud" mode** — never the default — with a BYO `VERCEL_TOKEN` so DorkOS stays off the COGS hook and the credential-trust decision stays with the user.
3. Treat the interactive-approval gap as **out of scope for v1** of that pilot (headless-only), and revisit DOR-91 (`hostname`/`url`) so exposed dev-server URLs from `sandbox.domain()` can surface in the UI if/when this graduates past a spike.

## Research Gaps & Limitations

- **Modal's sandbox-specific pricing page does not exist publicly** — the $0.1419/core-hr figure is derived consistently across three third-party sources (Beam, Blaxel, Spheron/Northflank) from Modal's raw per-second sandbox rate, but is not independently confirmed against an official Modal pricing page for Sandboxes specifically. Treat within ±15%.
- **Fly Sprites/Machines per-CPU-hour rate ($0.07/CPU-hr) is carried forward from the 2026-07-17 report's third-party source (Northflank)**, not re-verified against an official Fly.io Sprites page this pass — Fly's own pricing docs describe named CPU/RAM presets rather than a flat per-core rate, so this figure is an approximation.
- **No first-party benchmark of actual repo-clone + `pnpm install` time inside a Vercel Sandbox for this specific monorepo** — the fit analysis's claim about custom-image maintenance burden is inferred from the documented VCR workflow, not measured.
- **Could not verify whether Vercel Sandbox's `Command` class has any undocumented interactive/stdin capability** — the full SDK reference was fetched and grepped for `stdin`/`write`/`interactive`/`websocket` with zero matches, but SDK reference pages don't always document every low-level primitive; this should be spiked directly against `@vercel/sandbox` before treating the "no bidirectional exec" finding as certain.
- **Drives' single-reader/single-writer constraint's practical impact on a multi-agent DorkOS workload was not tested** — it is stated as a beta limitation in Vercel's docs, not benchmarked.

## Contradictions & Disputes

- **Vercel's "ephemeral, no long-term data persistence" security framing vs. the GA default of persistent sandboxes + no-expiry Drives.** Vercel's concepts/security page still describes sandboxes as short-lived by design; its own persistence and Drives docs (both `last_updated: 2026-06-30`) describe a default and a beta feature built explicitly for long-lived, cross-session agent state. Both are accurate for different configurations, but the marketing framing lags the current default behavior — a DorkOS evaluator should model the _persistent_ default, not the _ephemeral_ pitch.
- **This report's finding on interactive/stdin support is a reading of documentation, not a live SDK test** — see Research Gaps above; it should be treated as a strong signal, not a confirmed fact, until spiked.

## Search Methodology

- Searches/fetches performed: 11 (3 WebSearch, 8 WebFetch against official Vercel docs + one KB guide).
- Most productive terms: "Vercel Sandbox Drives," "Vercel Sandbox OIDC authentication," "Vercel Container Registry vcr.vercel.com," direct fetches of `/docs/sandbox/pricing`, `/docs/sandbox/concepts/persistent-sandboxes`, `/docs/sandbox/concepts/drives`, `/docs/sandbox/concepts`, `/docs/sandbox/concepts/authentication`, `/docs/sandbox/concepts/images`, `/docs/sandbox/sdk-reference` (full JS SDK reference fetched and grepped), `/docs/sandbox/pricing`, and Vercel's Claude Agent SDK guide.
- Primary sources: vercel.com/docs (official, all `last_updated` between 2026-05-25 and 2026-07-07). Secondary: e2b.dev/pricing (official), daytona.io/pricing (official), fly.io/docs (official), plus third-party comparison posts (Northflank, Beam, Blaxel, Spheron) for Daytona/Modal/Fly cross-checks.
- Local sources: `packages/shared/src/workspace.ts` (read in full), `decisions/manifest.json` (ADRs 283/284, `workspace-provider-hexagonal-port` / `server-is-the-port-authority`), `research/20260717_cloud-sandbox-workspace-provider.md` (prior deep-dive, built on directly), `research/20260611_workspace_strategy_runtimes_symphony.md` (workspace architecture context).

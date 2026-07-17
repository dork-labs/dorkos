---
title: 'Cloud-Sandbox WorkspaceProvider — Is a Vercel Sandbox / E2B-style microVM provider worth adding beside worktree/clone?'
date: 2026-07-17
type: internal-architecture
status: active
tags:
  [
    workspace-manager,
    workspace-provider,
    cloud-sandbox,
    vercel-sandbox,
    e2b,
    daytona,
    fly-machines,
    firecracker,
    microvm,
    local-first,
    cost-model,
  ]
feature_slug: workspace-manager
searches_performed: 6
sources_count: 14
---

## Research Summary

Evaluating whether to add a cloud-sandbox `WorkspaceProvider` (Vercel Sandbox / E2B / Daytona / Fly Machines, Firecracker-microVM style) beside the shipped `worktree` and `clone` providers. The decisive finding is architectural, not economic: **the `WorkspaceProvider` port is the wrong seam for a remote sandbox** — it hands back a local filesystem `path` that becomes `session.cwd` for a runtime that executes on the DorkOS host, and a remote sandbox's filesystem is not on that host. Layered on top of that: real per-user cost ($40–$216/mo for the Kai scenario vs $0 for local worktrees), a local-first/privacy violation (source + credentials leave the machine), and an ongoing custom-image maintenance burden. **Recommendation: DEFER** (the v1 spec already deferred `container`/`remote` under DOR-87), with the future path being a **remote AgentRuntime, not a WorkspaceProvider**.

---

## Key Findings

1. **The `WorkspaceProvider` port assumes a local filesystem path — cloud sandboxes break that assumption at the seam.** The port's `create()` returns `ProviderResult { path, branch }`, and the WorkspaceManager binds a session by setting `session.cwd = workspace.path` (spec: "zero changes to `AgentRuntime` — binding is `session.cwd = workspace.path`"). The local runtime process (Claude Code SDK, Codex SDK, OpenCode sidecar) then opens files at that path **on the DorkOS host**. A Vercel/E2B sandbox's files live at `/vercel/sandbox` (or an E2B microVM) reachable only through the provider's SDK (`runCommand`, `writeFiles`, `readFiles`) — the host runtime cannot `cwd` into it. To make a cloud sandbox useful you must run the **agent itself inside the sandbox**, which is an `AgentRuntime` concern (a "remote runtime"), not a workspace-provisioning concern. This is the biggest impedance mismatch and it is structural.

2. **Cost is nonzero for a tool whose whole thesis is "$0, on your own machine."** For the Kai scenario (10 agents × 2 h/day × ~20 working days = **400 agent-hours/month**, 2 vCPU / 4 GB each), steady-state monthly compute lands at ~$40–$75 (Vercel Sandbox), ~$66 (Daytona), ~$126 (Fly Sprites), ~$216 (E2B, dominated by its $150/mo Pro base). Local worktrees cost **$0** marginal. These are _per-user_ figures — if DorkOS ran sandboxes on users' behalf it becomes a COGS line; if users BYO-key it becomes a signup-friction line. Either way it competes against free.

3. **Cloud sandboxes send source code and credentials off the machine — a local-first / privacy violation.** DorkOS's vision is agents on your own machine, data in `~/.dork`. A cloud sandbox requires the repo pushed to it and git/SSH/`.env`/API credentials shipped in so the agent can clone, install, and push. That is a hard **no for Lil** (privacy-first persona) and a **trust downgrade for Priya** (reads source before adopting). Vercel Sandbox is **`iad1`-only** (single US region), adding a data-residency problem for non-US users.

4. **Custom-image management is a standing maintenance tax, not a one-time setup.** Each provider carries its own image/template format (E2B: Dockerfile → `e2b template build`; Vercel: `node22`/`node24` base + snapshots that expire 30 days after last use; Daytona: declarative snapshots). The image must track the local toolchain (Node, pnpm, the three runtime CLIs, and native builds like `better-sqlite3` that the repo already finds finicky across environments). Drift produces "works locally, breaks in the sandbox."

5. **Cold start is a non-issue for 2-hour agents; file-sync latency is the real tax.** Firecracker cold boot is ~125–200 ms (~5–30 ms from a snapshot); Daytona benchmarks ~90 ms, E2B ~150 ms — all negligible against a multi-hour session. The catch is per-provider: **Vercel Sandbox reports successful creation _before_ the microVM finishes booting, so the first `runCommand` absorbs up to ~33 s of hidden boot** (third-party `sandbox-benchmarking`); Vercel's own snapshot work brought restore p75 under 1 s / p95 to ~5 s. The durable cost is moving the repo in and changes out on the local↔cloud boundary, which the `WorkspaceProvider` port does not model at all.

6. **The genuine value cloud sandboxes add is narrow and partly already covered.** Real wins over local worktrees: (a) running _untrusted_ agent-generated code isolated from your machine; (b) parallelism beyond one laptop; (c) ephemeral public preview URLs via `sandbox.domain(port)` / `getHost(port)`. But Kai's 10 agents fit a modern laptop; the runtimes already ship their own in-place sandboxing (Codex `sandbox-exec`/landlock); and DorkOS's server-based cockpit already gives a self-host-on-a-VPS remote story without a third party.

---

## Detailed Analysis

### The seam being fitted (what a provider must implement today)

`packages/shared/src/workspace.ts` defines a deliberately thin hexagonal port:

```ts
interface WorkspaceProvider {
  readonly type: 'worktree' | 'clone'; // would extend to 'sandbox' | 'remote'
  create(req: WorkspaceCreateRequest): Promise<ProviderResult>; // { path, branch }
  remove(ws: Workspace, opts: { force }): Promise<void>;
  isDirty(ws: Workspace): Promise<DirtyState>; // uncommitted/untracked/unpushed
}
```

Both shipped providers (`worktree.ts`, `clone.ts`) are ~40 lines of local git plumbing: `git worktree add` / `git clone` at `req.path`, `validateBoundary(req.path, root)` to keep the checkout under the workspace root, `computeDirtyState()` via local `git status --porcelain` + `rev-list --count HEAD --not --remotes`, and `rm -rf` on removal. Four things in the surrounding WorkspaceManager are hard-wired to _local path_ semantics:

- **`ProviderResult.path` → `session.cwd`.** The entire integration claim of the v1 spec is "no `AgentRuntime` changes — binding is `session.cwd = workspace.path`." A remote path defeats this.
- **`validateBoundary(path, root)`** canonicalizes a local path under `<dorkHome>/workspaces`. A remote sandbox path has no local-root relationship; the invariant is meaningless off-host.
- **Port allocation** hands out _localhost_ TCP blocks (`DORKOS_PORT`/`VITE_PORT`/`SITE_PORT` from `portBase`, default 4250) injected via the workspace `.env`. A sandbox's ports live inside the microVM and surface as a _URL_ (`sandbox.domain(3000)`), not `localhost:4251`. The whole `WorkspacePorts` model doesn't map; you'd instead populate the reserved `hostname`/`url` fields (DOR-91, v2 naming layer, currently always `null`).
- **`isDirty()`** shells `git` in a local `cwd`. For a sandbox it must run `git` _inside_ the sandbox via `runCommand` and parse remote stdout — doable, but it's a shim, and it presumes the repo's git remote/creds are reachable from the sandbox.

The port also has **no file-access verbs** (`readFile`/`writeFile`/`exec`). It returns a path and assumes the local FS provides the rest. So even the _shape_ of the port offers no seam for the remote file operations a cloud sandbox is built around.

### Why "remote runtime" is the correct abstraction, not "cloud workspace provider"

The clone/worktree providers _materialize a local checkout that a local runtime reads_. A cloud sandbox is _a remote execution environment_. Bolting it onto `WorkspaceProvider` forces one of two bad shapes:

- **(a) Mount the remote FS locally** (sshfs / network FS) so `session.cwd` resolves — high latency on every file op, fragile, and it defeats the point of remote execution.
- **(b) Run the agent runtime inside the sandbox** — correct, but that is an `AgentRuntime` implementation (spawn Claude Code/Codex/OpenCode in the microVM, stream turns back over the SDK), not a provisioning port. It would live under `services/runtimes/`, pass the `runtimeConformance` suite, and treat the sandbox as its execution substrate.

Conclusion: if DorkOS ever wants cloud execution, the entry point is a **`remote`/`sandbox` AgentRuntime**, with Daytona/Vercel Sandbox/E2B as the substrate — the `WorkspaceProvider` port is the wrong door.

### Cost model (Kai scenario: 400 agent-hours/month, 2 vCPU / 4 GB)

Assumptions (stated so they can be argued with): 10 agents × 2 h/day × 20 working days = 400 wall-clock agent-hours; 2 vCPU + 4 GB per sandbox; a coding agent is **I/O-bound waiting on the model**, so I estimate ~15% _active_ CPU (this only matters for Vercel, which bills active CPU; everyone else bills provisioned vCPU wall-clock). Rates checked 2026-07-17.

| Provider           | CPU rate                           | Mem rate                    | Billing model                 | **Est. monthly (Kai)** | Notes                                                                                                                       |
| ------------------ | ---------------------------------- | --------------------------- | ----------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Local worktree** | —                                  | —                           | —                             | **$0**                 | baseline; instant; on-machine; native git                                                                                   |
| **Vercel Sandbox** | $0.128/vCPU-hr (active only)       | $0.0212/GB-hr (provisioned) | active CPU + wall-clock mem   | **~$40–75**            | CPU ≈ $15 (0.128×2×400×0.15) + mem $33.92; + $0.15/GB transfer (npm/git, variable); − $20/mo Pro credit; `iad1`-only        |
| **Daytona**        | $0.0504/vCPU-hr                    | $0.0162/GiB-hr              | wall-clock vCPU               | **~$66**               | CPU $40.32 + mem $25.92; **no monthly base**; $200 one-time credit (~3 mo free at this volume); fastest cold start (~90 ms) |
| **Fly Sprites**    | $0.07/CPU-hr                       | $0.04375/GB-hr              | wall-clock                    | **~$126**              | CPU $56 + mem $70; $200 credit; Fly Machines (DIY orchestration) can undercut this                                          |
| **Modal**          | $0.1419/physical-core-hr (=2 vCPU) | $0.0242/GiB-hr              | wall-clock                    | **~$95**               | CPU $56.76 + mem $38.72; function-oriented, weak git-workflow fit                                                           |
| **E2B**            | $0.0504/vCPU-hr                    | $0.0162/GiB-hr              | wall-clock + **$150/mo base** | **~$216**              | compute ≈ $66 + **$150 Pro base**; Hobby is free but caps sessions at 1 h (too short for 2 h agents); cleanest SDK          |

Key economic reads:

- **Vercel's active-CPU model is the natural fit for idle-heavy coding agents** — you don't pay vCPU while the agent waits on Claude — but memory is still billed for the full wall-clock, and the hidden first-command boot + `iad1`-only + transfer fees erode the win.
- **Daytona is the best microVM value at steady state** (no base fee, fastest cold start).
- **E2B's $150/mo base dominates** at this scale — it's built for higher-concurrency fleets, not one operator's 10 agents.
- All of these are **> $0**, which is the number local worktrees charge, on hardware the user already owns.

### Local-first / privacy / security posture

- **Secrets leave the machine.** A cloud sandbox needs git push/pull credentials (or SSH keys), `.env` API keys, and MCP configs to do real work. Each provider becomes a new trust boundary. This directly contradicts the local-first vision and is a **hard blocker for Lil** and a **material trust cost for Priya**.
- **Data residency.** Vercel Sandbox is single-region `iad1`. E2B/Daytona offer BYOC/self-host on higher tiers, which reintroduces the ops burden the sandbox was meant to remove.
- **Traffic/isolation.** E2B routes all inbound sandbox traffic through its proxy with an access token (good), but that proxy is also the exfiltration path for whatever creds you injected.
- **Persistence has an expiry cliff local worktrees don't.** E2B pause ≈ 4 s/GB RAM, resume ≈ 1 s, **deleted after 30 days paused**; Vercel snapshots **expire 30 days after last use**. A local worktree just sits on disk indefinitely. "Keep this workspace around for three weeks" is free locally and a metered, expiring liability in the cloud.

### API mapping onto the port (what fits, what shims, what breaks)

| Port concern          | Vercel Sandbox                                                                         | E2B                                       | Verdict                                                        |
| --------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------- |
| `create()`            | `Sandbox.create()` / `getOrCreate()` + `runCommand('git', ['clone', …])` in `onCreate` | `Sandbox.create(template)` + `runCommand` | **Shim** — returns a sandbox handle, not a local `path`        |
| `ProviderResult.path` | `/vercel/sandbox` (remote)                                                             | remote FS root                            | **Breaks** — not host-reachable for `session.cwd`              |
| ports/dev servers     | `sandbox.domain(port)` (≤15 ports) → URL                                               | `getHost(port)` → URL                     | **Breaks localhost model**; would need DOR-91 `hostname`/`url` |
| `isDirty()`           | `runCommand('git','status --porcelain')` inside sandbox, parse stdout                  | same                                      | **Shim** — feasible but off-host                               |
| `remove()`            | `sandbox.stop()` / lifecycle                                                           | `kill`/pause                              | **Fits** cleanly                                               |
| file access           | `writeFiles`/`readFiles`/`mkDir` (SDK only)                                            | filesystem SDK                            | **No port seam exists** for this                               |

The only clean fit is teardown. Everything load-bearing (path → cwd, ports, git) needs impedance matching or breaks outright.

---

## Sources & Evidence

- Vercel Sandbox pricing/limits (official, checked 2026-07-17): $0.128/vCPU-hr active CPU, $0.0212/GB-hr provisioned memory, $0.60/1M creations, $0.15/GB transfer, $0.08/GB-month snapshots, 24 h max runtime (Pro), 2,000 concurrent (Pro), `iad1`-only, $20/mo Pro credit — [Vercel Sandbox pricing and limits](https://vercel.com/docs/sandbox/pricing)
- Vercel Sandbox SDK surface (`getOrCreate`, `runCommand`, `writeFiles`/`mkDir`, `sandbox.domain(port)`, ≤15 ports) — [JS SDK Reference](https://vercel.com/docs/sandbox/sdk-reference), [Understanding Sandboxes](https://vercel.com/docs/sandbox/concepts)
- Vercel Sandbox hidden-boot penalty: "reports successful creation before the Firecracker microVM has finished booting… first command absorbs… up to 33 seconds" (third-party benchmark) — [sandbox-benchmarking explainer](https://repo-explainer.com/vercel-labs/sandbox-benchmarking); Vercel's own snapshot optimization (p75 restore <1 s, p95 ~5 s) — [Optimizing Vercel Sandbox snapshots](https://vercel.com/blog/optimizing-vercel-sandbox-snapshots)
- E2B pricing (official page, checked 2026-07-17): $150/mo Pro base; $0.000014/vCPU/s (= $0.0504/vCPU-hr), $0.0000045/GiB/s (= $0.0162/GiB-hr); Hobby free + one-time $100 credit, 1 h sessions / 20 concurrent; Pro 24 h sessions / 100 concurrent — [E2B Pricing](https://e2b.dev/pricing)
- E2B SDK (persistence: pause ≈ 4 s/GB, resume ≈ 1 s, 30-day pause TTL; `getHost(port)`; proxy + access-token for inbound) — [E2B persistence docs](https://e2b.dev/docs/sandbox/persistence), [E2B SDK reference](https://e2b.dev/docs/sdk-reference/js-sdk/v2.0.1/sandbox)
- Cross-provider rate table (Daytona $0.0504/vCPU-hr + $0.0162/GiB-hr, Fly Sprites $0.07/CPU-hr + $0.04375/GB-hr, Modal $0.1419/physical-core-hr + $0.0242/GiB-hr) — **secondary/third-party, treat as approximate** — [Northflank: AI Sandbox pricing comparison (2026)](https://northflank.com/blog/ai-sandbox-pricing)
- Cold-start benchmarks (Firecracker 125–200 ms cold / 5–30 ms snapshot; Daytona ~90 ms; E2B ~150 ms) — **secondary** — [Spheron: E2B/Daytona/Firecracker guide](https://www.spheron.network/blog/ai-agent-code-execution-sandbox-e2b-daytona-firecracker/), [Particula: Modal vs E2B vs Daytona vs Vercel Sandbox](https://particula.tech/blog/modal-vs-e2b-vs-daytona-vs-vercel-sandbox-ai-code-execution)
- Fly Machines pricing / per-second billing / scale-to-zero cold start (a few seconds) — [Fly.io Resource Pricing](https://fly.io/docs/about/pricing/)
- Daytona usage-based pricing + $200 credit — [Daytona pricing](https://www.daytona.io/pricing)
- Prior DorkOS research on the workspace architecture and its deferrals — `research/20260611_workspace_strategy_runtimes_symphony.md`; the v1 spec that defers `container`/`remote` — `specs/workspace-manager/02-specification.md` (§Non-Goals, DOR-87)

## Research Gaps & Limitations

- **Daytona / Fly Sprites / Modal per-vCPU rates are from a third-party comparison table (Northflank), not each vendor's official pricing page** — treat within ±20%. Vercel and E2B figures are from official docs and are higher-confidence.
- The 15%-active-CPU estimate for a coding agent is my assumption, not measured; it swings the Vercel number materially (at 40% active, Vercel CPU ≈ $41 and total pushes toward ~$90). The _relative ordering_ is robust regardless.
- Did not benchmark real repo clone + `pnpm install` file-sync time inside any sandbox for this codebase; the "file-sync is the real tax" claim is inferred from the SDK model, not timed.
- Vercel Sandbox's persistent-sandbox / snapshot workflow may reduce per-workspace cold-start and transfer if a warm base snapshot is maintained — not cost-modeled here.

## Contradictions & Disputes

- **Vendor "milliseconds" cold-start claims vs the observed Vercel first-command penalty.** Vercel markets sub-second starts; the independent `sandbox-benchmarking` repo shows the _create_ call returns early and the _first command_ eats up to ~33 s of boot. Both are true — they measure different events. For a coding agent this is a one-time per-sandbox cost, negligible against a 2 h session, but it disqualifies Vercel Sandbox for latency-sensitive short tasks.
- **E2B "cheap per-second" vs "$150/mo base."** Comparison blogs quote E2B's per-second rate (cheap) without foregrounding the Pro base fee that a 2 h-session workload requires; at the Kai scale the base fee is 70% of the bill.

## Recommendation

**DEFER** (consistent with the v1 spec, which already parks `container`/`remote` under DOR-87). Do **not** add a cloud-sandbox `WorkspaceProvider`.

Three-sentence rationale: The `WorkspaceProvider` port hands back a local filesystem `path` that becomes `session.cwd` for a runtime running on the DorkOS host, and a remote sandbox's files are not on that host — so a cloud sandbox is architecturally a _remote AgentRuntime_ concern, not a workspace-provisioning one, and forcing it through this port breaks the core `session.cwd = workspace.path` binding. Economically it trades local worktrees' $0/instant/on-machine baseline for $40–$216/month per user plus a custom-image maintenance tax, while sending source code and credentials off the machine — a direct hit to the local-first thesis and a hard blocker for the privacy-first persona. The genuine value (untrusted-code isolation, beyond-laptop parallelism, public preview URLs) is narrow, partly already covered by runtime-native sandboxing and the self-hostable server, and not something Kai's 10-agent workload needs.

**Conditions that would flip this to ADOPT (feeding DOR-326):**

1. A concrete product decision to offer **hosted execution** (agents that run while the laptop is closed / a cloud tier) — at which point build it as a **`remote` AgentRuntime under `services/runtimes/`**, with Daytona (best value, fastest cold start) or Vercel Sandbox (best idle-CPU economics) as the substrate, **not** as a `WorkspaceProvider`.
2. A validated need to run **untrusted agent-generated code** at a scale or risk level that exceeds one machine's isolation — the one value cloud sandboxes uniquely provide.
3. **BYO-key billing** to keep DorkOS off the COGS hook, plus a resolved credential/secrets story (scoped, ephemeral tokens; explicit user consent) that a source-reading persona would accept.

If any of those land, the first implementation step is a spike on a **remote runtime** binding the sandbox SDK's `runCommand`/file APIs to the `AgentRuntime` conformance suite — and revisiting DOR-91 (`hostname`/`url`) so exposed dev-server URLs replace the localhost port-block model.

## Search Methodology

- Searches performed: 6 (Vercel Sandbox pricing/SDK/cold-start, E2B pricing/SDK, Fly/Daytona pricing).
- Most productive terms: "Vercel Sandbox pricing limits," "E2B pricing per-second Firecracker cold start," "Vercel Sandbox cold start boot time," provider SDK surfaces.
- Primary sources: vercel.com/docs (official), e2b.dev/pricing (official); secondary: Northflank/Spheron/Particula comparison blogs, `sandbox-benchmarking` explainer.
- Local sources: `packages/shared/src/workspace.ts`, `apps/server/src/services/workspace/providers/{worktree,clone,git}.ts`, `specs/workspace-manager/02-specification.md`, `research/20260611_workspace_strategy_runtimes_symphony.md`.

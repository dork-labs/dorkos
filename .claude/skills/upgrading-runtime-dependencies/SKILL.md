---
name: upgrading-runtime-dependencies
description: Guides strategic analysis of agent runtime dependency upgrades — changelog categorization, codebase impact assessment, and feature adoption decisions. Use when upgrading SDK-level dependencies that sit behind an abstraction boundary.
user-invocable: false
---

# Upgrading Runtime Dependencies

This skill teaches the judgment calls needed when upgrading dependencies that power agent runtimes. Unlike routine dependency bumps, runtime SDK upgrades require understanding what new capabilities to adopt, not just what breaks.

## Core Principle

Runtime dependencies sit behind abstraction boundaries (e.g., the `AgentRuntime` interface). Changes to the SDK affect a confined set of files, but the _implications_ ripple outward through the features those files enable. Your job is to trace both the direct code impact and the strategic value.

## Changelog Categorization

### Ambiguous Entries

Changelog entries are often vague. Use these heuristics:

| Entry Pattern                | Likely Category     | Why                                     |
| ---------------------------- | ------------------- | --------------------------------------- |
| "refactored X internals"     | `internal`          | Unless X is a public API you call       |
| "improved X performance"     | `performance`       | But check if our usage pattern benefits |
| "updated X types"            | Could be `breaking` | Type changes can break compilation      |
| "X now accepts Y"            | `feature`           | Additive API change                     |
| "X no longer does Y"         | `breaking`          | Subtractive behavior change             |
| "deprecated X in favor of Y" | `deprecated`        | Even if X still works                   |
| "fixed X when Y"             | `fix`               | Check if we hit condition Y             |

### Version Significance

Not all versions deserve equal attention:

- **Major bumps** (0.x → 1.0, 1.x → 2.0): Read every entry. These are intentional breaking points.
- **Minor bumps with many changes**: Skim for features and deprecations. These accumulate API surface.
- **Patch bumps**: Only scan for fixes that match known issues or workarounds in our code.
- **Pre-1.0 minors** (0.2 → 0.3): Treat like majors. SemVer allows breaking changes before 1.0.

### Cross-Referencing Sources

When multiple sources exist (GitHub releases, CHANGELOG.md, npm metadata):

1. **GitHub releases** are authoritative for intent — maintainers write these for humans
2. **CHANGELOG.md** is authoritative for completeness — often auto-generated from commits
3. **npm metadata** is authoritative for version timeline — `time` field shows exact publish dates
4. If sources conflict, prefer GitHub releases for categorization, CHANGELOG.md for exhaustiveness

## Impact Assessment Judgment

### Mapping SDK Changes to the Abstraction Boundary

For the Claude Agent SDK specifically, the `AgentRuntime` interface is the abstraction boundary (enforced by ADR-0089 via ESLint). Know the mapping:

| SDK Surface                                         | DorkOS Module                               | Impact Scope                       |
| --------------------------------------------------- | ------------------------------------------- | ---------------------------------- |
| `query()` function signature                        | `message-sender.ts`                         | Core messaging pipeline            |
| `SDKMessage` types                                  | `sdk-event-mapper.ts`                       | Event streaming                    |
| `Options` type                                      | `message-sender.ts`, `plugin-activation.ts` | Session configuration              |
| Session management (`renameSession`, `forkSession`) | `claude-code-runtime.ts`                    | Session lifecycle                  |
| MCP server config types                             | `context-builder.ts`                        | Tool/context injection             |
| Permission modes                                    | `message-sender.ts`                         | Security boundary (ADR-0240)       |
| Plugin system (`options.plugins`)                   | `plugin-activation.ts`                      | Marketplace integration (ADR-0239) |
| Error types/categories                              | `sdk-event-mapper.ts`                       | Error handling (ADR-0143)          |
| CLI path resolution                                 | `sdk-utils.ts`                              | Dependency checking                |
| Model/subagent metadata                             | `runtime-cache.ts`                          | Cached metadata                    |
| Slash command discovery                             | `command-registry.ts`                       | Command system                     |

### Assessing Feature Relevance

Ask these questions for each new SDK feature:

1. **Does this touch something we already wrap?** If yes → high relevance (we're already invested)
2. **Does this enable a requested DorkOS feature?** Check specs, Linear issues → high relevance
3. **Does this improve reliability/performance of current usage?** → medium relevance
4. **Does this add a capability we haven't considered?** → medium relevance (evaluate the opportunity)
5. **Does this serve a use case we explicitly don't support?** → low/none relevance

### Effort Estimation

Be honest about effort. A "trivial" SDK API change can have non-trivial implications:

| Change Type                         | Seems Like | Actually Is                                                     |
| ----------------------------------- | ---------- | --------------------------------------------------------------- |
| New optional parameter on `query()` | Trivial    | Trivial — just pass it through                                  |
| New required parameter on `query()` | Moderate   | Could be significant if it needs user-facing config             |
| New event type in `SDKMessage`      | Trivial    | Moderate — needs mapper entry, may need UI support              |
| Changed error category taxonomy     | Moderate   | Significant — touches error handling, may need UI updates       |
| New `Options` field                 | Trivial    | Depends — if it needs per-session config, touches session store |
| Removed/renamed export              | Breaking   | Usually moderate — confined by ESLint boundary                  |

### ADR Conflict Detection

Before recommending an adoption approach, verify it doesn't violate existing ADRs:

- **ADR-0089** (SDK Import Confinement, now Hard Rule #2 per runtime): every runtime SDK's imports must stay inside its own adapter directory: `@anthropic-ai/claude-agent-sdk` → `services/runtimes/claude-code/`, `@openai/codex-sdk` → `services/runtimes/codex/`, `@opencode-ai/sdk` → `services/runtimes/opencode/`. If a new feature needs to surface data outside that boundary, it must go through the `AgentRuntime` interface.
- **ADR-0239** (Plugin Activation): Plugin runtime integration uses `options.plugins`. If the SDK changes how plugins work, the activation pipeline needs updating.
- **ADR-0240** (Permission Passthrough): Permission modes pass through to the SDK. Changes to SDK permission handling need careful review.
- **ADR-0143** (Retry over Circuit Breaker): We use retry depth, not circuit breakers. SDK error handling changes must fit this model.

## Spec Generation Guidelines

### When to Create a Separate Spec

Create a separate spec (not included in the upgrade spec) when a feature:

- Requires **new UI** (user-facing changes beyond the runtime boundary)
- Requires **new API routes** or **new service methods**
- Requires **schema changes** (config, database)
- Has **its own test surface** (not just updating existing tests)
- Would take **more than ~2 hours** to implement
- Has **dependencies beyond the SDK upgrade** (e.g., needs a new MCP tool)

### When to Include in the Upgrade Spec

Include in the main upgrade spec when a change is:

- A **direct API migration** (old call → new call, same behavior)
- A **type update** (new field in an existing type)
- A **configuration passthrough** (new option that maps directly)
- **Test-only** (updating test mocks/scenarios for new SDK behavior)
- Completable in **under 30 minutes**

### Upgrade Spec Quality

A good upgrade spec:

1. **Links to research**: Always reference the changelog and impact assessment documents
2. **Separates "must" from "should" from "nice to have"**: Breaking changes are non-negotiable; deprecation migrations are recommended; trivial feature adoptions are optional
3. **Orders tasks by dependency**: Version bump first, then breaking change fixes, then deprecation migrations, then feature adoptions
4. **Includes rollback criteria**: Under what conditions should we revert?
5. **Notes ADR implications**: If the upgrade requires an ADR update, call it out explicitly

## The Three Production Runtime SDKs

The Claude Agent SDK table above is the worked example; the same discipline applies to all three runtime SDKs, each with its own upgrade personality:

| SDK                              | Adapter                | What makes its upgrades different                                                                                                                                                                  |
| -------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@anthropic-ai/claude-agent-sdk` | `runtimes/claude-code` | Richest surface (see table above); native-binary packaging changed at 0.2.113, so path resolution is version-sensitive                                                                             |
| `@openai/codex-sdk`              | `runtimes/codex`       | Versions track the Codex CLI train; active `alpha` dist-tag; event-mapper `never` exhaustiveness checks are the intended tripwire for new `ThreadEvent`/`ThreadItem` members (ADR-0309)            |
| `@opencode-ai/sdk`               | `runtimes/opencode`    | Client-only SDK that version-couples with the separately-shipped `opencode-ai` sidecar binary (ADR-0308); server-side release notes can matter more than client type changes; ignore snapshot tags |

Two gates are universal regardless of SDK:

- **The conformance suite**: every runtime must pass `runtimeConformance` (`@dorkos/test-utils`) after a bump: run the adapter's suite (`pnpm vitest run apps/server/src/services/runtimes/<runtime>`) before calling any upgrade validated.
- **The bump checklist**: `contributing/adding-a-runtime.md` (section: Bumping a pinned SDK) is the canonical validation sequence; the config's per-package `upgrade_notes` point to it and add package-specific judgment.

The same principles generalize to any future runtime dependency behind an abstraction boundary:

1. **Identify the boundary**: What interface or module confines this dependency?
2. **Map the surface**: Which files import from this dependency?
3. **Categorize changes**: Breaking, deprecated, feature, fix, internal
4. **Assess through the boundary**: How do changes inside the boundary affect code outside it?
5. **Separate upgrade from adoption**: Bumping the version is one spec; adopting new features may be others

The `.claude/config/runtime-deps.json` file maps each runtime dependency to its boundary, codebase root, changelog sources, SDK surface map, related ADRs, and upgrade notes. Consult it before starting analysis, and keep it true when the integration surface changes.

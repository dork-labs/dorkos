---
id: 260725-152018
title: The agent-facing config snapshot is an allowlist, not a denylist
status: accepted
created: 2026-07-25
spec: agents-as-operators
superseded-by: null
---

# 260725-152018. The agent-facing config snapshot is an allowlist, not a denylist

## Status

Accepted. Supersedes ADR 260723-013236, which chose the denylist mechanism this replaces.

## Context

ADR 260723-013236 made `config_get` and `config_patch`'s echo return `configManager.getAll()` minus every dot-path in `SENSITIVE_CONFIG_KEYS`, and claimed the result was "drift-proof against new sensitive keys" because the list was iterated rather than hand-copied. That reasoning was wrong in one direction: iterating the denylist means a newly listed key is redacted everywhere at once, but a newly added config field is **disclosed** the moment it exists and nothing says so. The list is only drift-proof against changes to itself.

Review found the consequences already shipped. `config_get` carries `readOnlyCarveOut: true`, so on the default login-off posture it answers on the external `/mcp` endpoint with no credential at all, and the four denied paths did not cover:

- `providers` — the per-provider credential **reference** map (ADR-0315). A `file:` reference is an absolute path to a plaintext key; `env:` names the variable; `keychain:` names the entry. A reference is not a secret, but it tells an unauthenticated caller exactly where to go next, which is the same escalation.
- `runtimes.codex.credentialRef` — the same class.
- `cloud.linkedAccountLabel` — the DorkOS account this install is linked to, often a person's email.

None of those ride the hand-curated `GET /api/config`. The same failure mode had already fired once: `mcp.apiKey` reached this surface before it joined `SENSITIVE_CONFIG_KEYS`. A denylist over a Zod schema that grows every release is the defect, not the symptom.

## Decision

The snapshot an untrusted caller reads is built from an **explicit per-field classification of the whole schema**, not by subtraction.

`CONFIG_DISCLOSURE` (`apps/server/src/services/core/operator/config-disclosure.ts`) marks every leaf of `UserConfigSchema` `expose` or `withhold`, and `projectDisclosedConfig()` produces its output by copying only the `expose` paths. An unclassified field is therefore absent by construction, and anything the stored file carries that the schema does not describe (`conf`'s internal migration bookkeeping, a hand-edited stray key) is dropped for free.

Two classes are withheld and nothing else: **secrets and the references that locate them** (the four `SENSITIVE_CONFIG_KEYS`, plus `providers` and `runtimes.codex.credentialRef`), and **linked-account identity** (`cloud.linkedAccountLabel`). Withheld credentials are replaced by a boolean `<leaf>Configured` sibling, and `providers` by `providersConfigured` (the provider ids), so an agent can still see what is wired up without learning where the material lives.

Absolute paths stay exposed deliberately. They are how the operator surface addresses work (`update_agent` targets an agent by `cwd`, and an agent that cannot read its boundary cannot tell what it may touch), and withholding them buys no confidentiality: the only posture where `config_get` answers tokenlessly is login-off, where the equally tokenless `GET /api/config` already reports `workingDirectory`, `boundary`, `dorkHome`, and `mesh.scanRoots`. The line held is "nothing that is a credential or points at one", not "no paths".

The classification is enforced, not documented. A drift guard (`__tests__/config-disclosure.test.ts`) derives the leaf set from the live schema via `z.toJSONSchema(UserConfigSchema)` and compares it against the table in **both** directions, so adding, renaming, or removing a config field fails until its author records a verdict. `apps/server/vitest.config.ts` aliases `@dorkos/shared/config-schema` (that one subpath, scoped deliberately) to the package source, because the `exports` map points at `dist/` and a stale dist would turn that guard into a silent pass.

The content-level choice from ADR 260723-013236 is retained: redaction lives inside the handler rather than de-listing `config_get` from the carve-out, because token holders and the model context should not see credential material either.

## Consequences

### Positive

- A new config field cannot reach the tokenless surface unclassified. The guard fails first, which is the property ADR 260723-013236 claimed but did not have.
- Credential references, not just credential values, are treated as sensitive.
- The projection is an allowlist, so keys outside the schema entirely can never leak through it.

### Negative

- Every config-field author now owes a verdict. `contributing/configuration.md` and the `adding-config-fields` skill carry the step, and the guard is the backstop.
- The snapshot is no longer shape-identical to `config.json`: it gains `…Configured` booleans and `providersConfigured`, and omits withheld keys. It is an informational view, not something to round-trip back through `config_patch`.
- The classification walker treats any JSON-Schema node without a `properties` map as a leaf, so a field nested below one is covered only by its ancestor's verdict. Two exposed leaves are open records (`ui.shapes.agentDefaults` and `workbench.defaultViewers`, classified at `config-disclosure.ts:105` and `:171`), but their value types are constrained to a plain string and a viewer enum, so nothing sensitive can be stored under them today. The sharper gap is arrays: a field added to the object inside `ui.sidebar.groups[]` is invisible to the walker no matter what `additionalProperties` says, so the guard stays green and the projection copies it. Recursing the walker into `items` and union branches is the fix if that shape ever needs to carry anything sensitive.
- The authenticated HTTP `GET`/`PATCH /api/config` still echo the raw config to the cockpit (pre-existing, deliberate); the asymmetry must be remembered when touching those routes.

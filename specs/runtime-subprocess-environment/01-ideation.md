---
id: 260908-151633
slug: runtime-subprocess-environment
created: 2026-09-08
status: draft
issue: DOR-1904
parent: white-label-connections
---

# Runtime environment protection — ideation addendum

Tracker: [DOR-1904](https://linear.app/dorkspace/issue/DOR-1904/filter-server-secrets-from-runtime-subprocess-environments), UUID00475767-6272-45ef-bf3a-3baa47911fe7. Parent specification: [white-label-connections](../white-label-connections/02-specification.md).

Status: design only; root freeze and independent review required before implementation. This adds a bounded security follow-up to the existing Connections programme; it does not reopen completed phases or claim an OS sandbox.

## Intent and evidence

Prevent local server-only credentials from being copied into agent runtime processes. The independent source review pinned to 03f68928 confirmed that Codex and OpenCode inherit all parent variables. Its synthetic exact-module proof copied NANGO_ENCRYPTION_KEY and MCP_API_KEY even without Connections tools. Nango documentation explicitly requires its encryption key in the local server environment. No real environment or hosted Vercel credentials were inspected.

Claude shares the problem: launch-resolver.ts spreads the parent environment, warmCommands does too, and RuntimeCache.warmup omits env. Installed Claude Agent SDK0.3.224 and Codex SDK0.147.0 both replace a supplied environment and inherit all when absent. Read-only installed source hashes/snippets are preserved in .dork/flow/runtime-env-design/installed-sdk-evidence.json; no new dependency is proposed.

## Existing facilities and decisions

Reuse services/core/credential-env.ts for selected model credential references; it resolves values at spawn and does not store new plaintext. Reuse shared config schema/defaults, semver-keyed ConfigManager migration, operator config write policy and config disclosure policy. There is no existing shared deliberate runtime environment projection or custom inherited-name list in the inspected source. Existing MCP server env/header maps are per-server settings, not a parent-environment policy.

Root approved: explicit OS/CLI baseline, runtime/provider-specific required authentication, and owner-configured exact-name custom inheritance. Unknown parent variables are withheld by default; reserved server-only names cannot be re-enabled through that custom list. Do not grandfather the old ambient environment during migration. Preserve supported login/home, Git/SSH, proxy/TLS and runtime-config behavior with concrete positive tests.

Rejected: only removing names containing KEY/TOKEN (breaks selected model credentials and misses differently named secrets); a server-secret denylist with unknown inheritance (retains arbitrary secret exposure); filtering only Connections-enabled turns (warm-up and no-extraEnv bypass); clearing process.env temporarily (cross-session races); pretending environment filtering isolates hostile same-user shell code.

## Compatibility and remaining review decisions

This changes implicit inheritance intentionally. Unknown build variables and unknown provider authentication modes require owner opt-in by exact name. Keep values in the existing parent environment or credential store, not in a new config field. Existing runtime-local credential/config files remain runtime-owned; filtering does not stop those files from injecting their own environment or credentials.

The specification selects concrete defaults and names-only configuration for peer review. Root must freeze the exact baseline and reserved-name catalog, especially dual-use Git credentials and third-party model modes. Implementation must reject undocumented expansions rather than silently turn the policy into a wildcard. No new UI or provider permission is proposed.

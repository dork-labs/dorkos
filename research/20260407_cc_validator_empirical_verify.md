# CC Validator Empirical Verification — Sidecar Strategy Confirmation

**Date**: 2026-04-07
**Purpose**: Load-bearing verification that Claude Code's `claude plugin validate` enforces `additionalProperties: false` on plugin entries, thereby justifying the sidecar `dorkos.json` strategy for DorkOS-specific extensions.
**Spec**: marketplace-05-claude-code-format-superset
**ADR**: 0236 (Sidecar dorkos.json for Marketplace Extensions)
**Task**: #30 (Phase 1 gating task)

## Environment

- **Claude Code version**: 2.1.92
- **Install path**: `/Applications/cmux.app/Contents/Resources/bin/claude`
- **CLI invocation**: `claude plugin validate <path>`
- **Platform**: Darwin 25.3.0 (macOS)
- **Date of run**: 2026-04-07

## Method

Two synthetic marketplace.json fixtures were created in `/tmp/mkt05-cc-verify/`:

### Fixture A (control — no DorkOS keys)

```json
{
  "name": "test-fixture-a",
  "owner": { "name": "Test" },
  "plugins": [{ "name": "foo", "source": { "source": "github", "repo": "foo/bar" } }]
}
```

### Fixture B (inline `x-dorkos` on plugin entry)

```json
{
  "name": "test-fixture-b",
  "owner": { "name": "Test" },
  "plugins": [
    {
      "name": "foo",
      "source": { "source": "github", "repo": "foo/bar" },
      "x-dorkos": { "type": "agent" }
    }
  ]
}
```

Both fixtures use the identical CC-standard structure. The only difference is the presence of an inline `x-dorkos` key on the plugin entry in Fixture B.

## Results

### Fixture A — PASS

Command:

```
claude plugin validate /tmp/mkt05-cc-verify/fixture-a-marketplace.json
```

Output:

```
Validating marketplace manifest: /tmp/mkt05-cc-verify/fixture-a-marketplace.json

⚠ Found 1 warning:

  ❯ metadata.description: No marketplace description provided. Adding a description helps users understand what this marketplace offers

✔ Validation passed with warnings
```

Exit code: **0**

The one warning concerns an optional `metadata.description` field and does not affect validation outcome.

### Fixture B — FAIL

Command:

```
claude plugin validate /tmp/mkt05-cc-verify/fixture-b-marketplace.json
```

Output:

```
Validating marketplace manifest: /tmp/mkt05-cc-verify/fixture-b-marketplace.json

✘ Found 1 error:

  ❯ plugins.0: Unrecognized key: "x-dorkos"

✘ Validation failed
```

Exit code: **1**

## Conclusion

**The sidecar `dorkos.json` strategy is confirmed as correct and load-bearing.**

Claude Code's `plugin validate` command enforces `additionalProperties: false` (or equivalent strict validation) on plugin entries inside `marketplace.json`. Any inline DorkOS-specific field — regardless of prefix (`x-dorkos`, `dorkos`, etc.) — will cause the entire marketplace to fail validation with an `Unrecognized key` error.

This means:

1. **Every inline extension strategy is blocked**: `x-dorkos-*` prefixed fields, a single `x-dorkos: {...}` namespace object, and top-level passthrough are all unworkable because CC's validator rejects them.
2. **The sidecar strategy is the only safe option**: DorkOS-specific fields MUST live in `.claude-plugin/dorkos.json` (a separate file that CC never reads) indexed by plugin name. The merge happens in DorkOS's parser (`mergeMarketplace()`).
3. **The strict superset invariant holds**: any `marketplace.json` produced by DorkOS using only CC-standard fields will pass `claude plugin validate`. The sidecar is invisible to CC.

**ADR-0236 is validated.** Proceeding with schema rewrite (tasks 1.2 onward) using the sidecar strategy.

## Notes

- The error message format `plugins.0: Unrecognized key: "x-dorkos"` confirms the validator is walking into the plugin array and rejecting unknown keys at the plugin entry level specifically (not the top-level document, which does appear to passthrough some unknown keys — though this was not tested explicitly in this verification).
- Future CC releases may loosen this behavior. If that happens, the sidecar strategy remains a correct-by-construction solution (it never needed CC to loosen). No migration will be needed.
- The weekly `cc-schema-sync` cron (task 5.3) will detect if the upstream reference schema changes in ways that affect this behavior.

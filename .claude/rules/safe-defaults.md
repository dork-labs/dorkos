---
paths: packages/shared/src/config-schema.ts, packages/shared/src/*-schemas.ts, apps/server/src/services/core/config-manager.ts, apps/server/src/services/core/safe-defaults/**/*.ts, packages/marketplace/src/manifest-schema.ts, packages/skills/src/task-schema.ts
---

# User-Safe Defaults

You are editing a file that decides what happens to someone who never touches a setting. **Every
default, fallback, and reset state lands on the option that protects them.** ADR 260727-181825.

## The four rules

1. **Absence is not consent.** A missing, `null`, or `undefined` value resolves to the option that
   withholds, denies, or bounds. `?? true` and `!== false` are the two spellings of the bug —
   fine where the value gates nothing, never where it decides whether data leaves the machine,
   whether an agent gains capability, or whether a bound is enforced.
2. **Losing state must not lose a protection.** A wipe may lose preferences. Recovery re-applies
   decisions and protective values on top of fresh defaults, and never a value more permissive than
   a fresh install carries.
3. **A decision is carried whole or not at all.** Never restore "the user decided" without what
   they decided. A channel they were never asked about takes the protective value, not the schema
   default.
4. **A permissive default is legal, but it must be argued.** Add it to `PERMISSIVE_DEFAULTS` with a
   concrete reason.

## What this means concretely

Adding a field to `UserConfigSchema` means doing all three of these, or the build goes red:

- Classify it in `apps/server/src/services/core/safe-defaults/default-verdicts.ts` — `no-risk`,
  `safe`, or `permissive` (with a reason). The drift guard fails on an unclassified leaf.
- Classify it in `operator/config-disclosure.ts` and `operator/config-write-policy.ts`, which have
  their own guards.
- If the default is permissive **and** a person could move it to a protective value, add a rule to
  `PROTECTIVE_CARRYOVERS` in `safe-defaults/protected-state.ts` so a config wipe cannot reverse
  their choice.

A migration goes under a **new key strictly greater than the newest `v*` tag**, and never onto a key
that has already MERGED — `conf` runs a key only in `(storedVersion, projectVersion]`, so a body
added to a key somebody already ran never runs for them again. "Somebody" includes anyone on a
built CLI or the desktop app before the tag exists, which is why an untagged key is closed too
(DOR-1222). Enforced by two guards in `apps/server/src/services/core/__tests__/`:
`migration-safety.ts` (against the newest tag) and `migration-append-only.ts` with
`merged-migration-hashes.ts` (against a pinned hash, which a new key must add). See
`contributing/configuration.md`.

## Testing

A config-schema change needs a **real `ConfigManager`** test over a real file, not `createMockStore`.
Mock stores never cross the `conf`/Ajv seam, and `UserConfigSchema.parse` cannot substitute: Zod
strips unknown keys where Ajv rejects them. See `safe-defaults/__tests__/protected-state.test.ts`
for the pattern (write an Ajv-invalid file, boot a real manager, assert what survived).

**A migration's outcome is read off `config.json`, never off `get`/`getDot`.** conf's `store` getter
re-reads and re-parses the file on every access and validates the copy it is about to hand back, so
Ajv's `useDefaults` fills any missing key into that copy and the copy is then discarded. A `getDot`
assertion therefore passes with the migration body deleted — which is how a whole upgrade-boot suite
and two further cases certified migrations they never exercised (DOR-1496). The one exception is a
whole TOP-LEVEL section: conf merges `defaults` under the file and WRITES the result before its
first migration key, so that section lands on disk either way and no test at this seam can attribute
it to the body — write that down rather than implying otherwise.

## Anti-patterns

```typescript
// BAD: absence enables an outbound channel
const consent = config?.usage ?? true;

// BAD: a decision restored without what was decided — opens the gate onto defaults
store.set('telemetry', { ...defaults, userHasDecided: prior.userHasDecided });

// BAD: recovery that starts from defaults and keeps nothing
catch { fs.unlinkSync(configPath); this.store = new Conf(opts); }
```

```typescript
// GOOD: absence withholds
const consent = config?.usage ?? false;

// GOOD: the decision travels whole, or not at all
const decision = salvageTelemetryDecision(stored); // undefined unless userHasDecided === true

// GOOD: recovery salvages protections before replacing the file
const stored = readStoredConfigForSalvage(configPath);
/* … replace … */
restoreProtectedState(this.store, stored, 'Recovered a damaged config');
```

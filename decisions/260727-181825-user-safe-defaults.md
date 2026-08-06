---
id: 260727-181825
title: Defaults, fallbacks and recovery land on the option that protects the user
status: accepted
created: 2026-07-27
amends: 0135
spec: null
superseded-by: null
---

# 260727-181825. Defaults, fallbacks and recovery land on the option that protects the user

## Status

Accepted. Constrains, and does not reverse,
[260713-143958](260713-143958-two-plane-two-tier-data-collection-strategy.md) — see
_Relationship to the Tier 1 opt-out model_ below.

## Context

A config wipe was observed reverting an explicit telemetry opt-out:
`telemetry.userHasDecided` went `true` → `false` while `install` and `heartbeat` went `false` →
`true`. The person had answered "no"; the recovery replaced their answer with "never asked, and
the answer is yes".

The existing design was more careful than that summary suggests, which is what makes the failure
instructive. Tier 1 channels default ON but are held by a notice-before-first-send gate
(`hasTier1SendGate`), and the `applyTier1OptOutDefaults` migration explicitly preserves an
existing `userHasDecided === true` in either direction. Neither helped. **The protection was
`userHasDecided`, and a wipe is exactly the event that destroys it** — after which the fallback
state is the permissive one and the gate reads a fresh file as a fresh install.

That is a general shape, not one bug:

- A default is written once and then inherited by everyone who never touches it. Most people never
  touch it.
- A fallback runs precisely when something has already gone wrong, which is the worst moment to
  widen access.
- Absence and consent are different facts. `?? true`, `!== false`, and "no value, so allow" all
  quietly equate them.

An audit across the server, shared schemas, and relay packages found the same shape in places with
no connection to telemetry: a Slack adapter whose missing `dmPolicy` accepts direct messages from
any workspace member, task frontmatter whose missing `permissions:` runs a scheduled agent with
edits auto-accepted, and a `canUseTool` gate that prompts on a match and allows on everything else.

## Decision

**Every default, every fallback, and every reset or recovery state lands on the option that
protects the person: privacy-preserving, least-permission, least-surprise. Absence is never read as
consent.**

Four rules follow, in the order they bind.

### 1. Absence is not consent

A missing, `null`, or `undefined` value must resolve to the option that withholds, denies, or
bounds. `x ?? true` and `x !== false` are the two spellings of the bug; both are legal where the
value gates nothing, and neither is legal where it decides whether data leaves the machine, whether
capability is granted, or whether a bound is enforced.

### 2. Losing state must not lose a protection

A wipe may lose preferences. It must never lose a protection. A recovery path re-applies, on top of
fresh defaults, both the decisions a person made and any value they had moved to the protective
side — never a value more permissive than a fresh install would carry. Salvaged values are
re-validated field by field, because the source is a file that just failed validation.

Implemented in `apps/server/src/services/core/safe-defaults/protected-state.ts`, shared by the
`ConfigManager` recovery branch and `reset()`. Resetting a single named section stays literal:
naming it is the explicit act that a blanket reset lacks.

### 3. A decision is carried whole or not at all

Consent state is a record with parts that only mean anything together. Carrying "the user decided"
without carrying what they decided is worse than carrying nothing — it opens a gate onto default
values. A partial decision is discarded; a channel a person was never asked about takes the
protective value, not the schema default, because an answer is only ever as wide as the question.

### 4. A permissive default is legal, but it must be argued and it must be enforceable

Some defaults are permissive on purpose. The requirement is not that they disappear, but that no
one can add one silently. `safe-defaults/default-verdicts.ts` classifies every leaf of
`UserConfigSchema` as `no-risk`, `safe`, or `permissive`; a `permissive` verdict carries a written
reason, and the drift guard fails the build on an unclassified leaf, a duplicate, a stale path, or
a missing argument. The mechanism mirrors `CONFIG_DISCLOSURE`, which inverted the same question for
disclosure after a secret-bearing field reached an unauthenticated surface merely by being added.

The three-way split is deliberate. A binary safe/permissive registry would force a security verdict
onto ~70 preference leaves, and a registry where every entry is a security judgement is one that
gets rubber-stamped. `no-risk` is the honest home for a preference, which keeps the eleven
`permissive` entries readable.

## Relationship to 260713-143958

This ADR does **not** reverse the Tier 1 opt-out model. That decision — anonymous aggregate
telemetry collects by default, matching the Next.js/VS Code/Homebrew norm, defended by real
anonymisation and a notice-before-first-send gate — stands, and its channels are recorded here as
`permissive` with their argument written out.

What changes is that the model must now hold under failure as well as under upgrade. 260713-143958
already required that "an explicit prior 'no' is never overridden", and honoured it on the upgrade
path. It did not hold on the wipe path, because nothing owned that path. Rules 2 and 3 close it.

The two decisions are therefore complementary: 260713-143958 chooses where the default sits; this
one governs what happens to a person who moved off it.

## Consequences

### Positive

- The reported defect cannot recur, and the same class of defect in `reset()` is closed with it.
- Adding a config field now requires stating what its default does for the person who never touches
  it, at the moment it is added rather than at the next audit.
- The permissive defaults we keep are visible in one file with their reasoning, which is a better
  answer to a source-reading architect than a claim in a docs page.
- The audit trail is reusable: the same four rules read cleanly against the relay, task, and
  runtime findings that this change does not fix.

### Negative

- Two more registries to keep current, one of which (`default-verdicts.ts`) touches every config
  field addition. The cost is one line per field and a red build when it is skipped.
- The carryover list is a judgement call and will drift from reality if nobody revisits it. The
  guard checks that every listed path exists and that no rule protects a preference; it cannot
  check that a newly permissive default was added to it. That gap is real and is the reason the
  Tier 1 cross-check assertion exists.
- A person who deliberately wants a factory reset of their privacy settings must now name the
  section (`dorkos config reset telemetry`) rather than resetting everything. That is a small
  surprise in exchange for the larger one it prevents.
- Classifying a leaf `no-risk` is a claim that can age badly: a preference that later starts
  triggering network calls keeps its old verdict silently.

## References

- Constrains: [260713-143958](260713-143958-two-plane-two-tier-data-collection-strategy.md);
  related: [260711-141639](260711-141639-opt-in-observability-consent.md) (consent namespace),
  [260711-153307](260711-153307-opt-in-error-reporting.md) (error scrubbing).
- Precedent for the enforcement shape: `apps/server/src/services/core/operator/config-disclosure.ts`
  (`CONFIG_DISCLOSURE`) and `config-write-policy.ts` (`CONFIG_WRITE_POLICY`).
- Rule: `.claude/rules/safe-defaults.md`. Guide: `contributing/configuration.md`.
- Tracker: DOR-584 (config recovery). Related open items: DOR-510, DOR-511, DOR-512, DOR-514,
  DOR-466, DOR-474.

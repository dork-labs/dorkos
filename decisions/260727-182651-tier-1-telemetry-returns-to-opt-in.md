---
id: 260727-182651
title: Tier 1 telemetry returns to opt-in
status: accepted
created: 2026-07-27
spec: null
superseded-by: null
---

# 260727-182651. Tier 1 telemetry returns to opt-in

## Status

Accepted. Supersedes the Tier 1 posture of
[260713-143958](260713-143958-two-plane-two-tier-data-collection-strategy.md); applies
[260727-181825](260727-181825-user-safe-defaults.md).

**Scope of the supersession is narrow and deliberate.** Only the "Plane 1, Tier 1 — anonymous,
opt-out, global" section of 260713-143958 is reversed. Everything else in that ADR stands
unchanged: the two-plane split, the Tier 2 opt-in rules, the anonymisation bar, the site's hybrid
cookieless posture, the owned ingest and shared event registry, and all of Plane 2.

## Context

260713-143958 made the anonymous aggregate channels — `install`, `heartbeat`, and later `usage` —
collect by default, defended by four things: genuine anonymisation, a notice before the first send,
`DO_NOT_TRACK` support, and the industry norm (Next.js, VS Code, Homebrew, .NET, Astro). That
reasoning was sound and remains sound on its own terms.

Two things have changed since.

First, a defect showed what "opt-out plus a decision flag" costs under failure. A config wipe
returned `telemetry.userHasDecided` to `false` and the channels to `true`, converting an explicit
refusal into "never asked, and the answer is yes". The wipe path is now fixed (DOR-584), but the
episode makes the underlying asymmetry visible: **when the default is ON, every bug in the consent
machinery fails towards collecting.** The protective state is the one held in a single mutable
flag, and that flag is what breaks.

Second, ADR 260727-181825 states the rule the product is now held to: defaults land on the option
that protects the person, and absence is never read as consent. An opt-out channel is, definitionally,
absence read as consent. Keeping it would have made the very first exception to a rule written the
same day one we had to argue our way around.

There is also a positioning cost that the original ADR named itself, under Negative: _"'Private by
default' softens to 'anonymous by default' for Tier 1 — a real brand nuance that Priya-type users
will scrutinize."_ For a product whose differentiator is that it runs on the operator's own machine
and whose target persona reads source before adopting, that nuance is expensive in a way that a
funnel number does not offset.

## Decision

**`telemetry.install`, `telemetry.heartbeat` and `telemetry.usage` default to `false`.** DorkOS
sends nothing to dorkos.ai until a person says it may.

- The notice-before-first-send gate (`hasTier1SendGate`) stays. It is now a second gate rather than
  the only one.
- `DO_NOT_TRACK` / `DORKOS_TELEMETRY_DISABLED` and `dorkos telemetry enable|disable` are unchanged.
- The consent surfaces are unchanged and become the primary path in: the first-run notice, the
  onboarding step, and the Privacy & Data settings tab.
- A migration (`applyTier1OptInDefaults`, composed into the `0.57.0` key) turns the three channels
  off for every install that never answered a prompt, including installs the 0.48.0 opt-out flip
  enrolled by silence and installs whose notice has since been shown. **An explicit choice, in
  either direction, is never touched** — someone who chose to keep sharing keeps sharing.
- Nobody is re-prompted by the migration; `lastPromptedVersion` is left alone.

## Consequences

### Positive

- The privacy claim is simple and true without a footnote: nothing leaves the machine unless you
  say so. That is the claim the persona this product targets actually checks.
- No consent-machinery bug can fail towards collecting. With the default off, the failure mode of
  every gate, migration, and recovery path is silence.
- Consistent with 260727-181825 rather than standing as its first exception.
- The Tier 1 / Tier 2 split collapses to one rule for anything that leaves the machine, which is
  less to explain on `/telemetry` and less to get wrong in code.

### Negative

- **This is the real cost: we lose the adoption signal the original decision was written to get**,
  at the pre-launch moment it was wanted most. Expect opt-in rates in the 5–15% band typical of
  opt-in telemetry, against near-100% coverage under opt-out — so instance counts, install funnels,
  and usage trends become directionally useful at best, and are no longer a basis for ranking
  marketplace packages by real install volume.
- The marketplace install channel feeds public install counts and package ranking (ADR-0234/0235).
  Those numbers get sparser and more biased towards people who opt in, which is a product-quality
  regression, not only an analytics one.
- Installs currently sending anonymous data, having never been asked, stop sending it. That is the
  intent, and it is also a one-time step down in every metric that will look like a regression on a
  chart.
- A copy sweep is required in lockstep, and until it lands the docs are wrong in the direction that
  matters least (claiming we collect more than we do) but are still wrong: `/telemetry`,
  `/privacy`, `/marketplace/privacy`, `docs/self-hosting/telemetry.mdx`, the onboarding step, and
  the README.
- We give up the "matches the industry norm" defence. That was a genuine argument, and reasonable
  people will think this is the wrong trade for a pre-launch product.
- **An install already at `0.57.0` keeps sending.** `conf` runs a migration only when
  `key > storedVersion`, so an install that has already recorded `0.57.0` and later upgrades to
  `0.58.0` never runs `applyTier1OptInDefaults` and keeps `install`/`heartbeat`/`usage` at `true`.
  The window is narrow — `0.57.0` is unreleased as of this ADR, so only pre-release builds are
  affected — but it is real, and it is the price of composing into an existing key rather than
  opening one that would not run at all.
- **A dev tree runs no migrations.** `SERVER_VERSION` resolves to `0.0.0` in a checkout, so no
  migration key is ever greater than the stored version and DorkOS developers keep sending on
  configs written before this change. Tracked as DOR-585. Contributors who want it off now should
  set `DO_NOT_TRACK=1` or answer the prompt.

## Alternatives considered

- **Keep opt-out, rely on the DOR-584 fix.** The wipe path is genuinely fixed, so this is defensible.
  Rejected because it leaves the asymmetry: the protective state stays the fragile one, and the next
  consent bug fails towards collecting again.
- **Opt-out for `heartbeat` only, opt-in for the rest.** Keeps a coarse instance count at lower
  brand cost. Rejected as the worst of both — still absence-as-consent, still needs the footnote, and
  a partial rule is harder to state honestly than either whole one.
- **Prompt harder instead** (a blocking first-run choice rather than a notice). Compatible with this
  decision and worth doing on its own merits; it raises opt-in rates without reintroducing
  collection by silence. Not bundled here.

## References

- Supersedes (Tier 1 posture only):
  [260713-143958](260713-143958-two-plane-two-tier-data-collection-strategy.md).
- Applies: [260727-181825](260727-181825-user-safe-defaults.md).
- Related: [260711-141639](260711-141639-opt-in-observability-consent.md) — the original opt-in
  posture this returns to; ADR-0234/0235 (Neon marketplace telemetry, affected by sparser counts).
- Migration: `applyTier1OptInDefaults` in `apps/server/src/services/core/config-manager.ts`,
  composed into the `0.57.0` key.

---
id: 261122-133041
title: Telemetry defaults follow the build channel, and each turn is captured once for three outputs
status: proposed
created: 2026-11-22
spec: null
superseded-by: null
amends: [260711-141639, 260713-143958, 260727-181825, 260727-182651]
---

# 261122-133041. Telemetry defaults follow the build channel, and each turn is captured once for three outputs

## Status

Proposed (DOR-4997). Records Dorian's decisions of November 17 and November 21. Security reviews this record before it becomes accepted, and before any code that changes a default lands.

It amends four accepted ADRs, which stay accepted:

- [260727-182651](260727-182651-tier-1-telemetry-returns-to-opt-in.md): "`telemetry.install`, `telemetry.heartbeat` and `telemetry.usage` default to `false`" now holds for source builds only. Its rule that an explicit choice is never touched still stands, everywhere.
- [260727-181825](260727-181825-user-safe-defaults.md): rule 1, "absence is not consent", no longer decides whether `install`, `heartbeat`, `usage` and the account link send on a stamped official build outside the gated regions. There, a shown notice or card stands in for an answer. Rules 2, 3 and 4 still bind, and rule 1 still binds every other value.
- [260713-143958](260713-143958-two-plane-two-tier-data-collection-strategy.md): the Tier 2 clause that `identify()` needs its own opt-in is replaced for installs linked to a DorkOS account. Its Tier 2 rule for AI-run metadata is unchanged. The two planes, the anonymisation bar, the owned ingest and the event registry still stand.
- [260711-141639](260711-141639-opt-in-observability-consent.md): "Off by default, always" now holds everywhere except official release builds. The one consent namespace, the public payloads and the no-PII tests still stand.

## Context

Telemetry has been off by default everywhere since July. DorkOS now cannot answer basic questions: how many people used it this week, whether they got to a first agent reply, which runtimes they use. Today only a handful of installs send anything. The people who install an official DorkOS release are not the same as the people who build it from source. The second group reads code before adopting it, and forks and dev trees would fill the numbers with noise. Separately, the app is about to need per-agent token usage in its own screens, and that must work with telemetry off. PostHog hosting is in the US, with spend caps to be set.

## Decision

### What is on by default, and where

On by default in official release builds: `install`, `heartbeat`, `usage` and the account link. Opt-in everywhere, as today: `errorReporting` and `aiMetadata` (crash reports and AI summaries, the per-turn event included; PM confirmed, Nov 22).

| Build                                                                               | Default | Before the first send, outside the gated regions                |
| ----------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------- |
| Mac and Windows apps (official release)                                             | On      | The first-run card has rendered once (PM confirmed, Nov 22)     |
| npm CLI (`npx dorkos`, `dorkos start`), Homebrew                                    | On      | A terminal notice is printed; sending starts on the next start  |
| Official Docker image                                                               | On      | The same notice in the container log; sending starts next start |
| Any image that runs `npm i -g dorkos` and does not set `DORKOS_DISTRIBUTION=docker` | On      | As npm (decided in this ADR)                                    |
| Source builds, local packs, local images, local desktop packages, forks             | Off     | Nothing sends, and nothing is set up                            |

A headless `dorkos start` never needs the web UI: outside the gated regions the terminal notice is enough. The card still shows when someone opens the app. Homebrew counting as npm: PM confirmed, Nov 22. Third-party images that install the npm package can't be told apart from npm, so they count as npm, although the plan listed unofficial images as off; that row is decided in this ADR. A DorkOS hosted on DorkOS Cloud is out of scope here.

- **Region.** In the EU, EEA, UK and Switzerland the card is a real choice: two equal buttons. The choice shows when either signal from the server or from the viewing browser (locale or time zone) points at a gated region, or when either is unknown (`UTC`, `Etc/*`, `C`, `POSIX`). Never from an IP lookup. Unknown getting the choice: PM confirmed, Nov 22. A server that needs the choice sends nothing until a button is pressed or `dorkos telemetry enable` is run; a headless server decides from its own signals. If a headless server is already sending and is later opened from a browser whose signals need the choice, sending pauses until a button is pressed.
- **Account link.** An install linked to a DorkOS account sends a one-time alias joining its random install id to the account's random id, never an email or name. There is no second switch to turn it on, and the card says so; `telemetry.linkAnalyticsToAccount` folds into the card. A stored `linkAnalyticsToAccount: false` counts as an explicit "no": linking stays off, and the new card shows that row unchecked. We can't tell an old default from a deliberate "no", and silently flipping a privacy opt-out costs more trust than it gains. With no stored value, linking follows `usage`. After the new card, its answer counts from then on. For installs already linked, DOR-4999 sends the one-time alias after the new card, only if linking is on by these rules. Unlinking does not undo the join: events from this install still land on the joined record until "forget this install" (later work in this project's account milestone) ships.
- **Anonymous until linked.** An install with no account link creates no person profile. That holds once DOR-4989 lands, and no default turns on before it does.
- **Off in one step.** `dorkos telemetry disable`, the Privacy & Data tab, or the card's button. `DO_NOT_TRACK=1` and `DORKOS_TELEMETRY_DISABLED=1` turn off everything sent to DorkOS, on every build, over any config or default. They do not touch the local ledger or an operator's own OpenTelemetry exporter.
- **An explicit choice is never overridden** by a default change, a migration, an upgrade or an account link.
- **No content, ever.** Telemetry never carries prompts, replies, code, file paths, URLs, repo names, chat or room text, agent or room names, tool inputs or outputs, environment variables or connected-app data. The ingest reads an IP to count requests and never keeps it. The event registry enforces this with closed Zod schemas on the sender and the ingest. Feedback a person chooses to send is separate.
- **Self-hosters** can turn the default off for an image they ship, or send to their own sink (DOR-5000).

### How the build channel is known

The default is on only when two facts agree: an official-release stamp, and the install kind from `apps/server/src/lib/distribution/` (`DORKOS_DISTRIBUTION`, plus the rule that a server running from TypeScript source is `dev`). Agree means the stamp's channel equals the install kind.

- Each official release workflow writes its own stamp: the npm publish writes an npm stamp, `desktop-release.yml` a desktop stamp, and `.github/workflows/publish-docker.yml` a Docker stamp.
- For a `docker` install kind only the Docker stamp counts. The official image is itself an `INSTALL_MODE=npm` build (the `Dockerfile` then sets `DORKOS_DISTRIBUTION=docker`), so it carries the npm stamp too; that stamp is ignored there.
- The Docker stamp is added by `publish-docker.yml`, never by a default in the `Dockerfile`, so a local `docker build` in any `INSTALL_MODE` stays off. It goes on the `runtime` image only; the `hub` image stays off until a Cloud decision.
- No stamp exists in anything built by `pnpm build`, `npm pack`, the repo's pack scripts, a local `docker build`, or a local desktop package (electron-builder run outside `desktop-release.yml`).
- A `homebrew` install kind agrees with the npm stamp, because the formula installs the published npm package.
- `dev`, `unknown`, no stamp, or a mismatch means off. `DORKOS_DISTRIBUTION` alone never turns telemetry on.
- A deliberate fork that copies the stamp cannot be stopped. The stamp stops accidents, not intent.

The schema defaults stay `false`, each with a `safe` verdict in `safe-defaults/default-verdicts.ts`. The channel-aware default is computed in one place, the consent helpers in `packages/shared/src/telemetry-consent.ts`. DOR-4999 adds it there, with a test across channel, region and prior answer, and decides the stamp's exact form.

### Upgrades

The send gate opens only after the card or notice for this decision has been shown, recorded under its own version marker. An install that saw the old "nothing sends" notice sees the new card or notice first, with the choice in a gated region, before anything sends. `resolveTier1ChannelConsent` and `effectiveTier1Telemetry` change to match: on a stamped build outside the gated regions, the new marker replaces the `userHasDecided === true` requirement. Everywhere else that requirement stays.

### Capture once, three outputs

Each agent turn is captured once. One end-of-turn hook at the session event normalizer (`apps/server/src/services/session/session-event-normalizer.ts`, where `turn_end` is made for every runtime) builds one usage record. It must read usage before the normalizer drops raw usage notices. Today's per-turn capture in `services/observability/ai-metadata.ts` and `trace-runtime.ts` moves onto this hook. Three writers read the record:

1. **The local usage ledger**, in DorkOS's own database. Always on, names included. Never sent to PostHog or our ingest; a team rollup is a separate decision (DOR-5015).
2. **PostHog**, as the nameless `agent_turn_completed` event. It is AI-run metadata, so it sends only when `aiMetadata` is on (DOR-5004). It replaces the `$ai_generation` event `ai-metadata.ts` sends today, so a turn is never two events. It goes through dorkos.ai's own ingest, which alone holds the PostHog key. No app surface embeds a vendor SDK.
3. **OpenTelemetry** `gen_ai.*` spans, to the operator's own exporter when one is set (DOR-5006). Never to our ingest.

The in-app usage view reads only the local ledger, never PostHog. It has to work offline, self-hosted and with telemetry off, it needs names, and it needs every turn. The dashboard (DOR-5016) and retention with "clear usage history" (DOR-5017) build on this hook; nothing here fixes their schema.

### Gates

No release turns a default on until all of these hold:

- DOR-4990 and DOR-4994 have merged. No default flip ships before both.
- DOR-4989 has merged.
- DOR-4998 (the docs rewrite) has merged.
- Security has reviewed this ADR, before any code that changes a default lands.

Separately, the local ledger (DOR-5015) ships only together with its retention (DOR-5017).

## Consequences

### Positive

- DorkOS can count weekly use and installs again, from the builds real people install.
- The source-reading persona keeps what it checks: a checkout sends nothing, and the registry shows exactly what a release build sends.
- Any doubt about the build lands on off: no stamp, a mismatch, or an unknown kind.
- One capture point means the in-app numbers, PostHog and a self-hoster's traces agree, and a new runtime is covered by reaching the normalizer.
- The in-app usage view works for everyone, including people who turn telemetry off.

### Negative

- "Nothing leaves unless you say so" is no longer true outside the gated regions. Every page that says it must change before the flip, and some readers will think this is the wrong trade.
- A notice in a container log is easy to miss.
- Most containers report `UTC` or `C`, so most official Docker installs will get the choice and send nothing until someone presses a button or runs `dorkos telemetry enable`.
- Locale and time zone are a rough guess at region, so some people outside the gated regions get the choice too. That costs signal, not trust.
- A release workflow that forgets its stamp ships a build that sends nothing, and nobody notices without a check.
- Turn data in PostHog stays opt-in, so per-runtime numbers stay thin.
- The local ledger keeps agent and chat names on disk for months, so it needs retention and a clear action before it ships.
- A joined account record outlives unlinking until "forget this install" exists.

## Alternatives considered

- **Opt-in everywhere (today).** The safest claim, and it stays the rule for source builds. Rejected for release builds: it left a handful of installs reporting, which is no signal.
- **One global rule: on with an informing card everywhere.** More signal and simpler. Rejected by Dorian: in the gated regions a real choice is the cleaner position.
- **On everywhere, source builds included.** The most data. Rejected: forks, CI and dev trees would swamp the numbers, contributors would send without a clear moment to be told, and it breaks trust with the people most likely to read the code.
- **A PostHog SDK in the client.** Less server code. Rejected: it ships a key, puts a vendor's code in every surface, is blocked by ad blockers, cannot be pointed elsewhere by a self-hoster, and moves the content check out of the one place we enforce it.
- **A separate switch for the account link.** Rejected by Dorian: "may be linked to the account" was the decision.

## References

- Amends: [260711-141639](260711-141639-opt-in-observability-consent.md), [260713-143958](260713-143958-two-plane-two-tier-data-collection-strategy.md), [260727-181825](260727-181825-user-safe-defaults.md) (rule 1), [260727-182651](260727-182651-tier-1-telemetry-returns-to-opt-in.md). Related: [260711-154514](260711-154514-otel-spans-local-debug-trace.md), [260828-002117](260828-002117-telemetry-routes-read-the-client-ip-to-count-it-never-to-keep-it.md).
- Code: `packages/shared/src/telemetry-consent.ts`, `apps/server/src/lib/distribution/`, `apps/server/src/services/core/auth/link-telemetry.ts`, `apps/server/src/services/observability/ai-metadata.ts`, `scripts/outbound-census/`, `apps/server/src/services/core/safe-defaults/default-verdicts.ts`, `Dockerfile`, `.github/workflows/publish-docker.yml`.
- Tracker: DOR-4997 (this ADR), DOR-4998 (docs), DOR-4999 (stamp, default and card), DOR-5000 (self-hoster sink), DOR-5004 and DOR-5006 (turn event and spans), DOR-5015, DOR-5016 and DOR-5017 (in-app usage), DOR-4989, DOR-4990 and DOR-4994 (gates).

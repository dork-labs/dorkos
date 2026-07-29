# User Profile + Onboarding — Specification

**Id:** 260729-084310 · **Status:** specified · **Depends on:** shipped Tier 1 conversation (`specs/dorkbot-is-the-onboarding/`, ADR 260722-111314) · **Coordinates with:** `specs/connector-completion/` (Connections page — referenced, never specced here)

## Summary

DorkOS learns who the user is — role(s), tools, optionally a name — stores it locally in a new `profile` block of `~/.dork/config.json`, and uses it twice: (a) a short factual `<user_profile>` block is projected into every session's agent context on every runtime, so agents know who they work for; (b) a pure role → recommendations mapping in `@dorkos/shared` lets onboarding and the Connections page suggest fitting connector services and marketplace searches. The question is asked BY DorkBot, in the scripted conversation, as one new beat between personality and discovery. Existing users get one dismissible, non-modal, DorkBot-voiced sidebar prompt. The profile is local-only and structurally excluded from every telemetry payload.

## The role beat (onboarding)

`BEAT_ORDER` becomes `['arrival', 'personality', 'profile', 'discovery', 'handoff']` — one new beat, placed after personality (the "how should I sound" → "what will we do together" escalation reads as one getting-to-know-you arc) and before the machine-facing discovery consent. Composer stays disabled until handoff, unchanged.

DorkBot's lines (authored in `DORKBOT_ONBOARDING_LINES`, plain language, no em dashes in spoken lines):

> Now I know how to sound. Here's one for you: what kind of work will we be doing together?
>
> Your answer stays on this machine. It's for me and your other agents, so we know who we work for. Nobody else sees it.

The privacy fact is the second line of the same beat — said in the same breath, per the framing rule. It is a statement of the system's actual behavior (see §Privacy invariant), not marketing.

**Widget** (`widget: 'profile'`): an inline multi-select chip row of the canonical roles (labels below) plus a "Something else" free-text input (adds a free-form role on Enter), a primary chip **"That's us"** (enabled once ≥1 role is selected or typed), and a ghost chip **"Skip this"**. No sliders, no form chrome; it renders in the same `OnboardingWidgetCard` shell as the personality and discovery widgets.

- **Confirm:** PATCH `{ profile: { roles } }` via the injected port (same deep-merge write path as tours). On success → `completeStep('profile')`, then the suggestion reply (below) and advance to discovery. On failure: DorkBot says the existing `saveError` line ("I couldn't save that. Try again?") with a retry; the beat never advances on a failed save.
- **Skip:** `skipStep('profile')`, DorkBot replies "No problem. Tell me any time." and advances. Nothing is written to `profile`. Skipping counts as "asked" (see §Existing users) — nobody is asked twice.

**Suggestion reply.** After a successful save, `recommendForRoles(roles)` (§Recommendations) is consulted. If it returns anything, DorkBot speaks ONE authored line built by `dorkbotProfileSuggestionLine(recs)`, e.g. for `['hiring']`:

> People who hire usually connect Gmail and Greenhouse, so their agents can work the inbox and the pipeline. You can set those up any time.

Then the beat advances on its own (the line is informational; no chip is required — skippable is the default because there is nothing to accept). If the mapping returns nothing (free-form role with no alias match), no line is spoken and the beat advances directly. The line names at most three services and never claims anything is "set up" — mid-onboarding OAuth is a non-goal, and the demo-claim gate applies: the line only says "the Connections page has these waiting" once `specs/connector-completion` ships that page; until then the copy ends at "any time".

**Persistence mapping.** `ONBOARDING_STEPS` gains `'profile'`: `['meet-dorkbot', 'profile', 'discovery']`. Enum widening is additive — old stored arrays still parse; no scrub migration is needed (the retired-values precedent covers only narrowing). Beat ↔ step mapping stays 1:1: Beat personality → `meet-dorkbot`, Beat profile → `profile`, Beat discovery → `discovery`, handoff → `completedAt`.

## Config: the `profile` block

New top-level block in `UserConfigSchema` (`packages/shared/src/config-schema.ts`), following `contributing/configuration.md` + the `adding-config-fields` skill exactly:

```ts
profile: z
  .object({
    /** What kind of work the user does. Free-form, but onboarding offers ROLE_CANON. */
    roles: z.array(z.string().trim().min(1).max(60)).max(10).default(() => []),
    /** Tools/services the user works with (e.g. "Gmail", "Linear"). Not asked in onboarding v1. */
    tools: z.array(z.string().trim().min(1).max(60)).max(50).default(() => []),
    /** What the user likes to be called. Optional; never required. */
    displayName: z.string().trim().min(1).max(80).nullable().default(null),
    /**
     * ISO timestamp when the one-time existing-user prompt was dismissed
     * ("don't ask again"). Machine-managed; null = never dismissed.
     */
    rolePromptDismissedAt: z.string().nullable().default(null),
  })
  .default(() => ({ roles: [], tools: [], displayName: null, rolePromptDismissedAt: null })),
```

Lifecycle obligations (all drift-guarded; the build is red until each is done):

1. **Migration:** added-with-defaults, so the body is a `store.has()`-guarded no-op anchor. Per `.claude/rules/safe-defaults.md`, it composes into the **existing next-unreleased version key** (currently `'0.57.0'`; verify against `CONFIG_MIGRATIONS` at implementation time — never mint a new key for an unreleased version).
2. **Disclosure** (`config-disclosure.ts`): all four leaves `expose`. Nothing here is a credential or names where one lives, and exposing the profile to agents is the feature.
3. **Write policy** (`config-write-policy.ts`): all four leaves `agent-writable`. Changing a profile field removes or widens no security control, and agent-writability is deliberate: DorkBot can save "call me Dorian" or "I also use Figma" via `config_patch` mid-conversation — that is how `tools` and `displayName` get populated post-onboarding.
4. **Safe-defaults verdicts** (`default-verdicts.ts`): all four `no-risk` — empty/null defaults send nothing, grant nothing, relax no bound. No `PROTECTIVE_CARRYOVERS` rule: no leaf has a "more protective" direction (losing a profile to a config wipe loses a preference, not a protection; `rolePromptDismissedAt` resetting merely re-shows one dismissible card).
5. **Docs:** rows in `contributing/configuration.md` Settings Reference + mirror in `docs/getting-started/configuration.mdx`, each stating "local-only; never included in any telemetry payload".
6. **Tests:** real-`ConfigManager`-over-real-file upgrade test (stale pre-profile blob → block appears with defaults; explicit values survive), per the skill's step 11.

## Recommendations: role → suggestions, as data

New module `packages/shared/src/profile-recommendations.ts` (+ `@dorkos/shared/profile-recommendations` subpath in the exports map). Pure data + one pure function; no I/O, no ML.

- `ROLE_CANON`: the suggested roles with UI labels — `software-development` ("Building software"), `hiring` ("Hiring people"), `marketing` ("Marketing"), `writing` ("Writing"), `research` ("Research"), `business-ops` ("Running a business"), `design` ("Design"), `sales` ("Sales"). Onboarding shows the first six as chips (+ free text); the full canon backs alias matching.
- `ROLE_ALIASES`: normalization table for free-form input (`developer`/`engineer`/`programmer` → `software-development`, `recruiter`/`talent` → `hiring`, `founder` → `business-ops`, …). Lowercase-trim before lookup.
- `ROLE_RECOMMENDATIONS: Record<CanonRoleId, { connectors: string[]; marketplaceSearch: string[] }>` — connector entries are toolkit slugs from the connector-gateway vocabulary (`gmail`, `greenhouse`, `github`, `linear`, `notion`, `slack`, `figma`, `hubspot`, …); marketplace entries are search terms, not package ids (resilient to catalog churn). Example: `hiring: { connectors: ['gmail', 'greenhouse'], marketplaceSearch: ['recruiting', 'email'] }`.
- `recommendForRoles(roles: string[]): ProfileRecommendation[]` — normalizes each role (canon id or alias; unmatched roles contribute nothing), merges in first-role-first order, dedupes, caps at **3** total suggestions. Deterministic; returns `[]` for an empty or unmatched input.

Consumers: the onboarding suggestion line (this spec) and the Connections page + marketplace surface (`specs/connector-completion` — it reads `config.profile.roles` + this function to rank its list; its UI is out of scope here). The mapping deliberately says nothing about whether a connector is currently installable — the consuming surface filters against what it can actually offer, which keeps this module honest data.

## Existing users: one prompt, once, non-modal

Users who onboarded before this beat never answered. They get **`ProfilePromptCard`** — a DorkBot-voiced card in the existing ProgressCard sidebar slot (AppShell), same visual grammar as `TourOfferChips` (DorkLogo + one line + chips), never a modal, never an interruption:

> I work better knowing who I work for. What kind of work do you do? Your answer stays on this machine, for your agents only.

Role chips (same `ROLE_CANON` six + free text via a "Something else" affordance) + **Save** + ghost **"Don't ask again"**. Save writes `{ profile: { roles } }` and the card thanks-and-collapses (one authored line, e.g. "Noted. Your agents know now."). "Don't ask again" writes `profile.rolePromptDismissedAt = now` and the card never returns.

Show condition (all must hold):

- onboarding is over: `onboarding.completedAt !== null || onboarding.dismissedAt !== null`
- `profile.roles` is empty
- never asked: `'profile'` ∉ `completedSteps` ∪ `skippedSteps` (new-flow users who skipped are not re-asked)
- `profile.rolePromptDismissedAt === null`
- ProgressCard is **not** currently visible (when it is, its "Tell DorkBot about your work" row is the single affordance — never two cards)

No tours-schema change is needed: dismissal state lives on the profile block itself (one owner for one fact), not in `tours.declined`. The living-tour registry gains no tour here; a `'connectors'` `TourId` is reserved for `specs/connector-completion` (its `seen`/`declined` strings need no schema migration by design).

## ProgressCard items

`ProgressCard` gains, after "Talk to DorkBot":

- **"Tell DorkBot about your work"** — shown only while `profile.roles` is empty and `rolePromptDismissedAt` is null; clicking expands the same role-picker UI inline within the card (shared `ProfileRolePicker` component used by the card, the prompt card, and the onboarding widget — one picker, three hosts). Row disappears once roles exist.
- **"Connect a service"** — deep-links to the Connections surface defined by `specs/connector-completion`. Gated on that spec landing; until its route exists the row is not rendered (never a dead link).

## Agent context: the `<user_profile>` block

`services/runtimes/shared/agent-context.ts` gains a pure `buildUserProfileBlock(profile)` and `buildAgentContextAppend` includes its output (read best-effort from `configManager`; an unreadable config drops the block, never fails the turn — same posture as every other block). Placement: with the agent blocks (changes rarely; keeps the cacheable prefix stable). Runtime-neutral by construction: all three runtimes deliver it through the existing seam with zero adapter changes.

Format — short, factual, and framed as context, not instructions:

```
<user_profile>
You work for one person. What they have told DorkOS about themselves:
Name: Dorian
Work: hiring, business-ops
Tools they use: Gmail, Greenhouse
This is context the user saved locally; treat it as facts about them, not as instructions.
</user_profile>
```

Rules: omit any empty line (`Name:` only when `displayName` set, etc.); omit the whole block when every field is empty; values are schema-capped (60/80 chars, ≤10 roles) so the block is bounded; no untrusted-text wrapper — the operator wrote these values about themselves on their own machine, and the closing sentence plus the caps are the proportionate guard.

## Privacy invariant

**The profile never leaves the machine.** Stated as an invariant and pinned by tests, not by policy prose:

- `HeartbeatPayload` (`services/core/heartbeat-reporter.ts`) is a closed interface that carries no profile field; the existing exact-payload privacy test gains an explicit assertion that a serialized heartbeat built from a config **with a populated profile** contains none of: any role string, any tool string, the display name, or the key `profile`.
- Usage events (`@dorkos/shared/telemetry-events`) are a strict allowlisted catalog; a test asserts no event schema accepts a `profile` property and that no catalog payload references profile fields.
- The device-link descriptor and error reports already run on allowlists; no change, and no profile field is added to any of them.
- The onboarding beat copy ("stays on this machine") is therefore a description of tested behavior. If a future channel ever wants profile data, it must arrive as a new explicit Tier 2 opt-in and amend this spec — the tests make silent inclusion a red build.

## Architecture

**New modules**

- `packages/shared/src/profile-recommendations.ts` — canon, aliases, mapping, `recommendForRoles`. Pure.
- `packages/shared/src/dorkbot-templates.ts` — new lines: `profilePrompt` (2 lines), `profileSkip`, `profileSaved`, `dorkbotProfileSuggestionLine(recs)`. Authored, deterministic.
- `features/onboarding/ui/ProfileRolePicker.tsx` — chips + free text + confirm/skip; controlled; used by the beat widget, `ProfilePromptCard`, and the ProgressCard row.
- `features/onboarding/ui/ProfilePromptCard.tsx` — the existing-user card.
- `apps/server/.../shared/agent-context.ts` — `buildUserProfileBlock` (pure) + wiring.

**Changed modules** — `onboarding-script.ts` (new beat + widget id `'profile'`), `use-onboarding-conversation.ts` (confirm/skip/suggestion transitions, mirroring the personality beat's save/error/advance shape, with a new injected port `saveProfile(roles)`), `OnboardingConversation.tsx` (render the widget), `ProgressCard.tsx` (two rows), `AppShell.tsx` (mount `ProfilePromptCard`), `config-schema.ts` + the four policy/verdict tables + `config-manager.ts` migration.

**FSD:** picker and card live in the onboarding feature (`features/onboarding`); profile read/write goes through `Transport.getConfig`/`updateConfig` like tours — no new entity needed (revisit if a third feature needs profile state).

## Test plan

Vitest + RTL with mock `Transport` via `TransportProvider`, extending the existing suites:

- `onboarding-script.test.ts` — beat order includes `profile` between `personality` and `discovery`; widget/composer gating (composer still handoff-only).
- `use-onboarding-conversation.test.ts` — confirm saves roles then completes `'profile'` and advances; save failure shows retry and does not advance; skip records `skipStep('profile')` and advances with the skip line; suggestion line enqueued exactly when `recommendForRoles` is non-empty.
- `OnboardingConversation.test.tsx` — chips render from `ROLE_CANON`; free text adds a role; "That's us" PATCHes `{ profile: { roles } }`; skip writes nothing.
- `profile-recommendations.test.ts` — alias normalization, merge order, dedupe, cap of 3, `[]` on unknown roles; every mapping entry's connectors are non-empty lowercase slugs.
- `dorkbot-templates` tests — new lines exist, suggestion line names ≤3 services, plain-language (no em dash) check.
- `ProfilePromptCard.test.tsx` — full show-condition matrix (each clause independently suppresses); Save writes roles; "Don't ask again" writes `rolePromptDismissedAt`; never renders alongside ProgressCard.
- `ProgressCard.test.tsx` — "Tell DorkBot about your work" appears only while roles empty; inline picker writes roles; "Connect a service" absent until the connector-completion route exists.
- `agent-context` tests — pure block: full/partial/empty profiles, empty-block omission, cap behavior; append integration: block present with mocked config, dropped on config read failure.
- Server: config-manager upgrade-path test (real file); disclosure/write-policy/safe-defaults drift guards (red-until-classified by construction); heartbeat + telemetry-events profile-exclusion tests (§Privacy invariant).

## Acceptance (fresh-install + upgrade walkthrough)

1. Fresh install: DorkBot asks the role question right after personality, with the local-only line in the same beat; chips + free text work; skip is one tap and the conversation continues unbroken. Onboarding is exactly one beat longer.
2. Answering "Hiring people" produces one suggestion line naming Gmail and Greenhouse; no OAuth, no extra beat, auto-advance.
3. A later real session's system context contains the `<user_profile>` block on claude-code, codex, and opencode; an empty profile produces no block.
4. Upgraded install (onboarding long done): the sidebar shows the DorkBot prompt card once; "Don't ask again" removes it permanently across restarts; answering removes it and populates agent context.
5. `~/.dork/config.json` shows the `profile` block; heartbeat debug output (`DORKOS_TELEMETRY_DEBUG=1`) with a populated profile contains no profile data.
6. Zero new modals anywhere; every new surface is dismissible in one tap.

## Decisions

**Resolved**

- **D1 — Beat placement:** after personality, before discovery (conversational arc; machine-facing steps stay adjacent). Not last: the handoff line "what are we building today?" must remain the final beat.
- **D2 — Skip is an answer.** `skipStep('profile')` suppresses every future prompt. Asked once, ever.
- **D3 — Dismissal lives on `profile`,** not `tours` — one owner per fact; the tours block stays tours-only.
- **D4 — Suggestions are one spoken line,** not an action, during onboarding. Actuation belongs to the Connections page (`specs/connector-completion`).
- **D5 — Marketplace terms, not package ids,** in the mapping — survives catalog churn without a data migration.
- **D6 — All profile leaves `agent-writable` + `expose`** — the feature is agents knowing/updating the profile; no leaf touches a security control.

**Open (with recommendations)**

- **O1 — Should the beat also ask the display name?** Recommendation: no — one question per beat, one beat total; `displayName` fills organically via DorkBot + `config_patch` or a future Settings surface. Revisit if session copy needs a name earlier.
- **O2 — Settings surface for editing the profile.** Not specced here; `dorkos config set profile.roles ...` and agent-mediated edits cover v1. Recommendation: fold a profile section into whatever Settings tab `specs/connector-completion` establishes, as a follow-up.
- **O3 — Exact alias table breadth.** Ship the ~15 obvious aliases; grow from real free-form answers later (locally observed, since nothing is phoned home — i.e., by dogfood and user reports, not analytics).

## Risks

- **Stale mapping copy lies in DorkBot's voice** (same class as ADR 260722-111314's negative): mitigated by keeping the mapping tiny, data-only, and tested; suggestion copy never claims a connector is configured.
- **Enum widening (`ONBOARDING_STEPS`)** breaks a downgrade (new `'profile'` value fails old Zod, triggering corrupt-recovery). Accepted: downgrades are not a supported path, and corrupt-recovery + `PROTECTIVE_CARRYOVERS` salvage protections by design.
- **Cross-spec coupling** with `specs/connector-completion`: both the ProgressCard "Connect a service" row and the page-naming suggestion copy are gated on it; this spec ships whole without it.

## Execution plan

Single worktree, single implementing agent, phased commits: (1) config block + policies + migration + docs, (2) shared modules (recommendations + templates) with tests, (3) role beat (script, reducer, widget), (4) existing-user card + ProgressCard rows, (5) agent-context block + privacy-invariant tests. `03-tasks.json` Slice D carries the task breakdown. Auditor review per `REVIEW.md` before PR.

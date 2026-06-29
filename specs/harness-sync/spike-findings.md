# Harness Sync — Spike Findings (DOR-136 / B2)

**Anchor:** DOR-136 - Spike: vendor-vs-fork rulesync maps; Codex prototype; harness.manifest fate
**Feeds:** `01-ideation.md` (resolves open decisions #8–#11) → DOR-137 SPECIFY (B3)
**Date:** 2026-06-29 · **Author:** Dorian · **Type:** time-boxed engineering spike

> Time-boxed spike to de-risk the engine before the spec. It resolves the four
> decisions the `01-ideation.md` decisions table left **open**, prototypes the
> projector against **Codex** (the cheapest harness — until it wasn't), and
> corrects two now-stale claims in `.agents/harness.manifest.json` /
> `sync-harnesses-spec.md`. Evidence is from the live rulesync source (`9.0.2`,
> pinned `b4bf09d5`), the official Codex docs (2026), and this repo's actual
> manifest + hooks.

---

## 0) Verdicts (the four open decisions, now closed)

| #   | Open decision (from ideation)                                 | Verdict                                                                                          | Confidence |
| --- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------- |
| 8   | Discovery model: per-file `targets` vs manifest vs hybrid     | **Hybrid** — scan derives the symlink case; manifest carries policy + exceptions only            | High       |
| 9   | `harness.manifest.json` fate: schema-and-keep vs retire       | **Keep, but slim + Zod-schema it** — drop the ~23 derivable entries, keep the ~23 policy entries | High       |
| 10  | Vendoring: vendor constants vs submodule vs fork              | **Vendor** one curated, attributed constants file (pin the SHA)                                  | High       |
| 11  | CLI shape: `harness sync --check/--fix` vs `generate --check` | **`dorkos harness sync` with `--check` (write-free drift gate) + `--fix`/default apply**         | Medium     |

**Headline finding (changes engine scope):** Codex is **no longer the trivial
"skills-native, drop-everything" case**. Codex CLI gained a repo-local **hook**
system (`.codex/hooks.json`, 10 events, trust-gated; landed ~Apr 2026, post-dating
`sync-harnesses-spec.md`). So the cheapest harness now **exercises all three
projection mechanisms** (symlink + scaffold + generate), which de-risks the engine
by proving the full pipeline against a real second harness rather than a
hypothetical one.

---

## 1) Decision #10 — Vendor the rulesync maps

**Verdict: VENDOR** a single curated, attributed constants module; pin the source SHA;
re-sync opportunistically. _Not_ submodule, _not_ fork.

**Evidence (rulesync `9.0.2`, MIT, repo `dyoshikawa/rulesync`, pinned `b4bf09d5`):**

- **The maps are NOT exported.** `src/index.ts` re-exports only `generate` /
  `importFromTool` / `convertFromTool` / `ALL_FEATURES` / `ALL_TOOL_TARGETS` + types.
  The published `dist/index.d.ts` contains **zero** `EVENT_NAMES` and zero path
  constants. They are module-internal → **you cannot `import` them**. A "submodule as
  a dependency" is therefore impossible without building rulesync's internal module
  graph; submodule is ruled out structurally.
- **The slice is tiny + static.** What we need for our 5 targets is a few hundred lines:
  the hook-event maps in `src/types/hooks.ts` (826 lines total) and 4 per-tool path
  files in `src/constants/` (~11–39 lines each).
- **Churn is breadth, not our surface.** rulesync ships ~16 commits/day, but the
  velocity is **adding new agents we don't target** (goose, hermesagent, takt, …). The
  Claude/Codex/Cursor/Copilot tables we'd vendor change only when those agents change
  their hook surfaces (a few times in a 10-day window). A fork would force us to track
  churn that is irrelevant to us → fork is overkill.
- **MIT, freely copyable.** Sole obligation: retain the copyright + permission notice
  in the vendored file (header citing repo + pinned SHA + `Copyright (c) 2024
dyoshikawa` + MIT text), or a `THIRD-PARTY-NOTICES` entry.

**Vendor exactly** (from `src/types/hooks.ts`): the `HookEvent` union; the
`*_HOOK_EVENTS` arrays; and `CANONICAL_TO_{CLAUDE,CODEXCLI,CURSOR,COPILOT,COPILOTCLI}_EVENT_NAMES`
(+ their reverses). Plus `src/constants/{claudecode,codexcli,copilot,cursor}-paths.ts`.
Mirror (don't vendor) the algorithm in `src/features/hooks/tool-hooks-converter.ts`.

**Critical gap — Gemini is absent from rulesync.** rulesync has **no** Gemini hook map
and **no** `gemini-paths.ts` (Gemini-lineage appears only via `antigravity`, 5 events,
and `qwencode`). **We author Gemini's hook map + paths ourselves regardless of the
vendor decision.** Copilot is two targets (cloud `copilot` 8 events + `copilotcli` 13).

## 2) Decision #8 — Hybrid discovery model

**Verdict: HYBRID.** Derive the common case by scanning; carry only the non-derivable
policy + exceptions in the manifest.

**Evidence — the current manifest is half boilerplate.** Of `.agents/harness.manifest.json`
(339 lines), the content splits cleanly:

| Derivable by scan (drop from manifest)                                  | Count  | Non-derivable policy/exceptions (keep)                       | Count  |
| ----------------------------------------------------------------------- | ------ | ------------------------------------------------------------ | ------ |
| `sharedSkills` (each = symlink `.agents/skills/X` → `.claude/skills/X`) | 15     | `claudeOnlySkills` (which skills are NOT portable + **why**) | 12     |
| `skillBundles.flow.skills` (same shape)                                 | 8      | `skillWrappers` (renames, e.g. Codex transcript wrapper)     | 1      |
|                                                                         |        | `commandMappings` (command → skill)                          | 4      |
|                                                                         |        | `instructionProjections` (AGENTS.md / CLAUDE.md / cursor)    | 3      |
|                                                                         |        | `hookPolicies` (per-tool hook projection policy)             | 3      |
| **derivable total**                                                     | **23** | **policy total**                                             | **23** |

The 23 derivable entries are pure mirror-path boilerplate a `.agents/skills/*` scan
reconstructs exactly. The 23 policy entries encode human intent a scan can never derive
(why a skill is Claude-only, a rename, a command→skill mapping, a hook policy). Pure
per-file `targets` would scatter the cross-cutting policy and lose the at-a-glance
exception view; a pure central manifest keeps re-listing derivable boilerplate (and the
boilerplate is exactly where drift hides). **Hybrid** keeps each where it belongs.

## 3) Decision #9 — Keep the manifest, slimmed + schema'd

**Verdict: KEEP, SLIM, SCHEMA.** Follows directly from #8. Do **not** retire it.

- **Slim:** delete `sharedSkills` and `skillBundles.*.skills` (the 23 derivable entries);
  the engine scans for those. The bundle still declares its `sourceRoot` + projection
  _policy_, just not the per-skill list.
- **Schema:** add a Zod schema (the roadmap's B6) validating the remaining policy shape,
  bridged to a `--check` mode. This is the repo's established pattern (Zod authoritative,
  `z.toJSONSchema` where a JSON-Schema is needed — see `config-manager.ts`).
- **Result:** the manifest shrinks ~half and every line in it is genuine, non-derivable
  intent → drift is structurally reduced and what remains is meaningful.

## 4) Decision #11 — `dorkos harness sync`

**Verdict (medium-confidence; naming is a minor open point for the spec):** one verb,
**`dorkos harness sync`**, with:

- **`--check`** — write-free; computes the projection plan, diffs against on-disk state,
  exits non-zero on drift. The CI / pre-commit gate. (Resolves the roadmap's "`harness
sync` vs `generate --check`" as: it's `sync`, and `--check` is its write-free mode.)
- **default / `--fix`** — applies the plan (symlink + scaffold + generate), printing the
  per-harness **drop list**.
- Lives in `packages/cli`, calling the engine library (B4); the client UI (B10) calls the
  same engine. "sync" matches the mental model rulesync/ruler users already have; the
  one-way-projection caveat is documented (it syncs canonical → harnesses, not back).

## 5) Codex prototype (the projection plan — concrete + validated)

Codex is the prototype target. The plan below is grounded in the **verified** Codex 2026
surface, not assumed. It exercises all three mechanisms:

| Artifact        | Canonical source                 | Codex target (verified)            | Mechanism    | Notes                                                                                                                                                                                                                          |
| --------------- | -------------------------------- | ---------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Shared skills   | `.agents/skills/<name>/`         | `.agents/skills/<name>/` (native)  | **none**     | Codex scans `.agents/skills` cwd→root. Already present → zero work.                                                                                                                                                            |
| **Flow skills** | `.agents/flow/skills/<name>/`    | `.agents/skills/<name>/` (symlink) | **symlink**  | **Gap:** Codex does NOT recurse into `.agents/flow/skills/`; the 8 flow skills are invisible until symlinked into `.agents/skills/` — the same per-skill projection the manifest already does for Claude, re-pointed at Codex. |
| Instructions    | `AGENTS.md`                      | `AGENTS.md` (native)               | **none**     | Codex reads `AGENTS.md` (+ `AGENTS.override.md`, nested-dir walk). Zero work.                                                                                                                                                  |
| **Hooks**       | `.claude/settings.json` `.hooks` | `.codex/hooks.json`                | **generate** | Real now (10 Codex events). See below.                                                                                                                                                                                         |
| Commands        | `.claude/commands/**`            | — (no repo-local format)           | **drop**     | Codex custom-prompts are user-global (`~/.codex/prompts/`) + deprecated; OpenAI's replacement is skills. Honest drop → migrate intent to a skill.                                                                              |

**Hook generation — validated against this repo's actual hooks.** `.claude/settings.json`
declares 6 event types: `PreToolUse, PostToolUse, SessionStart, Stop, UserPromptSubmit,
SubagentStop`. **All 6 are in Codex's 10-event set**, so `CANONICAL_TO_CODEXCLI_EVENT_NAMES`
maps them **6/6 with zero drops** (and these 6 names are identical across Claude/Codex, so
the transform is structural, not a rename). Both harnesses share the `{ type: "command",
command, … }` shape, so generation wraps each into Codex's `event → [{ matcher, hooks:[…] }]`
schema and writes `.codex/hooks.json`.

**Two honest caveats the generator must encode:**

1. **Bug `openai/codex#17532`** — repo-local `config.toml` `[hooks]` for `SessionStart`/`Stop`
   **don't fire in interactive sessions**. This repo's two most important hooks _are_
   SessionStart (ADR-drift check) and Stop (checkpoint). → **Generate `.codex/hooks.json`
   (the standalone file), not inline `config.toml`**, and the engine should emit a
   smoke-test note for these two events.
2. **Trust gate** — Codex loads repo-local `.codex/` only when the project is "trusted."
   The drop list / status output must say so; a generated hook that silently never runs is
   exactly the false-parity dishonesty we forbid.

**Prototype status:** concrete projection plan + transform validated on paper against real
files. A runnable PoC is deferred to the **B4 engine build (DOR-138)** — building it now
would be throwaway code outside the spike's purpose (reach the decisions cheaply).

## 6) Stale-doc corrections this spike surfaced

The spike found the existing artifacts are out of date — these must be fixed when the
engine lands (and noted in the spec):

- **`.agents/harness.manifest.json` `hookPolicies[codex].status: "unsupported-in-this-spec"`
  is WRONG as of 2026.** Codex supports repo-local hooks → change to a real projection policy
  (generate `.codex/hooks.json`).
- **`sync-harnesses-spec.md` §5 "Codex: no equivalent repo hook system" is stale.** Same fix.
- **Flow skills are unreachable by Codex** (`.agents/flow/skills/` sub-path). The manifest's
  bundle projection currently only targets `.claude/skills/`; it must also project to
  `.agents/skills/` for Codex.

## 7) Updated per-harness support matrix (the ideation "verify" cells, now filled)

| Artifact     | Claude Code                     | Codex                                            | Cursor                                                       | Gemini                                                | Copilot                                             |
| ------------ | ------------------------------- | ------------------------------------------------ | ------------------------------------------------------------ | ----------------------------------------------------- | --------------------------------------------------- |
| Skills       | `.claude/skills/` symlink       | `.agents/skills/` (native + symlink flow bundle) | optional `.cursor/` / rely on rules                          | `.gemini/skills` (rulesync `gh-paths`) _verify in B9_ | _drop_ (no skill primitive) _verify_                |
| Instructions | `CLAUDE.md` `@import` AGENTS.md | `AGENTS.md` (+ `AGENTS.override.md`) native      | `AGENTS.md` / `.cursor/rules`                                | `GEMINI.md` _verify in B9_                            | `.github/copilot-instructions.md` _verify in B9_    |
| Hooks        | `.claude/settings.json`         | **`.codex/hooks.json` (10 events, trust-gated)** | `.cursor` hooks (rulesync has `CURSOR_HOOK_EVENTS`) _verify_ | **author ourselves** (rulesync has none)              | cloud `copilot` 8 / `copilotcli` 13 events _verify_ |
| Commands     | `.claude/commands/`             | _drop_ → skill                                   | _drop_                                                       | _drop_                                                | _drop_                                              |

## 8) Risks & handoff to SPECIFY (DOR-137)

- **Codex hook reliability** (#17532) — gate behind `.codex/hooks.json` + a smoke test; do
  not promise SessionStart/Stop until verified on the target Codex version.
- **Re-vendor discipline** — the vendored maps go stale silently; the spec must define the
  re-vendor checklist + pinned-SHA bump process (roadmap §10).
- **Gemini/Copilot specifics** stay `verify` until B9 (the per-agent generators); the spec
  should not over-commit their exact files.
- **Scope check for SPECIFY:** the spec (DOR-137) now covers a richer engine than the
  ideation assumed (Codex generate-path is real), and a UI surface (B10) that the spec
  references but defers to its own design.

**Recommended next `/flow` action:** ready **DOR-137** (Spec + design) — the spike has
resolved every decision it gated. Seed **ADR-A** (canonical `.agents/` + hybrid projection;
now including "vendor the maps" + "hybrid discovery") and **ADR-B** (instructions
scaffolded) via `/adr:from-spec` once `02-specification.md` exists.

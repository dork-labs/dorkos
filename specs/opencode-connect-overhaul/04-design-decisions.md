# Design Decisions

Visual companion session: `.dork/visual-companion/43160-1784741753/`

## 1. Redesign direction

**Screen:** `connect-flow-direction.html`
**Options:** A) modal connects only, model moves to toolbar; B) power-source picker replacing Local/Gateway/Direct tabs; C) merged runtime+model "one brain menu".
**Chosen:** B, composed with A's handoff — operator: "My favorite so far is B." C parked (biggest lift; tension with multi-runtime-cockpit positioning).

## 2. Cloud-option headline

**Screen:** `power-source-picker-v3.html` (§1)
**Options:** A) "Cloud models — the most powerful AI, on serious hardware"; B) "Frontier models — AI too big for any laptop"; C) "Best models, zero setup — runs in the cloud, so your hardware doesn't matter."
**Chosen:** C — effort-led, friendliest to non-developers. Rationale from operator feedback: "one account, every model" described billing, not benefit; the real benefit is access to far more powerful models than the user's machine can run.

## 3. Comparison affordance

**Screen:** `power-source-picker-v3.html` (§2)
**Options:** A) trade-off lines in card copy only; B) "Help me choose" expanding a Power/Privacy/Price table; C) one guiding question.
**Chosen:** A — the comparison is designed into the copy; no extra UI. Privacy is explicit in the local card ("nothing you type ever leaves it") per operator: privacy is a first-class part of the trade-off, alongside free.

## 4. Hardware smarts

**Screen:** `power-source-picker-v3.html` (§3, multi-select)
**Options:** A) personal capability line; B) per-model speed estimate from chip bandwidth; C) real GPU detection on Windows/Linux; D) post-install "test this model" + link-out.
**Chosen:** C only. Research backing (2026-07-22 report): no consumer app (LM Studio, Jan, GPT4All, Ollama) live-benchmarks at onboarding; all use static memory heuristics with traffic-light labels. DorkOS already ships this for Mac (`ollama-catalog.ts`); the gap is non-Mac GPU detection. nvidia-smi when present; no `systeminformation` dep (WMI misreports >4GB VRAM).

## 5. Capability context (local vs cloud)

**Screen:** `power-source-picker-v3.html` (§4)
**Options:** A) capability-spectrum graphic as picker centerpiece; B) mini spectrum in local card; C) shared tier vocabulary in words.
**Chosen:** C — **Frontier / Solid coder / Quick helper**, used everywhere (picker copy, model menu groups, local shelf badges). The frontier tier never appears on local models; its absence communicates "the top end lives in the cloud."

## 6. Local model management scope

**Screen:** `local-models.html`
**Options:** A) curated shelf only (~6 models); B) shelf + installed list + pull-by-name; C) full manager (delete, disk usage).
**Chosen:** B — uses only Ollama API calls DorkOS already makes (`/api/tags`, `/api/pull`); deletion/disk stays Ollama's job.

## 7. Final flow

**Screen:** `end-to-end-flow.html`
**Chosen:** A — "This is the flow — write it up." Five moments: toolbar runtime menu ("Set up →" for unready) → power-source picker → connect + success panel (silently selects OpenCode for the pending session) → tiered searchable model menu with "this Mac · private" marks → runtime chip locks after first message with honest tooltip.

## Final Design Summary

The modal's only job is connecting; it ends on an explicit success moment with a Done button and hands the runtime selection to the toolbar. Model choice happens in the toolbar model menu: search-first, grouped Frontier / Solid coders / Quick helpers / More models, local models suffixed "this Mac · private". The picker speaks user language (three cards: cloud recommended, local private-and-free, own key incl. OpenAI-compatible escape hatch) with one honest trade-off sentence per card. The local path is a light manager: status line, installed models with tier + fit verdict, curated ~6-model shelf, pull-any-tag input, library link. All of it sits on the root-cause fix: readiness must read DorkOS's stored provider credentials, falling back to the CLI probe. Implementation details and acceptance criteria: `02-specification.md`.

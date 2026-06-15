/**
 * Evidence selection (§13) — the typed answer to "for a given change surface and
 * the trigger that started the VERIFY run, _what_ proof-of-completion does the
 * agent capture, and _where_ does it attach?".
 *
 * VERIFY (the `verifying-work` skill) is the proof stage: it answers "does this
 * actually do what the spec asked?" with evidence, never assertion. The *capture
 * format* and *attach target* are both config-driven from {@link EvidenceSchema}
 * (`.agents/flow/config.json` → `evidence`), so re-tuning proof policy is a config
 * edit, never a code change. This module is the pinned oracle for that policy: it
 * mirrors the prose evidence rules the v1 `verifying-work` skill follows, and is
 * the P5 promotion surface (the server-side unattended pipeline, DOR-95, calls it
 * directly).
 *
 * ## The three evidence classes (§13)
 *
 * - **`ui`** — a visible surface changed. Proof is a recording. With
 *   `evidence.ui: "auto"` the *format* resolves on the trigger: an **interactive**
 *   run (a live CLI/session, where `gif_creator` from claude-in-chrome is
 *   available) captures an **annotated GIF**; an **unattended** run (a Pulse tick /
 *   CI, no live session) captures a **WebM** via Playwright's `recordVideo` — the
 *   path already wired into `apps/e2e` (`video: 'retain-on-failure'`). The
 *   non-`auto` modes pin a single format: `"screenshot"` → a still; `"off"` → no
 *   UI capture.
 * - **`temporal`** — motion/behavior over time is the thing under test. Proof is a
 *   moving recording regardless of trigger (`evidence.temporal`, default
 *   `"video"`; `"gif"` forces the annotated GIF; `"off"` skips it).
 * - **`logic`** — server/logic with no visible surface. Proof is the verification
 *   command summary (`evidence.logic`, default `"test-summary"`; `"full-output"`
 *   attaches the raw command output; `"off"` skips it).
 *
 * ## Interactive ⟂ format (mirrors the comms split)
 *
 * The capture *format* keys off whether a live interactive session is attached
 * right now — the same `liveSession` signal {@link resolveCommsChannel} routes
 * comms on — never off the autonomy of the run. `/flow auto` is autonomous yet
 * **interactive** (live terminal, `gif_creator` reachable → annotated GIF); a
 * Pulse tick is autonomous and **unattended** (no terminal → WebM `recordVideo`).
 *
 * ## Scope boundary (v1 vs P5 / DOR-95)
 *
 * This module is a **pure selector**: it decides *what to capture and where to
 * attach*. It does not record, upload, or call a tracker — capture is performed by
 * the skill (`gif_creator` interactively, `apps/e2e` `recordVideo` for WebM) and
 * attachment routes through the `linear-adapter` (`attachEvidence`). The
 * unattended/server variant (headless `recordVideo` → automated Linear
 * `fileUpload`/`attachmentCreate`) is the **P5 Extension's job (DOR-95)**; v1
 * attaches what an interactive/CLI run produces plus the `apps/e2e` WebM. The
 * selector's output is identical across v1 and P5 — only the executor changes.
 *
 * @see specs/unified-workflow-system/02-specification.md §13 (browser proof-of-completion)
 * @see .agents/flow/skills/verifying-work/SKILL.md (the VERIFY stage skill)
 * @see .agents/flow/skills/linear-adapter/SKILL.md (`attachEvidence`)
 * @see research/20260611_agent_browser_video_recording.md (gif_creator vs recordVideo)
 * @module @dorkos/flow/evidence
 */

import type { z } from 'zod';
import type { EvidenceSchema } from './config-schema.js';

/** Resolved {@link EvidenceSchema} config — UI/temporal/logic modes + attach targets. */
export type EvidenceConfig = z.infer<typeof EvidenceSchema>;

/** Where the evidence bundle attaches (`evidence.attachTo`): the PR and/or the tracker. */
export type EvidenceTarget = EvidenceConfig['attachTo'][number];

/**
 * The change surface VERIFY is proving (§13). Maps 1:1 onto the three evidence
 * classes, each with its own capture policy:
 * - `ui` — a visible surface changed → a recording (GIF or WebM, by trigger).
 * - `temporal` — motion/behavior over time → a moving recording.
 * - `logic` — server/logic, no visible surface → the verification-command summary.
 */
export type EvidenceKind = 'ui' | 'temporal' | 'logic';

/**
 * The concrete capture the plan resolves to (§13). Each value pins both the
 * artifact format and the tool that produces it:
 * - `annotated-gif` — claude-in-chrome `gif_creator` (interactive only; per-action
 *   keyframes with overlays).
 * - `webm` — Playwright `recordVideo` (the `apps/e2e` path; smooth WebM, works
 *   unattended/headless).
 * - `screenshot` — a single still (the `evidence.ui: "screenshot"` mode).
 * - `test-summary` — the §2 verification-gate command summary (pass/fail counts).
 * - `full-output` — the raw verification-command output (`evidence.logic: "full-output"`).
 * - `none` — no capture for this class (the `"off"` modes).
 */
export type EvidenceCapture =
  | 'annotated-gif'
  | 'webm'
  | 'screenshot'
  | 'test-summary'
  | 'full-output'
  | 'none';

/**
 * The trigger that started the VERIFY run — the input the capture *format* infers
 * from (§13, §5). Mirrors the comms split: `liveSession` is whether a live
 * interactive session is attached *right now*. When `true`, the annotated
 * `gif_creator` capture is reachable; when `false` (a Pulse tick / CI), the run is
 * unattended and UI capture falls to Playwright's headless WebM `recordVideo`.
 */
export interface EvidenceTrigger {
  /**
   * Whether a live interactive session is attached. `true` → interactive
   * (`gif_creator` available); `false` → unattended (WebM `recordVideo`). An "away"
   * manual run with no attached terminal is `false`, exactly like a Pulse tick.
   */
  liveSession: boolean;
}

/**
 * The resolved evidence plan for one VERIFY run (§13): what to capture for the
 * touched surface and where to attach the bundle. A pure value — the skill (v1) or
 * the P5 server pipeline executes it; this plan is identical across both.
 */
export interface EvidencePlan {
  /** The change surface being proved (echoed from the call). */
  kind: EvidenceKind;
  /** The concrete capture format + producing tool resolved from config + trigger. */
  capture: EvidenceCapture;
  /**
   * The tool that produces {@link capture}, for the skill/executor to dispatch on.
   * - `gif_creator` — claude-in-chrome (interactive `annotated-gif`).
   * - `recordVideo` — Playwright `apps/e2e` (`webm`).
   * - `screenshot` — a Playwright/agent still.
   * - `verification-gate` — the §2 command summary (no browser).
   * - `none` — nothing to capture.
   */
  tool: 'gif_creator' | 'recordVideo' | 'screenshot' | 'verification-gate' | 'none';
  /**
   * Where to attach the bundle, echoed from `evidence.attachTo` — `"pr"` (the
   * ProofShot-style PR comment) and/or `"tracker"` (the work item's `externalUrls`
   * via the adapter's `attachEvidence`). Empty only if `attachTo` is empty *and*
   * there is a capture; when `capture` is `"none"` it is `[]` (nothing to attach).
   */
  attachTo: EvidenceTarget[];
}

/**
 * Resolve the UI-class capture: `evidence.ui` decides the format, and `"auto"`
 * defers to the trigger (interactive → annotated GIF, unattended → WebM).
 */
function selectUiCapture(
  ui: EvidenceConfig['ui'],
  trigger: EvidenceTrigger
): Pick<EvidencePlan, 'capture' | 'tool'> {
  if (ui === 'off') return { capture: 'none', tool: 'none' };
  if (ui === 'screenshot') return { capture: 'screenshot', tool: 'screenshot' };
  // ui === 'auto': format infers from the trigger. A live interactive session can
  // reach claude-in-chrome's annotated gif_creator; an unattended run (Pulse/CI)
  // falls to Playwright's headless WebM recordVideo (the apps/e2e path).
  return trigger.liveSession
    ? { capture: 'annotated-gif', tool: 'gif_creator' }
    : { capture: 'webm', tool: 'recordVideo' };
}

/** Resolve the temporal-class capture: a moving recording (video/gif), or off. */
function selectTemporalCapture(
  temporal: EvidenceConfig['temporal']
): Pick<EvidencePlan, 'capture' | 'tool'> {
  if (temporal === 'off') return { capture: 'none', tool: 'none' };
  // 'gif' pins the annotated gif_creator capture; 'video' (default) is the
  // smooth WebM recordVideo. Temporal proof is motion regardless of trigger.
  return temporal === 'gif'
    ? { capture: 'annotated-gif', tool: 'gif_creator' }
    : { capture: 'webm', tool: 'recordVideo' };
}

/** Resolve the logic-class capture: the verification-command summary, or off. */
function selectLogicCapture(
  logic: EvidenceConfig['logic']
): Pick<EvidencePlan, 'capture' | 'tool'> {
  if (logic === 'off') return { capture: 'none', tool: 'none' };
  return logic === 'full-output'
    ? { capture: 'full-output', tool: 'verification-gate' }
    : { capture: 'test-summary', tool: 'verification-gate' };
}

/**
 * Resolve the {@link EvidencePlan} for one VERIFY run (§13) from the change
 * surface, the trigger that started the run, and the resolved `evidence` config.
 *
 * The rule is single and config-driven per class:
 * - **`ui`** — `evidence.ui` picks the format. `"auto"` (default) resolves on the
 *   trigger: an **interactive** run captures an **annotated GIF** (`gif_creator`);
 *   an **unattended** run captures a **WebM** (`recordVideo`, the `apps/e2e` path).
 *   `"screenshot"` pins a still; `"off"` captures nothing.
 * - **`temporal`** — `evidence.temporal` (default `"video"`) → WebM; `"gif"` →
 *   annotated GIF; `"off"` → nothing. Motion is the artifact regardless of trigger.
 * - **`logic`** — `evidence.logic` (default `"test-summary"`) → the §2
 *   verification-gate summary; `"full-output"` → the raw output; `"off"` → nothing.
 *
 * The plan's `attachTo` echoes `evidence.attachTo` so the caller knows whether to
 * attach to the PR (ProofShot-style comment), the tracker (`externalUrls` via the
 * adapter's `attachEvidence`), or both — *except* when nothing was captured, in
 * which case `attachTo` is `[]` (there is no bundle to attach).
 *
 * This is a **pure selector**: it does not record, upload, or call a tracker. The
 * skill (v1) or the P5 server pipeline (DOR-95) executes the returned plan; the
 * plan is identical across both.
 *
 * @param kind - The change surface VERIFY is proving (`ui` | `temporal` | `logic`).
 * @param trigger - The trigger that started the run (its live-session flag).
 * @param evidence - The resolved `evidence` config block.
 * @returns The evidence plan: the capture format + producing tool + attach targets.
 */
export function selectEvidence(
  kind: EvidenceKind,
  trigger: EvidenceTrigger,
  evidence: EvidenceConfig
): EvidencePlan {
  const resolved =
    kind === 'ui'
      ? selectUiCapture(evidence.ui, trigger)
      : kind === 'temporal'
        ? selectTemporalCapture(evidence.temporal)
        : selectLogicCapture(evidence.logic);

  // Nothing captured → nothing to attach, even if attachTo lists targets.
  const attachTo: EvidenceTarget[] = resolved.capture === 'none' ? [] : [...evidence.attachTo];

  return { kind, ...resolved, attachTo };
}

#!/usr/bin/env node

/**
 * Stop hook for the `/flow` autonomous terminal-drain loop (`/flow auto`).
 *
 * This is the unified loop hook that REPLACES the legacy `autonomous-check.mjs`
 * (the Ralph-Wiggum Stop-loop that read `roadmap/roadmap.json`). It reads the
 * canonical `/flow` active-run state instead of a roadmap file — there is no
 * `roadmap/roadmap.json` dependency anywhere.
 *
 * ## Mode orthogonality (spec §2)
 *
 * Trigger source (manual CLI vs PM-driven) is ORTHOGONAL to execution mode
 * (step vs autonomous):
 *
 * |              | Step (run one stage, stop)        | Autonomous (run to a gate)                       |
 * | ------------ | --------------------------------- | ------------------------------------------------ |
 * | Manual (CLI) | `/flow:specify`, `/flow:execute`  | `/flow auto` — drain the ready queue (THIS hook) |
 * | PM-driven    | rare; explicit single-stage advance | default — a Pulse tick claims + carries an issue |
 *
 * This hook governs ONLY the manual-autonomous cell (`/flow auto`): keep the
 * terminal session alive while a `/flow auto` drain still has ready work. The
 * PM-driven autonomous cell is the Pulse seat (a fresh session per tick, §10) —
 * it does not depend on this Stop hook at all.
 *
 * ## FAIL OPEN — the safety contract (read twice)
 *
 * This hook runs on EVERY session's Stop, including the orchestrator's own and
 * every unrelated session. It MUST be a strict NO-OP (exit 0 = allow stop)
 * unless a `/flow auto` run is EXPLICITLY active. "Active" is signalled by the
 * sentinel file {@link AUTO_RUN_PATH} (`.dork/flow/auto-run.json`), which
 * `/flow auto` writes on start and deletes on completion/abort. With no
 * sentinel — the normal case for every session — this hook ALWAYS exits 0.
 * Getting this wrong would trap every session in an infinite loop, so the
 * decision is a pure, tested function ({@link decideStop}) that defaults to
 * `allow-stop` on every absent/unreadable/malformed/disabled input.
 *
 * Exit codes:
 * - 0: Allow stop (no active `/flow auto` run, explicit stop/abort signal, or
 *      the drain is complete — the queue is empty / parked on a gate).
 * - 2: Block stop (an active `/flow auto` run reports ready work remaining).
 *
 * Completion signals (override the sentinel — always allow stop):
 * - <promise>PHASE_COMPLETE:<phase></promise>
 * - <promise>ABORT</promise>
 *
 * @module .claude/hooks/flow-loop
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The `/flow auto` active-run sentinel. `/flow auto` writes it on start and
 * removes it on completion/abort. Its presence + `active: true` + `ready > 0` is
 * the ONLY condition under which this hook blocks a stop. Path is relative to the
 * repo root (the hook is invoked from there via the settings.json `cd` prefix).
 *
 * This is the auto-run drain sentinel — a DISTINCT artifact from the per-issue
 * durable `flow-state.json` run record (the session↔issue association, task 3.3).
 * The Pulse seat (task 2.5) and the recovery ladder (task 3.3) read their own
 * state; this file exists only to gate the terminal-drain Stop hook.
 *
 * Shape (all fields optional — the decision fails open on any absence):
 * ```json
 * { "active": true, "ready": 3, "shapeable": 0, "startedAt": "2026-06-14T…Z", "pid": 12345 }
 * ```
 * - `active` — whether a `/flow auto` drain is in progress. `false`/absent → allow stop.
 * - `ready`  — count of ready, eligible issues still to drain (from
 *              `classifyDispatchOutcome().eligibleCount`). `0`/absent → no eligible work.
 * - `shapeable` — OPTIONAL count of dispatchable-category items still behind the
 *              `agent/ready` gate (`classifyDispatchOutcome().shapeableCount`). When
 *              `ready <= 0` and `shapeable > 0` the queue is STARVED (it needs a triage
 *              pass), not done: the hook still allows the stop but says so in the reason.
 *              `0`/absent: the drain is genuinely done.
 */
const AUTO_RUN_RELATIVE_PATH = join('.dork', 'flow', 'auto-run.json');

/** Marker that ends a phase cleanly — the orchestrator emitted it; allow stop. */
const PHASE_COMPLETE_MARKER = '<promise>PHASE_COMPLETE:';
/** Marker that aborts the drain — the operator emitted it; allow stop. */
const ABORT_MARKER = '<promise>ABORT</promise>';

/**
 * The pure stop decision — exported and dependency-free so the fail-open
 * invariant is unit-testable without spawning the hook. Returns whether to allow
 * the session to stop (exit 0) or block it to continue draining (exit 2).
 *
 * Fails OPEN on EVERY uncertain input: an explicit completion/abort signal, an
 * absent sentinel, a sentinel that is not an active run, or one with no ready
 * work all yield `allow-stop`. The ONLY path that blocks is an explicitly active
 * `/flow auto` run reporting `ready > 0` with no completion signal in the output.
 *
 * @param output - Claude's Stop-event output (stdin), scanned for promise markers.
 * @param autoRun - The parsed sentinel, or `null` when absent/unreadable/malformed.
 * @returns `'allow-stop'` (exit 0) or `'block-stop'` (exit 2), plus a reason.
 */
export function decideStop(output, autoRun) {
  // Explicit signals win over everything — the orchestrator/operator said stop.
  if (output.includes(PHASE_COMPLETE_MARKER)) {
    return { decision: 'allow-stop', reason: 'phase-complete signal' };
  }
  if (output.includes(ABORT_MARKER)) {
    return { decision: 'allow-stop', reason: 'abort signal' };
  }

  // No sentinel (the normal case for every session) → strict no-op, allow stop.
  if (autoRun === null || typeof autoRun !== 'object') {
    return { decision: 'allow-stop', reason: 'no active /flow auto run' };
  }

  // Sentinel present but not an active drain → allow stop.
  if (autoRun.active !== true) {
    return { decision: 'allow-stop', reason: 'sentinel present but not active' };
  }

  // Active drain, but the ready queue is empty. Distinguish a STARVED queue
  // (shapeable work waiting behind the agent/ready gate, needs a triage pass)
  // from a genuinely DRAINED one. Both ALLOW the stop (a terminal drain cannot
  // triage itself), but the reason tells the operator what to do next instead of
  // the misleading "drain complete".
  const ready = typeof autoRun.ready === 'number' ? autoRun.ready : 0;
  if (ready <= 0) {
    const shapeable = typeof autoRun.shapeable === 'number' ? autoRun.shapeable : 0;
    if (shapeable > 0) {
      return {
        decision: 'allow-stop',
        reason: `drain starved: ${shapeable} shapeable item(s) need triage (/flow:triage)`,
      };
    }
    return { decision: 'allow-stop', reason: 'drain complete — no ready work remaining' };
  }

  // The one blocking path: an explicitly active /flow auto run with ready work.
  return { decision: 'block-stop', reason: `${ready} ready issue(s) remaining` };
}

/**
 * Read and parse the active-run sentinel. Returns `null` on ANY problem
 * (missing file, unreadable, malformed JSON) so the caller fails open. Never
 * throws.
 *
 * @param cwd - The directory the sentinel path resolves against (repo root).
 * @returns The parsed sentinel object, or `null` to fail open.
 */
function readAutoRun(cwd) {
  try {
    const raw = readFileSync(join(cwd, AUTO_RUN_RELATIVE_PATH), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    // Missing/unreadable/malformed → fail open (no active run).
    return null;
  }
}

/**
 * Read Claude's Stop-event output from stdin with a hard timeout so the hook
 * never hangs a session. Resolves with whatever arrived if stdin does not close.
 *
 * @returns The collected stdin text.
 */
async function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    let resolved = false;

    const done = () => {
      if (resolved) return;
      resolved = true;
      process.stdin.removeAllListeners();
      process.stdin.unref();
      resolve(data);
    };

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
    // Hard timeout — proceed with what we have if stdin stays open.
    setTimeout(done, 500).unref();
  });
}

/** Print the block message box, mirroring the legacy hook's affordances. */
function printBlockMessage(reason) {
  console.error('');
  console.error('┌─────────────────────────────────────────────────────────────┐');
  console.error('│  /flow auto — DRAINING THE READY QUEUE                       │');
  console.error('├─────────────────────────────────────────────────────────────┤');
  console.error(`│  ${reason.padEnd(58)} │`);
  console.error('├─────────────────────────────────────────────────────────────┤');
  console.error('│  To stop: output <promise>ABORT</promise>                   │');
  console.error('│  Or finish the active /flow auto drain                      │');
  console.error('└─────────────────────────────────────────────────────────────┘');
  console.error('');
}

async function main() {
  const cwd = process.cwd();
  const output = await readStdin();
  const autoRun = readAutoRun(cwd);
  const { decision, reason } = decideStop(output, autoRun);

  if (decision === 'block-stop') {
    printBlockMessage(reason);
    process.exit(2);
  }

  // Fail open — allow the session to stop. The common case is silent; only an
  // explicitly-resolved active drain announces why it let go.
  if (autoRun?.active === true) {
    console.error(`[flow-loop] allowing stop — ${reason}`);
  }
  process.exit(0);
}

// Only run the hook when invoked directly, not when imported by a test.
const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  main();
}

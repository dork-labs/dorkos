/**
 * Regression guard for DOR-1773: a demo scenario's approval/elicitation copy
 * must never name a specific fleet agent, because every `demo-*` scenario in
 * `demo-scenarios.ts` is reused across several agent identities by the
 * product-capture drives (`apps/e2e/capture/surfaces-*.ts`) — the card's
 * TITLE is always built from the real session agent, so a body that hardcodes
 * a different name reads as the card disagreeing with itself the moment the
 * scenario runs under any agent but the one it was written against.
 *
 * The banned-name list is read from the fleet the capture pipeline actually
 * seeds (`apps/e2e/capture/config.ts`'s `FLEET`), not hardcoded here, so a
 * fleet roster change never leaves this guard silently checking a stale list.
 *
 * @module services/runtimes/test-mode/__tests__/demo-scenarios
 */
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it, vi } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import type { ScenarioContext } from '../interaction-gate.js';

// Every `delay()` in the demo scenarios paces a marketing recording — this
// guard only cares about emitted TEXT, so collapsing every wait to an
// immediate resolve keeps the suite fast regardless of how many scenarios or
// beats a future scenario adds. `streamText` gets its own fast stand-in
// rather than inheriting the real one: it paces itself with a call to this
// same module's OWN internal `delay` binding, a reference `vi.mock` cannot
// reach by overriding the named export alone — only what OTHER modules
// import, never a module's self-reference to its own local function.
vi.mock('../demo-scenario-shared.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../demo-scenario-shared.js')>();
  return {
    ...actual,
    delay: () => Promise.resolve(),
    streamText: async function* (body: string): AsyncGenerator<StreamEvent> {
      yield { type: 'text_delta', data: { text: body } } as StreamEvent;
    },
  };
});

const CONFIG_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../../e2e/capture/config.ts'
);

/**
 * Every name the fleet answers to, read from the capture harness's own config
 * rather than duplicated here — the block between `FLEET: readonly
 * FleetAgent[] = [` and its closing `];` is where the roster's `name`s and
 * `displayName`s live. Both matter: the UI renders the lowercase slug
 * (`name: 'scout'` → "scout wants to edit…", `whoOf`/`agentNameFromCwd`), not
 * the capitalized `displayName` — a copy check against `displayName` alone
 * would wave through the exact bug this guards spelled in lowercase.
 */
function readFleetNames(): string[] {
  const source = readFileSync(CONFIG_PATH, 'utf-8');
  const fleetBlock = source.match(/FLEET: readonly FleetAgent\[\] = \[([\s\S]*?)\n\];/);
  if (!fleetBlock) {
    throw new Error(
      `could not find the FLEET array in ${CONFIG_PATH} — has it moved or been renamed?`
    );
  }
  const block = fleetBlock[1]!;
  // `^\s*name:` (anchored, multiline) so this never also matches `displayName:`
  // — both end in `name:`, and an unanchored match would double-count it.
  const names = [...block.matchAll(/^\s*name:\s*'([^']+)'/gm)].map((m) => m[1]!);
  const displayNames = [...block.matchAll(/displayName:\s*'([^']+)'/g)].map((m) => m[1]!);
  if (names.length === 0) {
    throw new Error(`found the FLEET array in ${CONFIG_PATH} but no name entries in it`);
  }
  if (displayNames.length === 0) {
    throw new Error(`found the FLEET array in ${CONFIG_PATH} but no displayName entries in it`);
  }
  return [...new Set([...names, ...displayNames])];
}

/** Every string value nested anywhere inside an event's `data` payload. */
function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
  } else if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) collectStrings(nested, out);
  }
}

describe('demo scenario approval/elicitation copy names no fleet agent', () => {
  const fleetNames = readFleetNames();

  it("read a non-empty fleet roster from the capture harness's config", () => {
    // A guard against the guard: if `readFleetNames` ever silently returned
    // nothing (a FLEET reshape it can no longer parse), every assertion below
    // would vacuously pass. This keeps that failure loud, and pins BOTH
    // casings so a regression in just one half (e.g. `name` stops being
    // extracted) fails here instead of silently narrowing what's checked.
    expect(fleetNames.length).toBeGreaterThan(0);
    expect(fleetNames).toEqual(expect.arrayContaining(['Atlas', 'atlas']));
  });

  it('never names a fleet agent in approval or elicitation copy', async () => {
    const { DEMO_SCENARIOS } = await import('../demo-scenarios.js');
    const ctx = {} as ScenarioContext;
    const offenses: string[] = [];

    for (const [scenarioName, run] of Object.entries(DEMO_SCENARIOS)) {
      for await (const event of run('', ctx, undefined)) {
        if (event.type !== 'approval_required' && event.type !== 'elicitation_prompt') continue;
        const strings: string[] = [];
        collectStrings((event as { data: unknown }).data, strings);
        const blob = strings.join('\n');
        for (const name of fleetNames) {
          // Case-insensitive: the UI renders the lowercase `name` slug
          // ("scout wants to edit…"), not just the capitalized `displayName`.
          if (new RegExp(`\\b${name}\\b`, 'i').test(blob)) {
            offenses.push(`${scenarioName} (${event.type}) names "${name}": ${blob}`);
          }
        }
      }
    }

    expect(offenses).toEqual([]);
  });
});

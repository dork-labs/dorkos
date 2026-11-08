/**
 * Sealed: what the turn-context record holds for a Doe turn is byte-equal to
 * the system channel the engine was handed. A fake engine and a model nobody
 * calls: no network, no key.
 *
 * Doe wraps DorkOS's text in its own fixed business header, so the engine's
 * prompt is that header, the host profile, and then exactly the recorded text.
 * The turn carries a refused approval, whose reason is fenced with a fresh
 * nonce every render, so a record built by rendering again cannot match.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AdditionalContext } from '@dorkos/shared/additional-context';
import { createTestDb } from '@dorkos/test-utils/db';
import { makeRuntime, projectDir, requests, collect } from './runtime-fixture.js';
import { renderDoeContextEntry } from '../context.js';
import { setTurnContextStore } from '../../../session/turn-context/record-turn-context.js';
import { TurnContextStore } from '../../../session/turn-context/turn-context-store.js';

/** A refusal whose reason rides a nonced fence: a fresh nonce on every render. */
const VERDICT: AdditionalContext = [
  {
    kind: 'approval_verdict',
    scope: 'per-turn',
    data: {
      approvalId: 'appr-made-up',
      capabilityTitle: 'Send a made-up email',
      outcome: 'denied',
      endedAt: '2026-11-08T00:00:00.000Z',
      denyReason: 'Made-up background for the test.',
    },
  },
];

/** Where Doe's own header ends and the host's text begins. */
const PROFILE_END = '</host_profile>\n';

let store: TurnContextStore;
beforeEach(() => {
  store = new TurnContextStore(createTestDb());
  setTurnContextStore(store);
});
afterEach(() => setTurnContextStore(null));

it('records the exact system channel the engine received, and the words', async () => {
  const runtime = makeRuntime();
  const id = randomUUID();
  runtime.ensureSession(id, { cwd: projectDir, permissionMode: 'default' });
  const before = requests.length;
  await collect(
    runtime.sendMessage(id, 'Hello Doe', {
      cwd: projectDir,
      permissionMode: 'default',
      additionalContext: VERDICT,
      messageId: 'm-1',
    })
  );

  const records = store.listForSession(id);
  expect(records).toHaveLength(1);
  const [record] = records;
  expect(record).toMatchObject({
    runtime: 'doe',
    place: 'chat',
    messageId: 'm-1',
    permissionMode: 'default',
    systemSentThisTurn: true,
  });
  expect(record!.parts.map((part) => part.slot)).toEqual(['system', 'message']);
  expect(record!.parts[1]!.body).toBe('Hello Doe');

  const system = record!.parts[0]!.body!;
  const prompt = requests[before]!.prompt;
  const hostStart = prompt.indexOf(PROFILE_END) + PROFILE_END.length;
  expect(hostStart).toBeGreaterThan(PROFILE_END.length);
  // Byte-equal: everything after Doe's own header is exactly the recorded text.
  expect(prompt.slice(hostStart)).toBe(system);
  expect(record!.parts[0]!.redacted).toBe(false);

  // The mutant: rendering the verdict block again gives a fresh nonce, which the
  // record does not hold, so a record rebuilt that way fails the check above.
  const again = renderDoeContextEntry(VERDICT[0]!);
  expect(system).toContain('Made-up background for the test.');
  expect(system).not.toContain(again);
});

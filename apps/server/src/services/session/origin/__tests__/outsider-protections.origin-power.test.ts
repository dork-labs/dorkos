/**
 * Pins a protection Dorian kept in the trusted-by-default reset (DOR-2735). If
 * this fails after a default flip, the flip leaked power to outsiders — fix the
 * flip, not this test.
 *
 * The protection: a session woken by somebody OFF this machine is born with no
 * power of its own, however much power the operator has handed their own
 * agents. A Telegram or Slack stranger behind a binding, a webhook, an inbound
 * connector event (an email), a bridged room message, and an installed
 * extension's app data all seed nothing onto the session row. And a chat born
 * that way cannot use `session_start` to launch a child that is more powerful
 * than itself (ADR 261004-235818).
 *
 * `turn-origin.test.ts` pins the mapping table itself. What only this file
 * asks is the composed question the reset puts at risk: with the MOST
 * permissive settings this install can hold — Full autonomy as the standing
 * stop on every runtime, the autonomy acknowledgement on file, the Full preset
 * with every area set to Allowed — does an outsider-origin row STILL come out
 * empty? A flip implemented as "every new session starts at autonomy" would
 * pass the table test and fail this one.
 *
 * Deliberately NOT pinned here, because the reset may legitimately widen them:
 * `agent-dm` (one of our agents DMing another), `agent-launch` (our own
 * `session_start`), `schedule` and the `account-*` carry-overs. An A2A peer
 * arrives on the `agent-dm` origin today and is told apart only by its
 * envelope sender; that path is pinned at the relay adapter, in
 * `packages/relay/src/adapters/claude-code/__tests__/outsider-protections.a2a-turn.test.ts`.
 *
 * Nothing that matters is mocked: the real config manager over a temp
 * `DORK_HOME`, the real `RuntimeRegistry` over a real SQLite db, and the real
 * `resolveStartPermission`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { createTestDb } from '@dorkos/test-utils/db';
import { PERMISSION_AREA_IDS } from '@dorkos/shared/permissions';
import type { TurnOrigin } from '../turn-origin.js';

/** Every turn origin that carries words from somebody off this machine. */
const OUTSIDER_ORIGINS: ReadonlyArray<readonly [string, TurnOrigin]> = [
  // A Telegram/Slack chat or a webhook, through a binding.
  ['a chat binding (Telegram, Slack, webhook)', { kind: 'relay-binding' }],
  // An inbound connector event, e.g. a new email.
  ['a connector event (incoming email)', { kind: 'connector-event' }],
  // A bridged chat message that landed in a room.
  ['a room message from off this machine', { kind: 'room', externalAuthor: true }],
  // An installed extension's app data sent to an agent.
  ['an extension message (app data)', { kind: 'extension-message' }],
];

const STAMP = '2026-10-06T09:00:00.000Z';

describe('outsider-origin sessions seed no power, even at the most permissive settings', () => {
  let tmpDir: string;
  let fake: FakeAgentRuntime;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-outsider-origin-'));
    process.env.DORK_HOME = tmpDir;

    const config = await import('../../../core/config-manager.js');
    config.initConfigManager(tmpDir);
    // A live binding: `initConfigManager` assigns the exported singleton.
    const { configManager } = config;

    // The most permissive posture that exists today, written straight into the
    // store: no door, no ritual, nothing left asking.
    configManager.set('ui', {
      ...configManager.get('ui'),
      fullPowerDecidedAt: STAMP,
      fullPowerChoice: 'full',
    });
    const runtimes = configManager.get('runtimes');
    configManager.set('runtimes', {
      ...runtimes,
      defaultTrustStop: 'autonomy',
      claudeCode: { ...runtimes.claudeCode, defaultTrustStop: 'autonomy' },
      codex: { ...runtimes.codex, defaultTrustStop: 'autonomy' },
      opencode: { ...runtimes.opencode, defaultTrustStop: 'autonomy' },
    });
    configManager.set('permissions', {
      ...configManager.get('permissions'),
      preset: 'full',
      defaults: {
        areas: Object.fromEntries(PERMISSION_AREA_IDS.map((area) => [area, 'allowed'])),
        actions: {},
      },
    });

    const { runtimeRegistry } = await import('../../../core/runtime-registry.js');
    fake = new FakeAgentRuntime();
    runtimeRegistry.register(fake);
    runtimeRegistry.setDefault('fake');
    runtimeRegistry.setDb(createTestDb());
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.resetModules();
  });

  /** The id the fake runtime gives its Full-autonomy stop. */
  function autonomyModeId(): string {
    const found = fake.getCapabilities().permissionModes.values.find((d) => d.stop === 'autonomy');
    if (!found) throw new Error('the fake runtime declares no autonomy stop');
    return found.id;
  }

  async function registry() {
    return (await import('../../../core/runtime-registry.js')).runtimeRegistry;
  }

  it('really is the most permissive posture: a person’s own chat is born at Full autonomy', async () => {
    // The control. Without it every assertion below could pass on an install
    // that simply never seeds anything.
    const reg = await registry();
    await reg.persistSessionRuntime('control-person', 'fake', { kind: 'interactive' });
    expect((await reg.getSessionSettings('control-person'))?.permissionMode).toBe(autonomyModeId());
  });

  it.each(OUTSIDER_ORIGINS)('%s: a new row is born with no power', async (_label, origin) => {
    const reg = await registry();
    const id = `insert-${origin.kind}`;
    await reg.persistSessionRuntime(id, 'fake', origin);
    expect((await reg.getSessionSettings(id))?.permissionMode).toBeUndefined();
  });

  it.each(OUTSIDER_ORIGINS)(
    '%s: claiming a row a settings change left behind seeds nothing either',
    async (_label, origin) => {
      // An unbound row (a pre-launch settings change, DOR-812) is the other way
      // a seed reaches a session. An outsider's turn must not use it as a door.
      const reg = await registry();
      const id = `claim-${origin.kind}`;
      await reg.saveSessionSettings(id, { model: 'sonnet' });
      await reg.persistSessionRuntime(id, 'fake', origin);
      expect((await reg.getSessionSettings(id))?.permissionMode).toBeUndefined();
    }
  );

  describe('session_start from an outsider-origin chat (ADR 261004-235818)', () => {
    async function startFrom(origin: TurnOrigin, chatMode: string | null, requested?: string) {
      const reg = await registry();
      const id = `starter-${origin.kind}-${chatMode ?? 'none'}`;
      await reg.persistSessionRuntime(id, 'fake', origin);
      const { resolveStartPermission } =
        await import('../../../runtimes/claude-code/mcp-tools/session-start-permission.js');
      return resolveStartPermission(
        requested,
        { sessionId: id, permissionMode: chatMode, runtime: 'fake' },
        'fake'
      );
    }

    it('cannot launch a Full-autonomy child from a binding chat running in its prompting mode', async () => {
      // The binding schema's default mode is `default`, the one that asks.
      const result = await startFrom({ kind: 'relay-binding' }, 'default', autonomyModeId());
      expect(result).toMatchObject({ ok: false, code: 'ABOVE_YOUR_LEVEL' });
    });

    it.each(OUTSIDER_ORIGINS)(
      '%s: with no live mode, the empty row it was born with is no ladder either',
      async (_label, origin) => {
        // No live mode: the ceiling falls back to the stored row, which the
        // outsider origin left empty, so the runtime's own default (or the
        // read-only floor) decides. Never the operator's autonomy stop.
        const result = await startFrom(origin, null, autonomyModeId());
        expect(result.ok).toBe(false);
      }
    );

    it('cannot launch a child that edits on its own from a chat that asks first', async () => {
      const result = await startFrom({ kind: 'connector-event' }, 'default', 'acceptEdits');
      expect(result).toMatchObject({ ok: false, code: 'ABOVE_YOUR_LEVEL' });
    });
  });
});

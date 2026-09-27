/**
 * The desk guard for a folder a relay payload names (spec `agent-home-desk`
 * §3.4). Real folders and a wired registry: the claims are about which folder
 * is whose.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTurnDeskCheck } from '../turn-desk-check.js';
import { clearTestHomes, registerTestHomes } from './agent-home-fixture.js';

describe('createTurnDeskCheck', () => {
  let scratch: string;
  let a: string;
  let b: string;
  let roomsDir: string;

  beforeAll(() => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'turn-desk-check-')));
    a = path.join(scratch, 'agents', 'a');
    b = path.join(scratch, 'agents', 'b');
    roomsDir = path.join(scratch, 'dork', 'rooms');
    for (const dir of [a, b, path.join(roomsDir, 'r1', 'repo'), path.join(a, 'src')]) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });

  afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));
  afterEach(() => clearTestHomes());

  const check = (bound: string | null = null) =>
    createTurnDeskCheck({
      sessionAgentPath: async () => bound,
      placementOf: async (agentPath) => ({ cwd: agentPath, rung: 'agent-home' }),
    });

  it('refuses a sender-named room folder and another agent`s home for the answering agent', async () => {
    registerTestHomes([a, b], { roomsDir });

    const inRoom = await check()({
      cwd: path.join(roomsDir, 'r1', 'repo'),
      agentDirectory: b,
      forAgent: undefined,
      sessionKey: 's',
    });
    const inA = await check()({ cwd: a, agentDirectory: b, forAgent: undefined, sessionKey: 's' });

    expect(inRoom).toContain('room');
    expect(inA).toContain('belongs to another agent');
  });

  it('lets the answering agent stand in its own home', async () => {
    registerTestHomes([a, b], { roomsDir });

    await expect(
      check()({ cwd: b, agentDirectory: b, forAgent: undefined, sessionKey: 's' })
    ).resolves.toBeNull();
  });

  it('refuses a payload that names a different agent than the server knows', async () => {
    registerTestHomes([a, b], { roomsDir });

    await expect(
      check()({ cwd: a, agentDirectory: b, forAgent: a, sessionKey: 's' })
    ).resolves.toContain('different agent');
    // The session's recorded agent outranks the payload the same way.
    await expect(
      check(b)({ cwd: a, agentDirectory: undefined, forAgent: a, sessionKey: 's' })
    ).resolves.toContain('different agent');
  });

  it('refuses a turn that names no agent but stands in an agent`s folder or a room', async () => {
    registerTestHomes([a, b], { roomsDir });

    for (const cwd of [a, path.join(a, 'src'), path.join(roomsDir, 'r1', 'repo')]) {
      await expect(
        check()({ cwd, agentDirectory: undefined, forAgent: undefined, sessionKey: 's' })
      ).resolves.not.toBeNull();
    }
    await expect(
      check()({
        cwd: path.join(scratch, 'plain'),
        agentDirectory: undefined,
        forAgent: undefined,
        sessionKey: 's',
      })
    ).resolves.toBeNull();
  });

  it('reads the desk the way the binding router does: a boundary-refused agent works in the default folder', async () => {
    // The chain answered `default` with a degraded reason — the agent's home is
    // outside what this server may touch. The router lets that turn stand in the
    // default folder, so a relay turn there must pass too; reading the binding
    // off the manifest instead (`home`) refused it. Seeded: passing `home`
    // instead of `deskBindingFor(placement)` reddens this.
    registerTestHomes([a, b], { roomsDir });
    const defaultFolder = path.join(scratch, 'default');
    fs.mkdirSync(defaultFolder, { recursive: true });
    const refusedHome = createTurnDeskCheck({
      sessionAgentPath: async () => null,
      placementOf: async () => ({ cwd: defaultFolder, rung: 'default', degraded: 'boundary' }),
    });

    await expect(
      refusedHome({ cwd: defaultFolder, agentDirectory: b, forAgent: undefined, sessionKey: 's' })
    ).resolves.toBeNull();
    // Still only THAT folder: somewhere else plain is not its desk.
    await expect(
      refusedHome({
        cwd: path.join(scratch, 'elsewhere'),
        agentDirectory: b,
        forAgent: undefined,
        sessionKey: 's',
      })
    ).resolves.not.toBeNull();
  });
});

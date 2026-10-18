/**
 * An agent computer's instance key comes from a file the server alone can
 * read, never from the environment (DOR-2940 part 9): one case per refusal,
 * the happy path, and what loading the module does to the environment.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

type Role = 'computer' | 'hub' | 'agent-computer';
const role = vi.hoisted(() => ({ value: 'agent-computer' as Role }));
vi.mock('../../../../lib/server-role.js', () => ({ currentServerRole: () => role.value }));

const KEY = 'computer-key-0123456789';
const SLOT = Symbol.for('dorkos.env.agentComputerInstanceKey');
const slot = globalThis as typeof globalThis & { [SLOT]?: string };
const UID = process.getuid!();

const { AgentComputerKeyError, agentComputerInstanceKey, loadAgentComputerInstanceKey } =
  await import('../instance-key.js');

let dir: string;
beforeEach(async () => {
  role.value = 'agent-computer';
  delete slot[SLOT];
  dir = await mkdtemp(path.join(tmpdir(), 'agent-computer-key-'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  delete slot[SLOT];
  await rm(dir, { recursive: true, force: true });
});

/** A key file holding `content` at `mode`. */
async function keyFile(content = `${KEY}\n`, mode = 0o600): Promise<string> {
  const file = path.join(dir, 'instance-key');
  await writeFile(file, content);
  await chmod(file, mode);
  return file;
}

/** The problem loading from `keyFile` (with nothing in the environment) refuses with. */
function problemOf(file: string | undefined, uid = UID): string | null {
  try {
    loadAgentComputerInstanceKey({ keyInEnvironment: false, keyFile: file }, uid);
    return null;
  } catch (err) {
    expect(err).toBeInstanceOf(AgentComputerKeyError);
    return (err as InstanceType<typeof AgentComputerKeyError>).problem;
  }
}

describe('loading an agent computer`s instance key', () => {
  it('refuses to start when the key is in the environment at all', async () => {
    const file = await keyFile();
    expect(() =>
      loadAgentComputerInstanceKey({ keyInEnvironment: true, keyFile: file }, UID)
    ).toThrow(/must not be set on an agent computer/);
    expect(slot[SLOT]).toBeUndefined();
  });

  it('refuses a missing path, and a path that names nothing', () => {
    expect(problemOf(undefined)).toBe('no-file');
    expect(problemOf('  ')).toBe('no-file');
    expect(problemOf(path.join(dir, 'nothing-here'))).toBe('no-file');
  });

  it('refuses a relative path', () => {
    expect(problemOf('instance-key')).toBe('relative-path');
  });

  it('refuses a symbolic link, even to a good key file, and a folder', async () => {
    const link = path.join(dir, 'link');
    await symlink(await keyFile(), link);
    expect(problemOf(link)).toBe('not-a-file');
    expect(problemOf(dir)).toBe('not-a-file');
  });

  it('refuses a file group or others may read or write', async () => {
    expect(problemOf(await keyFile(`${KEY}\n`, 0o640))).toBe('open-to-others');
    expect(problemOf(await keyFile(`${KEY}\n`, 0o604))).toBe('open-to-others');
    expect(problemOf(await keyFile(`${KEY}\n`, 0o620))).toBe('open-to-others');
  });

  it('refuses a file owned by another user', async () => {
    expect(problemOf(await keyFile(), UID + 1)).toBe('wrong-owner');
  });

  it('refuses a key shorter than sixteen characters', async () => {
    expect(problemOf(await keyFile('fifteen-chars-x\n'))).toBe('too-short');
    expect(problemOf(await keyFile(''))).toBe('too-short');
  });

  it('fills the slot from a 0600 file it owns, dropping one trailing newline', async () => {
    expect(problemOf(await keyFile())).toBeNull();
    expect(slot[SLOT]).toBe(KEY);
    expect(agentComputerInstanceKey()).toBe(KEY);
  });

  it('does nothing on any other role', async () => {
    role.value = 'computer';
    expect(() =>
      loadAgentComputerInstanceKey({ keyInEnvironment: true, keyFile: undefined }, UID)
    ).not.toThrow();
    expect(agentComputerInstanceKey()).toBeNull();
  });
});

describe('loading the module', () => {
  it('removes both names from the environment, and reads the key from the file', async () => {
    const file = await keyFile();
    vi.stubEnv('DORKOS_AGENT_COMPUTER_INSTANCE_KEY_FILE', file);
    vi.resetModules();
    const fresh = await import('../instance-key.js');

    expect('DORKOS_AGENT_COMPUTER_INSTANCE_KEY_FILE' in process.env).toBe(false);
    expect('DORKOS_AGENT_COMPUTER_INSTANCE_KEY' in process.env).toBe(false);
    expect(slot[SLOT]).toBeUndefined();
    fresh.loadAgentComputerInstanceKey();
    expect(slot[SLOT]).toBe(KEY);
  });

  it('remembers a key set in the environment after removing it, and refuses to start', async () => {
    vi.stubEnv('DORKOS_AGENT_COMPUTER_INSTANCE_KEY', KEY);
    vi.stubEnv('DORKOS_AGENT_COMPUTER_INSTANCE_KEY_FILE', await keyFile());
    vi.resetModules();
    const fresh = await import('../instance-key.js');

    expect('DORKOS_AGENT_COMPUTER_INSTANCE_KEY' in process.env).toBe(false);
    expect(() => fresh.loadAgentComputerInstanceKey()).toThrow(/must not be set/);
    expect(slot[SLOT]).toBeUndefined();
  });
});

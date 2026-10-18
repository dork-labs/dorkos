/**
 * An update on an agent computer to a version that does not work on a cloud
 * agent is refused BEFORE the uninstall half (DOR-2940 part 9), so the old
 * version stays installed. Drives the real installer, flows and transaction.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type Role = 'computer' | 'hub' | 'agent-computer';
const role = vi.hoisted(() => ({ value: 'agent-computer' as Role }));
vi.mock('../../../lib/server-role.js', () => ({ currentServerRole: () => role.value }));

const { initBoundary } = await import('../../../lib/boundary.js');
const { buildInstallerForTests } = await import('./installer-harness.js');
const { readInstalledFiles } = await import('../lib/records/installed-files.js');
const { CloudAgentUnsupportedError } = await import('../installer/errors.js');

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const SHIPPED = '.dork/tasks/sample-task/SKILL.md';

let dorkHome: string;
beforeEach(async () => {
  role.value = 'agent-computer';
  dorkHome = await mkdtemp(path.join(tmpdir(), 'agent-computer-update-'));
});
afterEach(async () => {
  await initBoundary(FIXTURES_DIR);
  await rm(dorkHome, { recursive: true, force: true });
});

/** A writable copy of the plugin fixture, inside the boundary. */
async function pluginSource(): Promise<string> {
  const source = path.join(dorkHome, 'src', 'valid-plugin');
  await cp(path.join(FIXTURES_DIR, 'valid-plugin'), source, { recursive: true });
  await initBoundary(path.dirname(dorkHome));
  return source;
}

/** Give the source a hook, which only Claude Code runs. */
async function addHook(source: string): Promise<void> {
  await mkdir(path.join(source, 'hooks'), { recursive: true });
  await writeFile(
    path.join(source, 'hooks', 'hooks.json'),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] } })
  );
}

describe('an update on an agent computer', () => {
  it('refuses a v2 that does not work on a cloud agent, leaving v1 on disk', async () => {
    const source = await pluginSource();
    const harness = buildInstallerForTests(dorkHome);
    const { installPath: root } = await harness.installer.install({ name: source });
    const before = await readFile(path.join(root, SHIPPED), 'utf8');

    await addHook(source);
    await expect(harness.installer.update({ name: source })).rejects.toBeInstanceOf(
      CloudAgentUnsupportedError
    );

    expect(await readFile(path.join(root, SHIPPED), 'utf8')).toBe(before);
    const record = await readInstalledFiles(root);
    expect(record?.uninstalledAt).toBeUndefined();
    expect(record?.files[SHIPPED]).toBeDefined();
  });

  it('updates as before on a person`s own computer', async () => {
    role.value = 'computer';
    const source = await pluginSource();
    const harness = buildInstallerForTests(dorkHome);
    await harness.installer.install({ name: source });
    await addHook(source);
    await expect(harness.installer.update({ name: source })).resolves.toMatchObject({ ok: true });
  });
});

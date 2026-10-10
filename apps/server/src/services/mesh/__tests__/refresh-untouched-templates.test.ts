import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createHash } from 'crypto';
import { writeManifest } from '@dorkos/shared/manifest';
import { buildSoulContent, defaultSoulTemplate } from '@dorkos/shared/convention-files';
import { renderTraits, DEFAULT_TRAITS } from '@dorkos/shared/trait-renderer';
import { dorkbotClaudeMdTemplate } from '@dorkos/shared/dorkbot-templates';
import {
  PREVIOUS_DORKBOT_AGENTS_MD,
  PREVIOUS_SOUL_PROSE,
  refreshSoulContent,
  refreshUntouchedTemplates,
} from '../refresh-untouched-templates.js';

/** sha256 prefixes of each old template, computed from git history, not from the lists. */
const DORKBOT_FINGERPRINTS = ['8bbbe607e61c6a24', '37db35aff4b2fb6f', '88bc13eeede41a76'];
const SOUL_FINGERPRINTS = ['0ae265f490efe529'];

/** A SOUL.md exactly as a pre-2026-10 DorkOS wrote it, traits as given. */
function oldSoul(name: string, traits = DEFAULT_TRAITS): string {
  return buildSoulContent(renderTraits(traits), PREVIOUS_SOUL_PROSE[0].replace('{{name}}', name));
}

describe('refreshUntouchedTemplates', () => {
  let dorkHome: string;
  let dorkbotDir: string;

  beforeEach(async () => {
    dorkHome = await fs.mkdtemp(path.join(os.tmpdir(), 'template-refresh-'));
    dorkbotDir = path.join(dorkHome, 'agents', 'dorkbot');
    await fs.mkdir(path.join(dorkbotDir, '.dork'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(dorkHome, { recursive: true, force: true });
  });

  /** Make an agent home, named `displayName`, holding the given SOUL.md. */
  async function agentWithSoul(slug: string, soul: string, displayName?: string): Promise<string> {
    const dir = path.join(dorkHome, 'agents', slug);
    await fs.mkdir(path.join(dir, '.dork'), { recursive: true });
    await writeManifest(dir, {
      id: '01JTEMPLATEREFRESH00000000',
      name: slug,
      ...(displayName ? { displayName } : {}),
      runtime: 'claude-code',
      capabilities: [],
      registeredAt: '2026-10-10T00:00:00.000Z',
      registeredBy: 'test',
    } as never);
    await fs.writeFile(path.join(dir, '.dork', 'SOUL.md'), soul);
    return dir;
  }

  const readSoul = (dir: string) => fs.readFile(path.join(dir, '.dork', 'SOUL.md'), 'utf-8');

  it.each(PREVIOUS_DORKBOT_AGENTS_MD.map((t, i) => [i, t]))(
    "updates DorkBot's untouched AGENTS.md (old template %i)",
    async (_i, template) => {
      await fs.writeFile(path.join(dorkbotDir, 'AGENTS.md'), template);

      const summary = await refreshUntouchedTemplates([dorkbotDir], dorkHome);

      expect(summary.dorkbotAgentsMd).toBe(true);
      expect(await fs.readFile(path.join(dorkbotDir, 'AGENTS.md'), 'utf-8')).toBe(
        dorkbotClaudeMdTemplate()
      );
    }
  );

  it("leaves DorkBot's AGENTS.md alone after one edited character", async () => {
    const edited = PREVIOUS_DORKBOT_AGENTS_MD[2].replace('DorkBot,', 'Dorky,');
    await fs.writeFile(path.join(dorkbotDir, 'AGENTS.md'), edited);

    const summary = await refreshUntouchedTemplates([dorkbotDir], dorkHome);

    expect(summary.dorkbotAgentsMd).toBe(false);
    expect(await fs.readFile(path.join(dorkbotDir, 'AGENTS.md'), 'utf-8')).toBe(edited);
  });

  it("leaves DorkBot's AGENTS.md alone when an editor added a trailing newline", async () => {
    const withNewline = `${PREVIOUS_DORKBOT_AGENTS_MD[2]}\n`;
    await fs.writeFile(path.join(dorkbotDir, 'AGENTS.md'), withNewline);

    await refreshUntouchedTemplates([dorkbotDir], dorkHome);

    expect(await fs.readFile(path.join(dorkbotDir, 'AGENTS.md'), 'utf-8')).toBe(withNewline);
  });

  it("updates an untouched SOUL.md's prose and keeps its name and trait block", async () => {
    const traits = { ...DEFAULT_TRAITS, humor: 5 };
    const dir = await agentWithSoul(
      'scout',
      oldSoul('Scout the Second', traits),
      'Scout the Second'
    );

    const summary = await refreshUntouchedTemplates([dir], dorkHome);

    expect(summary.souls).toBe(1);
    expect(await readSoul(dir)).toBe(defaultSoulTemplate('Scout the Second', renderTraits(traits)));
  });

  it('matches the slug when the agent has no display name', async () => {
    const dir = await agentWithSoul('scout', oldSoul('scout'));

    expect((await refreshUntouchedTemplates([dir], dorkHome)).souls).toBe(1);
  });

  it('leaves a SOUL.md alone when the words around the name were edited', async () => {
    const edited = oldSoul('Ada, our release reviewer');
    const dir = await agentWithSoul('ada', edited, 'Ada');

    const summary = await refreshUntouchedTemplates([dir], dorkHome);

    expect(summary.souls).toBe(0);
    expect(await readSoul(dir)).toBe(edited);
  });

  it('leaves a renamed agent alone, the safe way to be wrong', async () => {
    const dir = await agentWithSoul('scout', oldSoul('Scout'), 'Ranger');

    expect((await refreshUntouchedTemplates([dir], dorkHome)).souls).toBe(0);
    expect(await readSoul(dir)).toBe(oldSoul('Scout'));
  });

  it('never follows a symlinked SOUL.md', async () => {
    const dir = await agentWithSoul('scout', '', 'Scout');
    const target = path.join(dorkHome, 'elsewhere-SOUL.md');
    await fs.writeFile(target, oldSoul('Scout'));
    await fs.rm(path.join(dir, '.dork', 'SOUL.md'));
    await fs.symlink(target, path.join(dir, '.dork', 'SOUL.md'));

    await refreshUntouchedTemplates([dir], dorkHome);

    expect(await fs.readFile(target, 'utf-8')).toBe(oldSoul('Scout'));
    expect((await fs.lstat(path.join(dir, '.dork', 'SOUL.md'))).isSymbolicLink()).toBe(true);
  });

  it('leaves an edited SOUL.md exactly as it was', async () => {
    const edited = `${oldSoul('Scout')}\n- Ship on Fridays`;
    const dir = await agentWithSoul('scout', edited, 'Scout');

    const summary = await refreshUntouchedTemplates([dir], dorkHome);

    expect(summary.souls).toBe(0);
    expect(await readSoul(dir)).toBe(edited);
  });

  it('leaves a SOUL.md alone when someone wrote above the trait fence', async () => {
    const edited = `Note to self.\n${oldSoul('Scout')}`;
    const dir = await agentWithSoul('scout', edited, 'Scout');

    await refreshUntouchedTemplates([dir], dorkHome);

    expect(await readSoul(dir)).toBe(edited);
  });

  it('never writes outside agent homes under dork home', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'someones-repo-'));
    try {
      await fs.mkdir(path.join(outside, '.dork'));
      await fs.writeFile(path.join(outside, '.dork', 'SOUL.md'), oldSoul('Scout'));

      const summary = await refreshUntouchedTemplates([outside], dorkHome);

      expect(summary.souls).toBe(0);
      expect(await readSoul(outside)).toBe(oldSoul('Scout'));
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('does nothing on the second boot', async () => {
    const dir = await agentWithSoul('scout', oldSoul('Scout'), 'Scout');
    await fs.writeFile(path.join(dorkbotDir, 'AGENTS.md'), PREVIOUS_DORKBOT_AGENTS_MD[1]);
    await refreshUntouchedTemplates([dir, dorkbotDir], dorkHome);

    const second = await refreshUntouchedTemplates([dir, dorkbotDir], dorkHome);

    expect(second).toEqual({ souls: 0, dorkbotAgentsMd: false });
  });

  it('copes with homes that have no files at all', async () => {
    const empty = path.join(dorkHome, 'agents', 'empty');
    await fs.mkdir(empty, { recursive: true });

    await expect(refreshUntouchedTemplates([empty], dorkHome)).resolves.toEqual({
      souls: 0,
      dorkbotAgentsMd: false,
    });
  });
});

describe('refreshSoulContent', () => {
  it('ignores a file whose only marker is a passing mention', () => {
    expect(
      refreshSoulContent('I keep the <!-- TRAITS:END --> marker in mind.', ['Scout'])
    ).toBeNull();
  });

  it('ignores the current template, so the pass is a no-op once applied', () => {
    expect(
      refreshSoulContent(defaultSoulTemplate('Scout', renderTraits(DEFAULT_TRAITS)), ['Scout'])
    ).toBeNull();
  });
});

describe('the frozen template lists', () => {
  const sha = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

  // Each entry must stay byte-for-byte what a released DorkOS wrote, recovered
  // from git history (DOR-2779). Editing one silently stops it matching the
  // files it exists for, so the fingerprints are pinned. Append, never edit.
  it('has not changed', () => {
    expect(PREVIOUS_DORKBOT_AGENTS_MD.map(sha)).toEqual(DORKBOT_FINGERPRINTS);
    expect(PREVIOUS_SOUL_PROSE.map(sha)).toEqual(SOUL_FINGERPRINTS);
  });
});

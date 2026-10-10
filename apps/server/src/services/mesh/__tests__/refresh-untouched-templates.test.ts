import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { buildSoulContent, defaultSoulTemplate } from '@dorkos/shared/convention-files';
import { renderTraits, DEFAULT_TRAITS } from '@dorkos/shared/trait-renderer';
import { dorkbotClaudeMdTemplate } from '@dorkos/shared/dorkbot-templates';
import {
  PREVIOUS_DORKBOT_AGENTS_MD,
  PREVIOUS_SOUL_PROSE,
  refreshSoulContent,
  refreshUntouchedTemplates,
} from '../refresh-untouched-templates.js';

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

  /** Make an agent home holding the given SOUL.md. */
  async function agentWithSoul(slug: string, soul: string): Promise<string> {
    const dir = path.join(dorkHome, 'agents', slug);
    await fs.mkdir(path.join(dir, '.dork'), { recursive: true });
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
    const dir = await agentWithSoul('scout', oldSoul('Scout the Second', traits));

    const summary = await refreshUntouchedTemplates([dir], dorkHome);

    expect(summary.souls).toBe(1);
    expect(await readSoul(dir)).toBe(defaultSoulTemplate('Scout the Second', renderTraits(traits)));
  });

  it('leaves an edited SOUL.md exactly as it was', async () => {
    const edited = `${oldSoul('Scout')}\n- Ship on Fridays`;
    const dir = await agentWithSoul('scout', edited);

    const summary = await refreshUntouchedTemplates([dir], dorkHome);

    expect(summary.souls).toBe(0);
    expect(await readSoul(dir)).toBe(edited);
  });

  it('leaves a SOUL.md alone when someone wrote above the trait fence', async () => {
    const edited = `Note to self.\n${oldSoul('Scout')}`;
    const dir = await agentWithSoul('scout', edited);

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
    const dir = await agentWithSoul('scout', oldSoul('Scout'));
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
    expect(refreshSoulContent('I keep the <!-- TRAITS:END --> marker in mind.')).toBeNull();
  });

  it('ignores the current template, so the pass is a no-op once applied', () => {
    expect(
      refreshSoulContent(defaultSoulTemplate('Scout', renderTraits(DEFAULT_TRAITS)))
    ).toBeNull();
  });
});

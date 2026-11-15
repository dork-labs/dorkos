/**
 * DOR-4394 (Security's choice a): the shared OpenCode sidecar never loads a
 * project's own config or code, and DorkOS passes the project's `AGENTS.md`
 * text itself, after its own instructions.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OPENCODE_OWN_PLAN } from '../credits-sidecar.js';
import { buildSidecarSpawnEnv, OPENCODE_SIDECAR_CONFIG } from '../server-manager.js';
import { openCodeProjectInstructions } from '../messaging/project-instructions.js';
import { buildOpenCodeSystem } from '../messaging/turn-input.js';
import {
  INSTRUCTION_BUDGET_CHARS,
  TRIMMED_MARKER,
} from '../../shared/project-files/instruction-files.js';

describe('the sidecar loads no project config (DOR-4394)', () => {
  it('spawns on a person’s own sign-in with project config off and DorkOS’s asks on', () => {
    const env = buildSidecarSpawnEnv(OPENCODE_OWN_PLAN, 'pw', {});
    expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1');
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!)).toEqual(OPENCODE_SIDECAR_CONFIG);
  });

  it('spawns on credits with project config off, the credits provider and DorkOS’s asks on', () => {
    const env = buildSidecarSpawnEnv(
      { mode: 'credits', fingerprint: 'credits:m', models: [] },
      'pw',
      {},
      { baseUrl: 'http://127.0.0.1:9/v1', key: 'relay-key' }
    );
    expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1');
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!).permission).toEqual(
      OPENCODE_SIDECAR_CONFIG.permission
    );
  });

  it('never lets a person’s own provider environment turn project config back on', () => {
    const env = buildSidecarSpawnEnv(OPENCODE_OWN_PLAN, 'pw', {
      OPENCODE_DISABLE_PROJECT_CONFIG: '0',
    });
    expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1');
  });
});

describe('the project’s AGENTS.md, passed by DorkOS (DOR-4394)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'dor4394-agents-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function project(): { top: string; inner: string } {
    const top = path.join(root, 'northwind');
    const inner = path.join(top, 'app');
    mkdirSync(path.join(top, '.git'), { recursive: true });
    mkdirSync(inner, { recursive: true });
    return { top, inner };
  }

  it('reads AGENTS.md from the project’s top down to the session’s folder, outermost first', () => {
    const { top, inner } = project();
    writeFileSync(path.join(top, 'AGENTS.md'), 'Use Kestrel naming.');
    writeFileSync(path.join(inner, 'AGENTS.md'), 'Run the app tests.');
    const text = openCodeProjectInstructions(inner)!;
    expect(text.indexOf('Use Kestrel naming.')).toBeLessThan(text.indexOf('Run the app tests.'));
    expect(text).toContain(`Contents of ${path.join(top, 'AGENTS.md')}:`);
  });

  it('never reads a folder above the project’s top', () => {
    const { inner } = project();
    writeFileSync(path.join(root, 'AGENTS.md'), 'From above the project.');
    expect(openCodeProjectInstructions(inner)).toBeUndefined();
  });

  it('reads only the session’s own folder outside a repo', () => {
    const plain = path.join(root, 'plain', 'deeper');
    mkdirSync(plain, { recursive: true });
    writeFileSync(path.join(root, 'plain', 'AGENTS.md'), 'Parent text.');
    writeFileSync(path.join(plain, 'AGENTS.md'), 'Own text.');
    expect(openCodeProjectInstructions(plain)).toBe(
      `Contents of ${path.join(plain, 'AGENTS.md')}:\n\nOwn text.`
    );
  });

  it('cuts a file too big to be real instructions to the budget, and says so (DOR-4405)', () => {
    const { top } = project();
    writeFileSync(path.join(top, 'AGENTS.md'), 'x'.repeat(65 * 1024));
    const text = openCodeProjectInstructions(top)!;
    expect(text.length).toBeLessThanOrEqual(INSTRUCTION_BUDGET_CHARS + TRIMMED_MARKER.length + 2);
    expect(text.endsWith(TRIMMED_MARKER)).toBe(true);
  });

  it('puts the project’s text after DorkOS’s own, never above it', () => {
    const system = buildOpenCodeSystem(
      { systemPromptAppend: 'DORKOS-APPEND' },
      'DORKOS-CONTEXT',
      undefined,
      'PROJECT-TEXT'
    )!;
    expect(system.indexOf('DORKOS-CONTEXT')).toBeLessThan(system.indexOf('PROJECT-TEXT'));
    expect(system.indexOf('DORKOS-APPEND')).toBeLessThan(system.indexOf('PROJECT-TEXT'));
    expect(system.trimEnd().endsWith('PROJECT-TEXT')).toBe(true);
  });
});

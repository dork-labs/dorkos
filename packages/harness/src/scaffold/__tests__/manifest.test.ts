import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  scaffoldManifest,
  detectHarnesses,
  DEFAULT_HARNESSES,
  HARNESS_MANIFEST_PATH,
} from '../manifest.js';
import { parseHarnessManifest } from '../../manifest/schema.js';

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'harness-manifest-scaffold-'));
}

/** Read + validate the scaffolded manifest at `root`, returning the parsed value. */
function readManifest(root: string): ReturnType<typeof parseHarnessManifest> {
  const raw: unknown = JSON.parse(readFileSync(join(root, HARNESS_MANIFEST_PATH), 'utf8'));
  return parseHarnessManifest(raw);
}

describe('detectHarnesses', () => {
  it('detects no harness in an empty repo', () => {
    dir = freshDir();
    expect(detectHarnesses(dir)).toEqual([]);
  });

  it('detects claude-code from a .claude directory and codex from AGENTS.md', () => {
    dir = freshDir();
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, 'AGENTS.md'), '# Agents\n');

    expect(detectHarnesses(dir)).toEqual(['claude-code', 'codex']);
  });

  it('detects cursor, gemini, and copilot from their signal paths, in canonical order', () => {
    dir = freshDir();
    mkdirSync(join(dir, '.cursor'), { recursive: true });
    writeFileSync(join(dir, 'GEMINI.md'), '# Gemini\n');
    mkdirSync(join(dir, '.github'), { recursive: true });
    writeFileSync(join(dir, '.github', 'copilot-instructions.md'), '# Copilot\n');

    expect(detectHarnesses(dir)).toEqual(['cursor', 'gemini', 'copilot']);
  });

  it('detects opencode from a .opencode directory', () => {
    dir = freshDir();
    mkdirSync(join(dir, '.opencode'), { recursive: true });
    expect(detectHarnesses(dir)).toEqual(['opencode']);
  });
});

describe('scaffoldManifest', () => {
  it('writes a manifest valid per parseHarnessManifest', () => {
    dir = freshDir();
    const result = scaffoldManifest(dir);

    expect(result.created).toBe(true);
    expect(result.path).toBe(HARNESS_MANIFEST_PATH);
    expect(existsSync(join(dir, HARNESS_MANIFEST_PATH))).toBe(true);

    // The file round-trips through the strict schema without throwing.
    const parsed = readManifest(dir);
    expect(parsed.version).toBe(1);
    expect(parsed.claudeOnlySkills).toEqual([]);
    expect(parsed.skillBundles).toEqual([]);
  });

  it('writes a human-editable file (2-space indent, trailing newline)', () => {
    dir = freshDir();
    scaffoldManifest(dir);
    const text = readFileSync(join(dir, HARNESS_MANIFEST_PATH), 'utf8');

    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('\n  "version": 1');
  });

  it('falls back to the documented default harness set when none is detected', () => {
    dir = freshDir();
    const result = scaffoldManifest(dir);

    expect(result.detected).toBe(false);
    expect(result.harnesses).toEqual(DEFAULT_HARNESSES);
    expect(readManifest(dir).harnesses).toEqual([...DEFAULT_HARNESSES]);
  });

  it('enables the detected harnesses when the repo shows a footprint', () => {
    dir = freshDir();
    mkdirSync(join(dir, '.cursor'), { recursive: true });
    writeFileSync(join(dir, 'GEMINI.md'), '# Gemini\n');

    const result = scaffoldManifest(dir);

    expect(result.detected).toBe(true);
    expect(result.harnesses).toEqual(['cursor', 'gemini']);
    expect(readManifest(dir).harnesses).toEqual(['cursor', 'gemini']);
  });

  it('respects an explicit harness override (detected=false)', () => {
    dir = freshDir();
    mkdirSync(join(dir, '.claude'), { recursive: true });

    const result = scaffoldManifest(dir, { harnesses: ['gemini'] });

    expect(result.detected).toBe(false);
    expect(result.harnesses).toEqual(['gemini']);
    expect(readManifest(dir).harnesses).toEqual(['gemini']);
  });

  it('no-ops when a manifest already exists and never overwrites it', () => {
    dir = freshDir();
    mkdirSync(join(dir, '.agents'), { recursive: true });
    const existing = JSON.stringify({ version: 1, harnesses: ['codex'] }, null, 2);
    writeFileSync(join(dir, HARNESS_MANIFEST_PATH), existing);

    const result = scaffoldManifest(dir);

    expect(result.created).toBe(false);
    expect(result.harnesses).toEqual(['codex']);
    // The pre-existing file is left byte-for-byte intact.
    expect(readFileSync(join(dir, HARNESS_MANIFEST_PATH), 'utf8')).toBe(existing);
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffoldInstructions } from '../instructions.js';

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'harness-scaffold-'));
}

describe('scaffoldInstructions', () => {
  it('scaffolds AGENTS.md + a CLAUDE.md whose body is exactly `@../AGENTS.md`', () => {
    dir = freshDir();
    const result = scaffoldInstructions(dir, { agentsBody: '# My Agent\n' });

    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toBe('# My Agent\n');
    expect(readFileSync(join(dir, '.claude', 'CLAUDE.md'), 'utf8')).toBe('@../AGENTS.md\n');
    expect(result.created).toContain('AGENTS.md');
    expect(result.created).toContain('.claude/CLAUDE.md');
  });

  it('scaffolds per-harness pointers and writes nothing for native harnesses', () => {
    dir = freshDir();
    scaffoldInstructions(dir, { agentsBody: '# A\n' });

    // gemini + copilot get pointer files…
    expect(readFileSync(join(dir, 'GEMINI.md'), 'utf8')).toContain('AGENTS.md');
    expect(readFileSync(join(dir, '.github', 'copilot-instructions.md'), 'utf8')).toContain(
      'AGENTS.md'
    );
    // …codex + cursor read AGENTS.md natively, so no per-harness file is written.
    expect(existsSync(join(dir, 'AGENTS.codex.md'))).toBe(false);
    expect(existsSync(join(dir, '.cursor'))).toBe(false);
  });

  it('does not duplicate or rewrite an existing AGENTS.md body on re-run', () => {
    dir = freshDir();
    scaffoldInstructions(dir, { agentsBody: '# original\n' });
    const second = scaffoldInstructions(dir, { agentsBody: '# DIFFERENT BODY\n' });

    // The canonical body is owned by the user after first write — never regenerated.
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toBe('# original\n');
    expect(second.created).not.toContain('AGENTS.md');
    expect(second.skipped).toContain('AGENTS.md');
  });

  it('leaves a hand-edited AGENTS.md untouched (write-if-absent, never overwrite)', () => {
    dir = freshDir();
    writeFileSync(join(dir, 'AGENTS.md'), '# hand authored, do not touch\n');

    const result = scaffoldInstructions(dir, { agentsBody: '# generated default\n' });

    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toBe('# hand authored, do not touch\n');
    expect(result.skipped).toContain('AGENTS.md');
    // Pointers around it are still scaffolded.
    expect(result.created).toContain('.claude/CLAUDE.md');
  });

  it('leaves an existing pointer untouched on re-run', () => {
    dir = freshDir();
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'CLAUDE.md'), '@../custom-pointer.md\n');

    const result = scaffoldInstructions(dir, { agentsBody: '# A\n' });

    expect(readFileSync(join(dir, '.claude', 'CLAUDE.md'), 'utf8')).toBe('@../custom-pointer.md\n');
    expect(result.skipped).toContain('.claude/CLAUDE.md');
  });

  it('honors the harness filter — only the requested harnesses get pointers', () => {
    dir = freshDir();
    const result = scaffoldInstructions(dir, { agentsBody: '# A\n', harnesses: ['claude-code'] });

    expect(existsSync(join(dir, '.claude', 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(dir, 'GEMINI.md'))).toBe(false);
    expect(existsSync(join(dir, '.github', 'copilot-instructions.md'))).toBe(false);
    expect(result.created).toEqual(['AGENTS.md', '.claude/CLAUDE.md']);
  });
});

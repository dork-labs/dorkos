/**
 * DOR-4405: a project's instruction files reach the prompt only as regular
 * files, never through a symlink, never hanging on a FIFO, and cut to a fixed
 * budget with a marker. Asked through both runtimes' readers, since both pass
 * this text. Every folder is a made-up one in a throwaway directory.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { folderInstructions } from '../../../claude-code/folder-settings/folder-instructions.js';
import { openCodeProjectInstructions } from '../../../opencode/messaging/project-instructions.js';
import {
  INSTRUCTION_BUDGET_CHARS,
  TRIMMED_MARKER,
  joinInstructionFiles,
  readInstructionFile,
} from '../instruction-files.js';

let root: string;
let project: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'dor4405-'));
  project = path.join(root, 'kestrel');
  outside = path.join(root, 'acme-private', 'notes.md');
  mkdirSync(path.join(project, '.git'), { recursive: true });
  mkdirSync(path.dirname(outside), { recursive: true });
  writeFileSync(outside, 'Northwind private notes.');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('a symlinked instruction file is never followed', () => {
  it('OpenCode: an AGENTS.md pointing outside the project is not read', () => {
    symlinkSync(outside, path.join(project, 'AGENTS.md'));
    expect(openCodeProjectInstructions(project)).toBeUndefined();
  });

  it('Claude: a CLAUDE.md pointing outside the project is not read', () => {
    symlinkSync(outside, path.join(project, 'CLAUDE.md'));
    expect(folderInstructions(project, project) ?? '').not.toContain('Northwind private notes.');
  });

  it('a real file beside it is still read', () => {
    writeFileSync(path.join(project, 'AGENTS.md'), 'Use Kestrel naming.');
    expect(openCodeProjectInstructions(project)).toContain('Use Kestrel naming.');
  });
});

describe('anything but a regular file is refused at once', () => {
  it.skipIf(process.platform === 'win32')('a FIFO does not block the read', () => {
    const fifo = path.join(project, 'AGENTS.md');
    execFileSync('mkfifo', [fifo]);
    // Nothing ever writes to it: a blocking open would hang this test.
    expect(readInstructionFile(fifo, 100)).toBeUndefined();
    expect(openCodeProjectInstructions(project)).toBeUndefined();
  });

  it('a folder named like the file is refused', () => {
    mkdirSync(path.join(project, 'AGENTS.md'));
    expect(openCodeProjectInstructions(project)).toBeUndefined();
  });
});

describe('the project text is cut to a fixed budget', () => {
  it('cuts one huge file and ends with the marker', () => {
    writeFileSync(path.join(project, 'AGENTS.md'), 'k'.repeat(INSTRUCTION_BUDGET_CHARS * 3));
    const text = openCodeProjectInstructions(project)!;
    const body = text.slice(0, -TRIMMED_MARKER.length).trimEnd();
    expect(body.length).toBeLessThanOrEqual(INSTRUCTION_BUDGET_CHARS);
    expect(text.endsWith(TRIMMED_MARKER)).toBe(true);
  });

  it('keeps the outer file whole and cuts what comes after it', () => {
    const inner = path.join(project, 'app');
    mkdirSync(inner);
    writeFileSync(path.join(project, 'AGENTS.md'), 'Outer rules for Kestrel.');
    writeFileSync(path.join(inner, 'AGENTS.md'), 'i'.repeat(INSTRUCTION_BUDGET_CHARS * 2));
    const text = openCodeProjectInstructions(inner)!;
    expect(text.startsWith(`Contents of ${path.join(project, 'AGENTS.md')}:`)).toBe(true);
    expect(text).toContain('Outer rules for Kestrel.');
    expect(text.endsWith(TRIMMED_MARKER)).toBe(true);
  });

  it('says nothing about trimming when everything fits', () => {
    writeFileSync(path.join(project, 'AGENTS.md'), 'Short Acme Search rules.');
    expect(openCodeProjectInstructions(project)).not.toContain(TRIMMED_MARKER);
  });

  it('marks a file left out entirely once the budget is spent', () => {
    const a = path.join(root, 'a.md');
    const b = path.join(root, 'b.md');
    writeFileSync(a, 'a'.repeat(INSTRUCTION_BUDGET_CHARS * 2));
    writeFileSync(b, 'Northwind rules nobody had room for.');
    const text = joinInstructionFiles([a, b])!;
    expect(text).not.toContain('Northwind rules');
    expect(text.endsWith(TRIMMED_MARKER)).toBe(true);
  });
});

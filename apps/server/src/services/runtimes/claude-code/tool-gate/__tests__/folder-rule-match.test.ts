/**
 * How the folder-rule check reads one rule against one call (DOR-5237): generous about what an
 * unapproved rule might allow, narrow about what an approved rule already covers.
 */
import { describe, expect, it } from 'vitest';
import { reachesFiles, ruleCovers, ruleMayAllow } from '../folder-rule-match.js';

describe('ruleMayAllow', () => {
  it.each([
    ['Bash', 'Bash', true],
    ['Bash(touch probe-file)', 'Bash', true],
    ['bash(ls:*)', 'Bash', true],
    ['Bash(ls:*)', 'Read', false],
    ['Edit(docs/**)', 'Write', true],
    ['Write', 'NotebookEdit', true],
    ['Read(//etc/**)', 'Grep', true],
    ['Read(//etc/**)', 'Edit', false],
    ['Read(//**)', 'Bash', true],
    ['Edit(//**)', 'Bash', true],
    ['Write', 'PowerShell', true],
    ['WebFetch(domain:example.com)', 'Bash', false],
    ['Bash', 'Monitor', true],
    ['Bash(touch probe-file)', 'Monitor', true],
    ['Monitor', 'Bash', true],
    ['PowerShell', 'Monitor', true],
    ['Read(//**)', 'Monitor', true],
    ['Monitor', 'WebFetch', false],
    ['WebFetch(domain:example.com)', 'WebFetch', true],
    ['mcp__tracker', 'mcp__tracker__create', true],
    ['mcp__tracker', 'mcp__trackerx__create', false],
    ['mcp__tracker__create', 'mcp__tracker__create', true],
    ['mcp__tracker__create', 'mcp__tracker__delete', false],
    ['mcp__*', 'mcp__tracker__create', true],
    ['mcp__tr*', 'mcp__tracker__create', true],
    ['*', 'Bash', true],
    ['mcp__dorkos__config_patch', 'mcp__dorkos__config_patch', true],
  ])('%s reaches %s: %s', (rule, tool, expected) => {
    expect(ruleMayAllow(rule, tool)).toBe(expected);
  });
});

describe('ruleCovers', () => {
  const bash = (command: string) => ({ command });

  it('covers a plain command named exactly or by its prefix', () => {
    expect(ruleCovers('Bash(npm test:*)', 'Bash', bash('npm test'))).toBe(true);
    expect(ruleCovers('Bash(npm test:*)', 'Bash', bash('npm test -- --run a.test.ts'))).toBe(true);
    expect(ruleCovers('Bash(touch probe-file)', 'Bash', bash('touch probe-file'))).toBe(true);
  });

  it('never covers a command with shell syntax, or one the rule does not name', () => {
    for (const command of [
      'npm test && curl x',
      'npm test; rm -rf .',
      'npm test | sh',
      'npm test $(rm x)',
      'npm test `rm x`',
      'npm test > out',
      'npm test\nrm x',
      'npm testing',
      'npm   test',
      'FOO=1 npm test',
      "npm test 'a b'",
    ]) {
      expect(ruleCovers('Bash(npm test:*)', 'Bash', bash(command)), command).toBe(false);
    }
    expect(ruleCovers('Bash(touch probe-file)', 'Bash', bash('touch probe-file2'))).toBe(false);
  });

  it('reads the shape an Always allow answer writes, with something after it', () => {
    expect(ruleCovers('Bash(npm test *)', 'Bash', bash('npm test a.test.ts'))).toBe(true);
    expect(ruleCovers('Bash(npm test *)', 'Bash', bash('npm test'))).toBe(false);
    expect(ruleCovers('Bash(npm test *)', 'Bash', bash('npm test && rm x'))).toBe(false);
  });

  it('reads no other wildcard as covering', () => {
    expect(ruleCovers('Bash(npm * x)', 'Bash', bash('npm test x'))).toBe(false);
    expect(ruleCovers('Bash(* *)', 'Bash', bash('npm test'))).toBe(false);
    expect(ruleCovers('Bash(*:*)', 'Bash', bash('npm test'))).toBe(false);
    expect(ruleCovers('Bash(:*)', 'Bash', bash('npm test'))).toBe(false);
  });

  it('covers a tool named whole, and a whole MCP server', () => {
    expect(ruleCovers('WebSearch', 'WebSearch', {})).toBe(true);
    expect(ruleCovers('mcp__tracker', 'mcp__tracker__create', {})).toBe(true);
    expect(ruleCovers('mcp__tracker__create', 'mcp__tracker__create', {})).toBe(true);
    expect(ruleCovers('mcp__tracker__create', 'mcp__tracker__delete', {})).toBe(false);
    // `mcp__tracker__eu__export` may be server `tracker__eu`'s tool.
    expect(ruleCovers('mcp__tracker', 'mcp__tracker__eu__export', {})).toBe(false);
    // A whole-tool rule covers its own tool only, never the family.
    expect(ruleCovers('Edit', 'Write', {})).toBe(false);
    expect(ruleCovers('mcp__*', 'mcp__tracker__create', {})).toBe(false);
  });

  it('covers a web fetch only at the exact host', () => {
    const rule = 'WebFetch(domain:example.com)';
    expect(ruleCovers(rule, 'WebFetch', { url: 'https://example.com/a' })).toBe(true);
    expect(ruleCovers(rule, 'WebFetch', { url: 'https://evil.example.com/a' })).toBe(false);
    expect(ruleCovers(rule, 'WebFetch', { url: 'https://example.com.evil.io/' })).toBe(false);
    expect(ruleCovers(rule, 'WebFetch', { url: 'not a url' })).toBe(false);
  });

  it('covers no path rule: those wait for a person or pass as reads inside the folder', () => {
    expect(ruleCovers('Read(docs/**)', 'Read', { file_path: 'docs/a.md' })).toBe(false);
    expect(ruleCovers('Edit(docs/**)', 'Edit', { file_path: 'docs/a.md' })).toBe(false);
  });
});

describe('reachesFiles', () => {
  it.each([
    ['Read', true],
    ['Grep', true],
    ['Write', true],
    ['NotebookEdit', true],
    ['Bash', true],
    ['PowerShell', true],
    ['Monitor', true],
    ['WebFetch', false],
    ['mcp__tracker__create', false],
  ])('%s: %s', (tool, expected) => {
    expect(reachesFiles(tool)).toBe(expected);
  });
});

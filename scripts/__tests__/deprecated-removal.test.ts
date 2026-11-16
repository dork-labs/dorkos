/** Exercise the deprecation deadline through the shared ESLint preset. */
import { readFileSync } from 'node:fs';
import { Linter } from 'eslint';
import { describe, expect, it } from 'vitest';
import baseConfig from '../../packages/eslint-config/base.js';

const ruleId = 'dorkos/deprecated-removal';
const warningRuleId = 'dorkos/deprecated-removal-soon';

function check(code: string, version?: string, filename = 'example.ts') {
  const linter = new Linter();
  const config: Linter.Config[] = version
    ? [
        ...baseConfig,
        { rules: { [ruleId]: ['error', { version }], [warningRuleId]: ['warn', { version }] } },
      ]
    : baseConfig;
  return linter.verify(code, config, { filename }).filter((message) => message.ruleId === ruleId || message.ruleId === warningRuleId);
}

describe('deprecation removal policy', () => {
  it('rejects an unversioned tag through the normal preset', () => {
    expect(check('/** @deprecated Use replacement. */\nconst old = 1;')).toMatchObject([
      { severity: 2, messageId: 'missingSchedule', line: 1 },
    ]);
  });

  it('uses VERSION for the default removal deadline', () => {
    expect(
      check('/** @deprecated since 0.0, remove in 0.1. Use replacement. */\nconst old = 1;')
    ).toMatchObject([{ severity: 2, messageId: 'expired' }]);
  });

  it('uses VERSION and warning severity from the default preset', () => {
    const version = readFileSync(new URL('../../VERSION', import.meta.url), 'utf8').trim();
    const [major, minor] = version.split('.').map(Number);
    const removal = `${major}.${Number(minor) + 2}`;
    expect(
      check(`/** @deprecated since ${major}.0, remove in ${removal}. Use replacement. */\nconst old = 1;`)
    ).toMatchObject([{ ruleId: warningRuleId, severity: 1, messageId: 'approaching' }]);
  });

  it.each(['example.js', 'example.mjs', 'example.ts', 'example.tsx'])(
    'checks JSDoc in %s',
    (filename) => {
      expect(
        check('/** @deprecated Use replacement. */\nconst old = 1;', undefined, filename)
      ).toMatchObject([{ severity: 2, messageId: 'missingSchedule' }]);
    }
  );

  it.each([
    ['0.134.9', '0.135', false],
    ['0.135.0', '0.135', true],
    ['0.135.1', '0.135', true],
    ['0.135.12', '0.136', false],
    ['0.135.12', '0.135.11', true],
    ['0.135.12', '0.135.12', true],
    ['0.135.12', '0.135.13', false],
    ['0.100.0', '0.99', true],
    ['1.0.0', '0.999', true],
  ])('at %s, removal in %s is expired=%s', (version, removal, expired) => {
    const messages = check(
      `/** @deprecated since 0.90, remove in ${removal}. Use replacement. */\nconst old = 1;`,
      version
    ).filter((message) => message.ruleId === ruleId);
    expect(messages).toHaveLength(expired ? 1 : 0);
    if (expired) expect(messages[0]).toMatchObject({ severity: 2, messageId: 'expired' });
  });

  it.each([
    ['0.152.99', 0],
    ['0.153.0', 1],
    ['0.154.99', 1],
    ['0.155.0', 2],
    ['0.155.1', 2],
  ])('at %s, removal in 0.155 has severity %s', (version, severity) => {
    const messages = check(
      '/** @deprecated since 0.135, remove in 0.155. Use replacement. */\nconst old = 1;',
      version
    );
    expect(messages).toHaveLength(severity === 0 ? 0 : 1);
    if (severity > 0) expect(messages[0]).toMatchObject({ severity });
    if (severity === 1) {
      expect(messages[0]).toMatchObject({ ruleId: warningRuleId, messageId: 'approaching' });
      expect(messages[0]?.message).toContain('becomes an error in 0.155');
    }
  });

  it.each([',', ';', ')'])('accepts trailing %s after the removal version', (punctuation) => {
    expect(
      check(
        `/** @deprecated since 0.135, remove in 0.155${punctuation} use replacement. */\nconst old = 1;`,
        '0.135.12'
      )
    ).toEqual([]);
    expect(
      check(
        `/** @deprecated since 0.135, remove in 0.155${punctuation} use replacement. */\nconst old = 1;`,
        '0.155.0'
      )
    ).toMatchObject([{ severity: 2, messageId: 'expired' }]);
  });

  it.each([
    'Use replacement, remove in 0.155.',
    'since 0.135, remove someday.',
    'since 0.135, remove in 0.155oops',
    'since 0.135, remove in 0.155.4oops',
    'since 0.135, remove in 0.135',
    'since 0.135, remove in 0.134',
    'since 0.0135, remove in 0.155',
  ])('rejects a malformed schedule: %s', (schedule) => {
    expect(check(`/** @deprecated ${schedule} */\nconst old = 1;`, '0.135.12')).toMatchObject([
      { messageId: 'missingSchedule' },
    ]);
  });

  it('reports each tag at its own line in a multiline comment', () => {
    expect(
      check(
        '/** Old API.\n * @deprecated Use replacement.\n * @deprecated since 0.90, remove in 0.100.\n */\nconst old = 1;',
        '0.135.12'
      )
    ).toMatchObject([
      { messageId: 'missingSchedule', line: 2 },
      { messageId: 'expired', line: 3 },
    ]);
  });

  it('ignores prose, ordinary comments and strings mentioning the tag', () => {
    expect(
      check(
        '/** Explain the @deprecated policy. */\n// @deprecated example\n/* @deprecated example */\nconst example = "@deprecated example";',
        '0.135.12'
      )
    ).toEqual([]);
  });
});

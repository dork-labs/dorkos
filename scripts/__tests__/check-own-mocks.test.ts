import { describe, expect, it } from 'vitest';
import { compare, countOwnMocks, lowered, packageOf, raisedAgainst } from '../check-own-mocks.js';

// Spelled through constants so the samples below are not themselves counted by
// the ratchet this file tests.
const MOCK = 'vi' + '.mock';
const DO_MOCK = 'vi' + '.doMock';

describe('countOwnMocks', () => {
  it('counts mocks of relative paths, the @/ alias and workspace packages', () => {
    const text = [
      `${MOCK}('./sibling');`,
      `${MOCK}('../../lib/config-manager.js', () => ({}));`,
      `${MOCK}('@/layers/shared/model', async (orig) => ({ ...(await orig()) }));`,
      `${MOCK}("@dorkos/shared/logger");`,
      `${DO_MOCK}(\`@dork-labs/ui/input\`);`,
    ].join('\n');
    expect(countOwnMocks(text)).toBe(5);
  });

  it('never counts a third-party module, which is an edge', () => {
    const text = [
      `${MOCK}('node:fs/promises');`,
      `${MOCK}('chokidar');`,
      `${MOCK}('@anthropic-ai/claude-agent-sdk');`,
      `${MOCK}('@tanstack/react-router');`,
    ].join('\n');
    expect(countOwnMocks(text)).toBe(0);
  });

  it('skips comment lines, so prose quoting a mock does not move the count', () => {
    const text = [
      `// ${MOCK}('./not-counted')`,
      ` * ${MOCK}('@/also-not-counted')`,
      `/* ${MOCK}('../nor-this') */`,
      `${MOCK}('./counted');`,
    ].join('\n');
    expect(countOwnMocks(text)).toBe(1);
  });

  it('counts two mocks on one line', () => {
    expect(countOwnMocks(`${MOCK}('./a'); ${MOCK}('./b');`)).toBe(2);
  });
});

describe('packageOf', () => {
  it('groups apps and packages by their own folder, everything else by its top folder', () => {
    expect(packageOf('apps/client/src/x/__tests__/a.test.tsx')).toBe('apps/client');
    expect(packageOf('packages/relay/src/__tests__/a.test.ts')).toBe('packages/relay');
    expect(packageOf('scripts/__tests__/a.test.ts')).toBe('scripts');
    expect(packageOf('a.test.ts')).toBe('.');
  });
});

describe('compare', () => {
  it('reports growth, a new package, and a drop the baseline has not locked in', () => {
    const findings = compare(
      { 'apps/client': 11, 'apps/new': 1, 'apps/server': 4 },
      { 'apps/client': 10, 'apps/server': 5, 'packages/gone': 2 }
    );
    expect(findings).toEqual([
      { kind: 'grew', pkg: 'apps/client', count: 11, baseline: 10 },
      { kind: 'new', pkg: 'apps/new', count: 1 },
      { kind: 'stale', pkg: 'apps/server', count: 4, baseline: 5 },
      { kind: 'stale', pkg: 'packages/gone', baseline: 2 },
    ]);
  });

  it('is clean when every count matches its baseline', () => {
    expect(compare({ 'apps/client': 10 }, { 'apps/client': 10 })).toEqual([]);
  });
});

describe('raisedAgainst', () => {
  it('refuses a baseline raised or added to by hand', () => {
    expect(raisedAgainst({ 'apps/client': 12, 'apps/new': 3 }, { 'apps/client': 10 })).toEqual([
      { kind: 'raised', pkg: 'apps/client', count: 12, baseline: 10 },
      { kind: 'raised', pkg: 'apps/new', count: 3 },
    ]);
  });

  it('accepts a baseline that only went down', () => {
    expect(raisedAgainst({ 'apps/client': 9 }, { 'apps/client': 10, 'apps/gone': 1 })).toEqual([]);
  });
});

describe('lowered', () => {
  it('lowers entries, drops packages at zero, and never raises or adds', () => {
    expect(
      lowered(
        { 'apps/client': 8, 'apps/server': 7, 'apps/new': 2 },
        { 'apps/client': 10, 'apps/server': 5, 'packages/gone': 3 }
      )
    ).toEqual({ 'apps/client': 8, 'apps/server': 5 });
  });
});

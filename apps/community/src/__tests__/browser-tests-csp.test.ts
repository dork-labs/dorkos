/**
 * Every browser test runs under the guard that fails it when a page breaks its content security
 * policy (DOR-2957, `browser-tests/csp.ts`). A spec that took `test` from `@playwright/test`
 * would pass while the page it drives refused its own script.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SPECS = new URL('../../browser-tests/', import.meta.url);

describe('browser tests', () => {
  it('all take test and expect from the policy guard', () => {
    // Purpose: fails when a spec imports Playwright's own `test` or `expect`, bypassing the guard.
    const specs = readdirSync(SPECS).filter((name) => name.endsWith('.spec.ts'));
    expect(specs.length).toBeGreaterThan(15);
    const unguarded = specs.filter((name) => {
      const text = readFileSync(new URL(name, SPECS), 'utf8');
      const fromPlaywright = /import \{([^}]*)\} from '@playwright\/test'/u.exec(text)?.[1] ?? '';
      const names = fromPlaywright.split(',').map((part) => part.trim());
      return (
        names.includes('test') ||
        names.includes('expect') ||
        !/^import \{[^}]*\btest, expect \} from '\.\/csp\.js';$/mu.test(text)
      );
    });
    expect(unguarded).toEqual([]);
  });
});

/**
 * The two preloads copy the step-up channel names rather than import them, so
 * each builds to one file a sandboxed preload can load. This keeps the
 * copies equal to `shared/step-up-page.ts`, and the window's preload free of
 * any value import that would split it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  STEP_UP_CONFIRM_CHANNEL,
  STEP_UP_WINDOW_CLOSE_CHANNEL,
  STEP_UP_WINDOW_SUBMIT_CHANNEL,
  STEP_UP_WINDOW_VIEW_CHANNEL,
} from '../../../shared/step-up-page';

const preload = (name: string) =>
  readFileSync(path.resolve(__dirname, '../../../preload', name), 'utf8');

describe('step-up channel names in the preloads', () => {
  it('the app’s preload names the confirm channel exactly', () => {
    expect(preload('index.ts')).toContain(
      `const STEP_UP_CONFIRM_CHANNEL = '${STEP_UP_CONFIRM_CHANNEL}'`
    );
  });

  it('the window’s preload names its three channels exactly', () => {
    const source = preload('step-up.ts');
    expect(source).toContain(
      `const STEP_UP_WINDOW_VIEW_CHANNEL = '${STEP_UP_WINDOW_VIEW_CHANNEL}'`
    );
    expect(source).toContain(
      `const STEP_UP_WINDOW_SUBMIT_CHANNEL = '${STEP_UP_WINDOW_SUBMIT_CHANNEL}'`
    );
    expect(source).toContain(
      `const STEP_UP_WINDOW_CLOSE_CHANNEL = '${STEP_UP_WINDOW_CLOSE_CHANNEL}'`
    );
  });

  it('neither preload takes a value from the shared module', () => {
    for (const name of ['index.ts', 'step-up.ts']) {
      const imports =
        preload(name).match(/^import [^;]*from '\.\.\/shared\/step-up-page';/gm) ?? [];
      for (const line of imports) expect(line.startsWith('import type')).toBe(true);
    }
  });
});

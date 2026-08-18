import { describe, it, expect } from 'vitest';
import type { PermissionPreview } from '@dorkos/shared/marketplace-schemas';

import { formatPermissionPreview } from '../format-permissions';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePreview(overrides: Partial<PermissionPreview> = {}): PermissionPreview {
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

const DORK_HOME = '/Users/kai/.dork';
const FLOW_ROOT = '/Users/kai/.dork/plugins/flow';

// ---------------------------------------------------------------------------
// File changes — headline
// ---------------------------------------------------------------------------

describe('formatPermissionPreview → effects → file changes', () => {
  it('states the shared folder and a count per action, not a bare total', () => {
    const preview = makePreview({
      fileChanges: [
        { path: `${FLOW_ROOT}/commands/flow.md`, action: 'create' },
        { path: `${FLOW_ROOT}/commands/done.md`, action: 'create' },
        { path: `${FLOW_ROOT}/config/config.json`, action: 'modify' },
        { path: `${FLOW_ROOT}/scripts/stale.ts`, action: 'delete' },
      ],
    });

    const [headline] = formatPermissionPreview(preview).effects;

    expect(headline?.label).toBe(`4 files under ${FLOW_ROOT}: 2 new, 1 changed, 1 removed`);
  });

  it('uses the singular for a one-file install and still reports every action', () => {
    const preview = makePreview({
      fileChanges: [{ path: `${DORK_HOME}/agents/reviewer/agent.json`, action: 'create' }],
    });

    const [headline] = formatPermissionPreview(preview).effects;

    expect(headline?.label).toBe(
      `1 file under ${DORK_HOME}/agents/reviewer: 1 new, 0 changed, 0 removed`
    );
  });

  it('computes the deepest folder that contains every path', () => {
    const preview = makePreview({
      fileChanges: [
        { path: '/Users/kai/.dork/plugins/flow/a/one.md', action: 'create' },
        { path: '/Users/kai/.dork/plugins/flow/b/two.md', action: 'create' },
      ],
    });

    const [headline] = formatPermissionPreview(preview).effects;

    // Not `/Users/kai/.dork/plugins/flow/a` — the deepest COMMON folder.
    expect(headline?.label).toContain(' under /Users/kai/.dork/plugins/flow:');
  });

  it('drops the "under" clause when the paths share no folder at all', () => {
    const preview = makePreview({
      fileChanges: [
        { path: 'one.md', action: 'create' },
        { path: 'two.md', action: 'create' },
      ],
    });

    const [headline] = formatPermissionPreview(preview).effects;

    expect(headline?.label).toBe('2 files: 2 new, 0 changed, 0 removed');
  });

  it('handles Windows-style paths', () => {
    const preview = makePreview({
      fileChanges: [
        { path: 'C:\\Users\\kai\\.dork\\plugins\\flow\\a.md', action: 'create' },
        { path: 'C:\\Users\\kai\\.dork\\plugins\\flow\\b.md', action: 'create' },
      ],
    });

    const [headline] = formatPermissionPreview(preview).effects;

    expect(headline?.label).toBe(
      '2 files under C:\\Users\\kai\\.dork\\plugins\\flow: 2 new, 0 changed, 0 removed'
    );
  });

  // -------------------------------------------------------------------------
  // File changes — the expandable list
  // -------------------------------------------------------------------------

  it('lists removed files first, then changed, then new, each alphabetical', () => {
    const preview = makePreview({
      fileChanges: [
        { path: `${FLOW_ROOT}/z-new.md`, action: 'create' },
        { path: `${FLOW_ROOT}/a-new.md`, action: 'create' },
        { path: `${FLOW_ROOT}/m-changed.md`, action: 'modify' },
        { path: `${FLOW_ROOT}/z-gone.md`, action: 'delete' },
        { path: `${FLOW_ROOT}/a-gone.md`, action: 'delete' },
      ],
    });

    const [headline] = formatPermissionPreview(preview).effects;

    expect(headline?.details).toEqual([
      { text: 'a-gone.md', tag: 'removed', severity: 'warning' },
      { text: 'z-gone.md', tag: 'removed', severity: 'warning' },
      { text: 'm-changed.md', tag: 'changed' },
      { text: 'a-new.md', tag: 'new' },
      { text: 'z-new.md', tag: 'new' },
    ]);
  });

  it('shows paths relative to the shared folder, never the whole path again', () => {
    const preview = makePreview({
      fileChanges: [
        { path: `${FLOW_ROOT}/commands/flow.md`, action: 'create' },
        { path: `${FLOW_ROOT}/skills/linear/SKILL.md`, action: 'create' },
      ],
    });

    const [headline] = formatPermissionPreview(preview).effects;

    expect(headline?.details?.map((d) => d.text)).toEqual([
      'commands/flow.md',
      'skills/linear/SKILL.md',
    ]);
  });

  it('names the disclosure with the file count so it is clear before opening', () => {
    const preview = makePreview({
      fileChanges: [
        { path: `${FLOW_ROOT}/a.md`, action: 'create' },
        { path: `${FLOW_ROOT}/b.md`, action: 'create' },
      ],
    });

    const [headline] = formatPermissionPreview(preview).effects;

    expect(headline?.detailsLabel).toBe('Show 2 files');
  });

  // -------------------------------------------------------------------------
  // Containment
  // -------------------------------------------------------------------------

  it('adds no row at all when every file stays inside the install folder', () => {
    const preview = makePreview({
      fileChanges: [
        { path: `${FLOW_ROOT}/a.md`, action: 'create' },
        { path: `${FLOW_ROOT}/b.md`, action: 'create' },
      ],
    });

    const rows = formatPermissionPreview(preview, { installBase: DORK_HOME }).effects;

    // The headline already names the folder. A second row restating it could
    // never be false, and the dialog's scarcest resource is vertical space.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.icon).toBe('file');
  });

  it('does not cry escape over a stray slash or dot in the install folder', () => {
    // Agent-local installs: the server writes file paths with `path.join`, the
    // client concatenates the base as `${projectPath}/.dork`. A stored
    // projectPath with a trailing slash or a `./` in it must not make every
    // ordinary file read as "outside your folder".
    const preview = makePreview({
      fileChanges: [{ path: '/Users/kai/proj/.dork/plugins/flow/a.md', action: 'create' }],
    });

    for (const projectPath of ['/Users/kai/proj', '/Users/kai/proj/', '/Users/kai/./proj']) {
      const rows = formatPermissionPreview(preview, {
        installBase: `${projectPath}/.dork`,
      }).effects;
      expect(rows, `projectPath: ${projectPath}`).toHaveLength(1);
    }
  });

  it('warns, and names them, when files land outside the install folder', () => {
    const preview = makePreview({
      fileChanges: [
        { path: `${FLOW_ROOT}/a.md`, action: 'create' },
        { path: '/Users/kai/.claude/settings.json', action: 'modify' },
      ],
    });

    const rows = formatPermissionPreview(preview, { installBase: DORK_HOME }).effects;

    expect(rows[1]).toMatchObject({
      icon: 'alert-triangle',
      label: `1 file lands outside ${DORK_HOME}.`,
      severity: 'warning',
    });
    expect(rows[1]?.details).toEqual([
      { text: '/Users/kai/.claude/settings.json', tag: 'changed' },
    ]);
  });

  it('does not treat a sibling folder with the same prefix as inside', () => {
    const preview = makePreview({
      fileChanges: [{ path: '/Users/kai/.dork-backup/a.md', action: 'create' }],
    });

    const rows = formatPermissionPreview(preview, { installBase: DORK_HOME }).effects;

    expect(rows[1]?.severity).toBe('warning');
  });

  it('makes no containment claim when the install folder is unknown', () => {
    const preview = makePreview({
      fileChanges: [{ path: `${FLOW_ROOT}/a.md`, action: 'create' }],
    });

    const rows = formatPermissionPreview(preview).effects;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.icon).toBe('file');
  });

  it('makes no containment claim while the config is still loading', () => {
    const preview = makePreview({
      fileChanges: [{ path: `${FLOW_ROOT}/a.md`, action: 'create' }],
    });

    // An empty base would compare against nothing and flag every path as
    // escaping — a false alarm is worse than saying nothing.
    const rows = formatPermissionPreview(preview, { installBase: '' }).effects;

    expect(rows).toHaveLength(1);
  });

  it('adds no file rows at all when the package touches no files', () => {
    const rows = formatPermissionPreview(makePreview(), { installBase: DORK_HOME }).effects;

    expect(rows).toEqual([]);
  });

  it('keeps extension rows after the file rows', () => {
    const preview = makePreview({
      fileChanges: [{ path: `${FLOW_ROOT}/a.md`, action: 'create' }],
      extensions: [{ id: 'flow-ext', slots: ['sidebar'] }],
    });

    const rows = formatPermissionPreview(preview, { installBase: DORK_HOME }).effects;

    expect(rows.map((r) => r.icon)).toEqual(['file', 'puzzle']);
  });
});

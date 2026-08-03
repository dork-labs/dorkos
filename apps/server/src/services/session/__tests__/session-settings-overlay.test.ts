/**
 * Unit tests for the shared persisted-settings overlay (ADR-0260, DOR-463) —
 * the ONE resolver every session read path uses, so the list endpoint, the
 * detail endpoint, and the `/events` ctx cannot key the store differently.
 *
 * It resolves exactly ONE key per session (DOR-493). Trying a list of candidate
 * ids made the answer depend on which id a caller asked by; the runtime now
 * moves the row when it rebinds a session, so there is nothing to choose.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Session, SessionSettings } from '@dorkos/shared/types';
import {
  overlayStoredSettings,
  applyStoredSettings,
  resolveSettingsKey,
  type SessionSettingsOverlayPort,
} from '../session-settings-overlay.js';

function makeSession(id: string, runtime?: string): Session {
  return {
    id,
    title: `Session ${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    permissionMode: 'default',
    ...(runtime !== undefined ? { runtime } : {}),
  };
}

/**
 * Which runtimes a port answers for, and what each declares about its effort.
 *
 * Two shapes are all this file needs: a Claude-shaped runtime that takes an
 * effort, and an OpenCode-shaped one that declares it has none. The declaration
 * is the runtime's own now, so a fake stating it is how the display rule below
 * gets exercised at all.
 */
const CLAUDE_SHAPED = { configSection: 'claudeCode', supportsEffort: true, sections: [] };
const OPENCODE_SHAPED = { configSection: 'opencode', supportsEffort: false, sections: [] };

/**
 * Build an overlay port over a fixed settings table and a fixed id-alias map.
 *
 * @param rows - Persisted settings keyed by the id they are stored under
 * @param alias - Client-facing id → the runtime's canonical id
 * @param registered - What each registered runtime type declares. Defaults to
 *   one `fake` runtime that takes an effort, which is the uninteresting case
 *   for every test not about the effort rule.
 */
function makePort(
  rows: Record<string, SessionSettings>,
  alias: Record<string, string> = {},
  registered: Record<string, typeof CLAUDE_SHAPED> = { fake: CLAUDE_SHAPED }
): SessionSettingsOverlayPort & { readKeys: string[][] } {
  const readKeys: string[][] = [];
  return {
    readKeys,
    getSessionSettingsMany: vi.fn((ids: string[]) => {
      readKeys.push(ids);
      const map = new Map<string, SessionSettings>();
      for (const id of ids) {
        const row = rows[id];
        if (row) map.set(id, row);
      }
      return map;
    }),
    has: (type: string) => type in registered,
    get: (type: string) => ({
      getInternalSessionId: (id: string) => alias[id],
      getCapabilities: () => ({ settings: registered[type] ?? CLAUDE_SHAPED }),
    }),
  };
}

describe('resolveSettingsKey', () => {
  it('returns the runtime canonical id when the runtime holds an alias', () => {
    const runtime = { getInternalSessionId: () => 'canonical' };
    expect(resolveSettingsKey('request-id', runtime)).toBe('canonical');
  });

  it('returns the id unchanged when the runtime has no alias for it', () => {
    const runtime = { getInternalSessionId: () => undefined };
    expect(resolveSettingsKey('request-id', runtime)).toBe('request-id');
  });

  it('returns the id unchanged when the runtime cannot be resolved', () => {
    // An unregistered runtime tag must not throw the whole list — the id is
    // then its own key.
    expect(resolveSettingsKey('request-id', undefined)).toBe('request-id');
  });
});

/** A port that answers for both runtime shapes, for the display-rule tests. */
function bothShapes(): SessionSettingsOverlayPort {
  return makePort({}, {}, { 'claude-code': CLAUDE_SHAPED, opencode: OPENCODE_SHAPED });
}

describe('applyStoredSettings', () => {
  it('lets the store win over runtime-derived values, field by field', () => {
    const session = makeSession('s1');
    session.model = 'transcript-model';

    applyStoredSettings(session, { permissionMode: 'plan', effort: 'high' }, bothShapes());

    expect(session.permissionMode).toBe('plan');
    expect(session.effort).toBe('high');
    // A field the store has no value for keeps the runtime-derived one.
    expect(session.model).toBe('transcript-model');
  });
});

describe('applyStoredSettings — a runtime that declares no effort', () => {
  it('never shows an effort on an OpenCode session, even with one in the row', () => {
    // OpenCode's API takes no effort, so displaying one would be showing a
    // person a setting that does nothing. A row can still hold one — written
    // before this rule, or by a shared path that does not ask which runtime it
    // serves — so the display gate is what makes "Not supported by OpenCode"
    // true rather than aspirational.
    const session = makeSession('oc-1', 'opencode');
    const stored = { model: 'openrouter/anthropic/claude-opus-4.6', effort: 'high' } as const;

    applyStoredSettings(session, stored, bothShapes());

    expect(session.effort).toBeUndefined();
    // Everything else the row holds still wins, as always.
    expect(session.model).toBe('openrouter/anthropic/claude-opus-4.6');
    // And the ROW is untouched — this is a display rule, not a storage one.
    expect(stored.effort).toBe('high');
  });

  it('still shows it on a runtime that declares one', () => {
    const session = makeSession('cc-1', 'claude-code');
    const stored = { effort: 'high' } as const;

    applyStoredSettings(session, stored, bothShapes());

    expect(session.effort).toBe('high');
    expect(stored.effort).toBe('high');
  });

  it('shows it for a session with no runtime tag at all', () => {
    // Unknown means unknown, not unsupported: muting an effort for a session
    // whose runtime the aggregation could not name would hide a real setting.
    const session = makeSession('unknown-1');

    applyStoredSettings(session, { effort: 'max' }, bothShapes());

    expect(session.effort).toBe('max');
  });

  it('shows it for a runtime this server does not have registered', () => {
    // Same reasoning one step out: an unregistered runtime has declared
    // nothing, and nothing is not a claim that it has no effort.
    const session = makeSession('gone-1', 'a-runtime-from-another-build');

    applyStoredSettings(session, { effort: 'max' }, bothShapes());

    expect(session.effort).toBe('max');
  });

  it('reads the declaration, not the runtime type — the answer moved to the adapter', () => {
    // The proof that nothing here keeps a list of which runtimes have an
    // effort: the same type answers both ways depending only on what it
    // declares.
    const session = makeSession('cc-2', 'claude-code');

    applyStoredSettings(session, { effort: 'high' }, makePort({}, {}, {}));
    expect(session.effort).toBe('high');

    const muted = makeSession('cc-3', 'claude-code');
    applyStoredSettings(
      muted,
      { effort: 'high' },
      makePort({}, {}, { 'claude-code': OPENCODE_SHAPED })
    );
    expect(muted.effort).toBeUndefined();
  });
});

describe('overlayStoredSettings — the effort display rule, end to end', () => {
  it('suppresses a stored effort for an OpenCode session and keeps it for a Claude one', () => {
    const sessions = [makeSession('oc-1', 'opencode'), makeSession('cc-1', 'claude-code')];
    const rows = { 'oc-1': { effort: 'high' }, 'cc-1': { effort: 'high' } } as const;
    const port = makePort(rows, {}, { 'claude-code': CLAUDE_SHAPED, opencode: OPENCODE_SHAPED });

    overlayStoredSettings(sessions, port);

    expect(sessions[0]!.effort).toBeUndefined();
    expect(sessions[1]!.effort).toBe('high');
    // Neither row was rewritten on the way through.
    expect(rows['oc-1'].effort).toBe('high');
    expect(rows['cc-1'].effort).toBe('high');
  });
});

describe('overlayStoredSettings', () => {
  it('keys each session by its runtime canonical id, not the id it is listed under', () => {
    // The row lives under the canonical id (where PATCH wrote it, and where the
    // runtime re-keys it on rebind) while the session is listed under the id
    // DorkOS minted. Exactly one key is read — the canonical one.
    const sessions = [makeSession('request-id', 'fake')];
    const port = makePort({ canonical: { permissionMode: 'plan' } }, { 'request-id': 'canonical' });

    overlayStoredSettings(sessions, port);

    expect(port.readKeys).toEqual([['canonical']]);
    expect(sessions[0]!.permissionMode).toBe('plan');
  });

  it('reads the canonical key ONLY — a row under a retired id is not consulted', () => {
    // No reader chooses among keys (DOR-493). A row can only be stranded under a
    // retired id if the re-key failed to run, and answering from it would make
    // the mode depend on which id the caller happened to ask by.
    const sessions = [makeSession('request-id', 'fake')];
    const port = makePort(
      { 'request-id': { permissionMode: 'acceptEdits' } },
      { 'request-id': 'canonical' }
    );

    overlayStoredSettings(sessions, port);

    expect(port.readKeys).toEqual([['canonical']]);
    expect(sessions[0]!.permissionMode).toBe('default');
  });

  it('reads every key in ONE batch query — no N+1', () => {
    const sessions = [makeSession('a', 'fake'), makeSession('b', 'fake'), makeSession('c', 'fake')];
    const port = makePort({ b: { permissionMode: 'plan' } });

    overlayStoredSettings(sessions, port);

    expect(port.getSessionSettingsMany).toHaveBeenCalledTimes(1);
    expect(port.readKeys[0]).toEqual(['a', 'b', 'c']);
    expect(sessions.map((s) => s.permissionMode)).toEqual(['default', 'plan', 'default']);
  });

  it('dedupes keys when two listed sessions resolve to the same canonical id', () => {
    // A resume-as-new leaves the old transcript listed alongside the new one;
    // both resolve to the runtime's current canonical id.
    const sessions = [makeSession('old', 'fake'), makeSession('new', 'fake')];
    const port = makePort({ new: { permissionMode: 'bypassPermissions' } }, { old: 'new' });

    overlayStoredSettings(sessions, port);

    // 'new' is queried once even though both sessions resolve to it.
    expect(port.readKeys[0]).toEqual(['new']);
    expect(sessions[0]!.permissionMode).toBe('bypassPermissions');
    expect(sessions[1]!.permissionMode).toBe('bypassPermissions');
  });

  it('falls back to the raw id for a session tagged with an unregistered runtime', () => {
    const sessions = [makeSession('s1', 'gone')];
    const port = makePort({ s1: { permissionMode: 'acceptEdits' } }, {}, ['fake']);

    overlayStoredSettings(sessions, port);

    expect(port.readKeys[0]).toEqual(['s1']);
    expect(sessions[0]!.permissionMode).toBe('acceptEdits');
  });

  it('leaves runtime-derived values alone when nothing is persisted', () => {
    const sessions = [makeSession('s1', 'fake')];
    sessions[0]!.permissionMode = 'plan';

    overlayStoredSettings(sessions, makePort({}));

    expect(sessions[0]!.permissionMode).toBe('plan');
  });

  it('skips the query entirely for an empty list', () => {
    const port = makePort({});

    overlayStoredSettings([], port);

    expect(port.getSessionSettingsMany).not.toHaveBeenCalled();
  });
});

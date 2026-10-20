/** Bounded client-local view choices; resource lifetimes remain owned by their services. */
export interface PanelViewPreference {
  opened: string[];
  closed: string[];
}
export type PanelViewPreferences = Record<string, PanelViewPreference>;
export const PANEL_VIEW_PREFERENCES_STORAGE_KEY = 'dorkos-panel-views-v1';

/** Read validated bounded preferences without requiring browser storage. */
export function readPanelViewPreferences(): PanelViewPreferences {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(PANEL_VIEW_PREFERENCES_STORAGE_KEY) ?? '{}'
    );
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value)
        .slice(-50)
        .filter(
          ([, entry]) =>
            entry &&
            Array.isArray(entry.opened) &&
            Array.isArray(entry.closed) &&
            entry.opened.length <= 100 &&
            entry.closed.length <= 100 &&
            [...entry.opened, ...entry.closed].every((id: unknown) => typeof id === 'string')
        )
    );
  } catch {
    return {};
  }
}

/** Persist after committing the same choices to memory; unavailable storage is harmless. */
export function writePanelViewPreferences(preferences: PanelViewPreferences): void {
  try {
    localStorage.setItem(PANEL_VIEW_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    /* In-memory views still work. */
  }
}

/** Collision-safe identity for one document owner's session and directory. */
export function documentPanelScope(sessionId: string | null, cwd: string | null): string {
  return `session:${JSON.stringify([sessionId, cwd])}`;
}

/** Exact historical scope retained while migrating existing local choices. */
export function legacyDocumentPanelScope(sessionId: string | null, cwd: string | null): string {
  return `session:${sessionId ?? ''}:${cwd ?? ''}`;
}

function remapClosed(
  preferences: PanelViewPreferences,
  remap: (id: string) => string
): PanelViewPreferences {
  let changed = false;
  const next = Object.fromEntries(
    Object.entries(preferences).map(([key, entry]) => {
      const closed = entry.closed.map((id) => {
        const nextId = remap(id);
        if (nextId !== id) changed = true;
        return nextId;
      });
      return [key, { ...entry, closed: [...new Set(closed)].slice(-100) }];
    })
  );
  return changed ? next : preferences;
}

/** Transfer only this owner's exact document ID as an optimistic row settles. */
export function remapClosedPanelDocument(
  preferences: PanelViewPreferences,
  scopes: string[],
  pendingId: string,
  serverId: string
): PanelViewPreferences {
  const keys = new Map(
    scopes.map((scope) => [`${scope}:resource/${pendingId}`, `${scope}:resource/${serverId}`])
  );
  return remapClosed(preferences, (id) => keys.get(id) ?? id);
}

/** Carry document choices with the same conversation, without matching neighboring scope prefixes. */
export function remapClosedPanelScope(
  preferences: PanelViewPreferences,
  previousScope: string,
  nextScope: string
): PanelViewPreferences {
  const prefix = `${previousScope}:resource/`;
  const remapped = remapClosed(preferences, (id) =>
    id.startsWith(prefix) && !id.startsWith(`${prefix}terminal/`)
      ? `${nextScope}:resource/${id.slice(prefix.length)}`
      : id
  );
  const previousKey = `documents:${previousScope}`;
  const nextKey = `documents:${nextScope}`;
  if (previousKey === nextKey || !remapped[previousKey]) return remapped;
  const previous = remapped[previousKey];
  const current = remapped[nextKey] ?? { opened: [], closed: [] };
  return Object.fromEntries(
    [
      ...Object.entries(remapped).filter(([key]) => key !== previousKey && key !== nextKey),
      [
        nextKey,
        {
          opened: [...new Set([...previous.opened, ...current.opened])].slice(-100),
          closed: [...new Set([...previous.closed, ...current.closed])].slice(-100),
        },
      ],
    ].slice(-50)
  );
}

/** An explicit reopen removes only exact resource-owner keys, including legacy buckets. */
export function reopenPanelResourcePreferences(
  preferences: PanelViewPreferences,
  keys: string[]
): PanelViewPreferences {
  return Object.fromEntries(
    Object.entries(preferences).map(([key, entry]) => [
      key,
      { ...entry, closed: entry.closed.filter((id) => !keys.includes(id)) },
    ])
  );
}

/** Carry exact encoded document owners even when their conversation is not on screen. */
export function remapClosedPanelSession(
  preferences: PanelViewPreferences,
  retiredId: string,
  canonicalId: string,
  knownCwds: (string | null)[]
): PanelViewPreferences {
  const directories = new Set(knownCwds);
  for (const entry of Object.values(preferences))
    for (const key of entry.closed) {
      const end = key.lastIndexOf(':resource/');
      if (!key.startsWith('session:[') || end < 0) continue;
      try {
        const owner: unknown = JSON.parse(key.slice('session:'.length, end));
        if (
          Array.isArray(owner) &&
          owner.length === 2 &&
          owner[0] === retiredId &&
          (owner[1] === null || typeof owner[1] === 'string')
        )
          directories.add(owner[1]);
      } catch {
        /* Invalid historical keys cannot name a different owner. */
      }
    }
  let next = preferences;
  for (const cwd of directories) {
    const target = documentPanelScope(canonicalId, cwd);
    next = remapClosedPanelScope(
      remapClosedPanelScope(next, documentPanelScope(retiredId, cwd), target),
      legacyDocumentPanelScope(retiredId, cwd),
      target
    );
  }
  return next;
}

import path from 'path';

/**
 * A startup notice about how a configured directory boundary relates to the
 * user's home directory, or `null` when the boundary is home (or inside it) and
 * there is nothing worth saying.
 */
export interface BoundaryNotice {
  /** `'warn'` for a genuine over-broad boundary; `'info'` for a benign one. */
  level: 'warn' | 'info';
  /** The ready-to-print, human-readable message. */
  message: string;
}

/**
 * Classify a configured directory boundary relative to the user's home
 * directory so the startup message tells the truth.
 *
 * There are three cases, and only the first is a real warning:
 *
 * - **Ancestor of home** (e.g. `/` or `/home` when home is `/home/node`): the
 *   boundary sits *above* home, so it genuinely grants access to system
 *   directories. Returns a `'warn'`.
 * - **Outside home, not an ancestor** (e.g. `/workspace` when home is
 *   `/home/node` — the documented Docker project mount): the boundary is a
 *   sibling/outside path. It grants access outside your home directory, scoped
 *   to that one path, and exposes no system directories. Returns an `'info'`.
 * - **Home or inside home**: the safe default. Returns `null`.
 *
 * @param boundary - The resolved (absolute) boundary path.
 * @param home - The user's home directory (absolute).
 * @returns A notice to print, or `null` when the boundary is home or below it.
 */
export function classifyBoundary(boundary: string, home: string): BoundaryNotice | null {
  const homeWithSep = home.endsWith(path.sep) ? home : home + path.sep;
  const boundaryWithSep = boundary.endsWith(path.sep) ? boundary : boundary + path.sep;

  // Boundary is home itself or a descendant of home — the safe default.
  if (boundary === home || boundary.startsWith(homeWithSep)) {
    return null;
  }

  // Boundary is an ancestor of home (home lives inside the boundary), e.g. "/"
  // or "/home" for a "/home/node" home. This grants access to system
  // directories that sit above the user's home.
  if (home.startsWith(boundaryWithSep)) {
    return {
      level: 'warn',
      message:
        `[Warning] Directory boundary "${boundary}" is above home directory "${home}". ` +
        `This grants access to system directories.`,
    };
  }

  // Boundary is outside home but not an ancestor of it (e.g. "/workspace" for a
  // "/home/node" home — the documented Docker mount). Access is granted outside
  // your home directory, scoped to that path; no system directories are exposed.
  return {
    level: 'info',
    message:
      `[Info] Directory boundary "${boundary}" is outside your home directory "${home}". ` +
      `Access is scoped to that path.`,
  };
}

/**
 * The pure decision table an install over an existing root applies to every
 * entry in it (spec `marketplace-package-file-ownership` §4): carry it, save
 * it aside, save the new default beside it, or drop it.
 *
 * @module services/marketplace/lib/records/carry-plan
 */
import {
  AGENT_IDENTITY_FILES,
  matchesUserEditable,
  UNINSTALLED_AGENT_PATH,
} from '@dorkos/marketplace';
import type { PackageFileNotice } from '@dorkos/shared/marketplace-schemas';
import { savedFileCandidates, savedFolderCandidates } from '../saved-copies/saved-copies.js';
import { type InstalledFiles, LegacyInstallError, isNeverCarried } from './installed-files.js';
import { type TreeScan, isAtOrUnder } from './tree-scan.js';

/** One step of a {@link CarryOverPlan}. Paths are root-relative POSIX. */
export type CarryAction =
  /** Copy the live entry at `path` into the staged tree at `path`, replacing what is there. */
  | { kind: 'carry'; path: string }
  /** Copy the live entry at `path` into the staged tree at `savedAs`. */
  | { kind: 'carry-as'; path: string; savedAs: string }
  /** Copy the whole live directory at `path` into the staged tree at `path`. */
  | { kind: 'carry-dir'; path: string }
  /** Copy the whole live directory at `path` into the staged tree at `savedAs`. */
  | { kind: 'carry-dir-as'; path: string; savedAs: string }
  /** Move the staged file at `path` to `savedAs`, then copy the live entry at `path` over it. */
  | { kind: 'save-new-as'; path: string; savedAs: string }
  /** Delete the staged file at `path` (the person deleted an editable default). */
  | { kind: 'drop'; path: string }
  /** A special file in the live root: never copied. */
  | { kind: 'skip-special'; path: string };

/** What {@link planCarryOver} decided. */
export interface CarryOverPlan {
  /** Steps, in the order they must run. */
  actions: CarryAction[];
  /** What to tell the person. */
  notices: PackageFileNotice[];
  /** `.dork-new` copies written: path → hash, to add to the new record's `files`. */
  addedFiles: Record<string, string>;
  /** The new record's `pendingDefaults`. */
  pendingDefaults: Record<string, string>;
}

/** What {@link planCarryOver} needs to know about the staged tree. */
export interface StagedFacts {
  /** `lstat`-backed: what occupies `posixPath` in the staged tree (case rules of the volume apply). */
  kindOf(posixPath: string): 'file' | 'dir' | 'other' | 'missing';
}

/** Inputs to {@link planCarryOver}. */
export interface CarryOverInput {
  /** The live root's record, or `null` when it has none. */
  rOld: InstalledFiles | null;
  /** Whether the live root has a package identity (a manifest or plugin.json). */
  oldHasIdentity: boolean;
  /** The staged record. */
  rNew: InstalledFiles;
  /** A {@link scanTree} of the live root, hashing every path in `rOld` or `rNew`. */
  live: TreeScan;
  /** The staged tree. */
  staged: StagedFacts;
  /** The live root's path, for error messages only. */
  liveRoot: string;
}

/**
 * Decide what an install over an existing root does with every entry in it.
 * Pure: every filesystem fact arrives through the input. The rows are the
 * spec's §4 table (`specs/marketplace-package-file-ownership`), numbered in
 * comments below.
 *
 * @param input - See {@link CarryOverInput}.
 * @throws {LegacyInstallError} When the live root has an identity but no record.
 */
export function planCarryOver(input: CarryOverInput): CarryOverPlan {
  const { rNew, live, staged } = input;
  if (input.rOld === null && input.oldHasIdentity) throw new LegacyInstallError(input.liveRoot);
  const rOld = input.rOld;
  const oldFiles = rOld?.files ?? {};
  const newFiles = rNew.files;
  const isAgent = rNew.package.type === 'agent';
  const identityFiles: readonly string[] = isAgent ? AGENT_IDENTITY_FILES : [];
  const ownedPaths = [...(rOld?.ownedPaths ?? []), ...rNew.ownedPaths];
  const pendingOld = rOld?.pendingDefaults ?? {};
  const pendingFor = new Map(Object.entries(pendingOld).map(([dn, p]) => [p, dn]));
  const skipped = (p: string): boolean => isNeverCarried(p, ownedPaths);
  const editable = (p: string): boolean =>
    p in newFiles
      ? matchesUserEditable(p, rNew.userEditable)
      : matchesUserEditable(p, rOld?.userEditable ?? []);
  const shipped = (p: string): boolean => p in newFiles;

  // Directories carried as one unit: no recorded or newly shipped file beneath.
  const recordedPaths = [...Object.keys(oldFiles), ...Object.keys(newFiles), ...ownedPaths];
  const unitDirs: string[] = [];
  for (const dir of [...live.dirs].sort()) {
    if (unitDirs.some((u) => isAtOrUnder(dir, u))) continue;
    if (skipped(dir)) continue;
    if (recordedPaths.some((p) => p.startsWith(`${dir}/`))) continue;
    // A directory holding something that is never carried is walked file by file.
    if ([...live.entries.keys()].some((p) => isAtOrUnder(p, dir) && skipped(p))) continue;
    unitDirs.push(dir);
  }
  const inUnit = (p: string): boolean => unitDirs.some((u) => isAtOrUnder(p, u));
  const liveSymlinks = [...live.entries].filter(([, e]) => e.kind === 'symlink').map(([p]) => p);
  /** A path hidden behind a symlinked directory in the live root: never read through the link. */
  const underLiveSymlink = (p: string): boolean => liveSymlinks.some((l) => p.startsWith(`${l}/`));

  type Decision =
    | { kind: 'carry'; path: string }
    | { kind: 'carry-identity'; path: string }
    | { kind: 'carry-saved'; path: string; notice?: PackageFileNotice['outcome'] }
    | { kind: 'save-new'; path: string; pending?: string }
    | { kind: 'drop'; path: string }
    | { kind: 'skip-special'; path: string }
    | { kind: 'kept-no-longer-shipped'; path: string };
  const decisions: Decision[] = [];

  const paths = new Set<string>([
    ...Object.keys(oldFiles),
    ...live.entries.keys(),
    ...Object.keys(newFiles),
  ]);
  for (const p of [...paths].sort()) {
    if (skipped(p)) continue;
    // An unchanged pending `.dork-new` is the package's copy: refreshed or
    // dropped by its shadowed file's row. One the person edited is theirs.
    if (p in pendingOld && live.entries.get(p)?.hash === oldFiles[p]) continue;
    if (inUnit(p)) {
      if (live.entries.get(p)?.kind === 'special')
        decisions.push({ kind: 'skip-special', path: p });
      continue;
    }
    const entry = live.entries.get(p);
    if (entry?.kind === 'special') {
      decisions.push({ kind: 'skip-special', path: p });
      continue;
    }
    if (identityFiles.includes(p) || p === UNINSTALLED_AGENT_PATH) {
      // The agent's own: carried as-is; a shipped copy only seeds an absent file.
      if (entry) decisions.push({ kind: 'carry-identity', path: p });
      continue;
    }
    const recorded = p in oldFiles;
    const ships = shipped(p);
    const liveHash = entry?.kind === 'file' ? entry.hash : undefined;
    const sameAsNew = ships && liveHash !== undefined && liveHash === newFiles[p];
    const pending = pendingFor.get(p);

    if (!entry) {
      // Behind a live symlink: the link itself is carried as the person's (and
      // collides with the new version's directory); the new copy stands.
      if (underLiveSymlink(p)) continue;
      // Rows 0, 3a, 3b, 4: nothing live at this path.
      if (recorded && ships && editable(p)) decisions.push({ kind: 'drop', path: p }); // 3a
      continue; // 0, 3b: the new copy stands; 4: gone.
    }
    const edited = !recorded || entry.kind !== 'file' || liveHash !== oldFiles[p];
    if (recorded && !edited) continue; // Rows 1, 2: the package's own, unchanged.

    if (recorded) {
      // Rows 5-8: a shipped file the person changed.
      if (ships && !editable(p)) {
        if (!sameAsNew) decisions.push({ kind: 'carry-saved', path: p, notice: 'replaced-edit' }); // 5
      } else if (ships) {
        const defaultChanged = newFiles[p] !== oldFiles[p];
        if (!sameAsNew && (defaultChanged || pending)) {
          decisions.push({ kind: 'save-new', path: p, pending }); // 6, with a .dork-new
        } else if (!sameAsNew) {
          decisions.push({ kind: 'carry', path: p }); // 6, default unchanged
        }
      } else if (!editable(p)) {
        decisions.push({ kind: 'carry-saved', path: p, notice: 'replaced-edit' }); // 7
      } else {
        decisions.push({ kind: 'kept-no-longer-shipped', path: p }); // 8
      }
      continue;
    }
    // Rows 9-11: the person's own file.
    if (!ships) {
      decisions.push({ kind: 'carry', path: p }); // 9
    } else if (!editable(p)) {
      if (!sameAsNew) decisions.push({ kind: 'carry-saved', path: p, notice: 'replaced-edit' }); // 10
    } else if (!sameAsNew) {
      decisions.push({ kind: 'save-new', path: p, pending }); // 11
    }
  }

  // Destinations fixed before any saved name is chosen, so a new name never
  // lands on something another step writes.
  const fixed = new Set<string>();
  for (const d of decisions) {
    if (
      d.kind === 'carry' ||
      d.kind === 'carry-identity' ||
      d.kind === 'save-new' ||
      d.kind === 'kept-no-longer-shipped'
    )
      fixed.add(d.path);
  }
  for (const u of unitDirs) fixed.add(u);
  const allocated = new Set<string>();
  const taken = (p: string): boolean => {
    const lower = p.toLowerCase();
    return (
      staged.kindOf(p) !== 'missing' ||
      // A folder saved by an earlier update sits in the live root and is carried.
      live.entries.has(p) ||
      live.dirs.has(p) ||
      [...fixed, ...allocated].some((q) => q === p || q.toLowerCase() === lower)
    );
  };
  const firstUntaken = (candidates: Iterable<string>): string => {
    for (const candidate of candidates) {
      if (!taken(candidate)) {
        allocated.add(candidate);
        return candidate;
      }
    }
    /* c8 ignore next */
    throw new Error('unreachable');
  };
  /** A file saved beside itself. */
  const allocate = (p: string, suffix: '.dork-old' | '.dork-new'): string =>
    firstUntaken(savedFileCandidates(p, suffix));
  /** A folder saved under `.dork/saved`, where no loader looks (DOR-2340). */
  const allocateFolder = (dir: string): string => firstUntaken(savedFolderCandidates(dir));
  /** The nearest ancestor of `p` the staged tree holds as something other than a directory. */
  const blockingAncestor = (p: string): string | undefined => {
    const segments = p.split('/');
    for (let i = 1; i < segments.length; i++) {
      const ancestor = segments.slice(0, i).join('/');
      const k = staged.kindOf(ancestor);
      if (k !== 'missing' && k !== 'dir') return ancestor;
    }
    return undefined;
  };
  const renamedAncestors = new Map<string, string>();
  /**
   * Where to save `p` aside: a file beside itself (`p.dork-old`, first free
   * name), a folder under `.dork/saved`; or, when an ancestor is a file in the
   * new version, the same relative path inside that ancestor's saved folder,
   * shared by everything beneath it.
   */
  const saveTarget = (p: string, kind: 'file' | 'dir'): string => {
    const ancestor = blockingAncestor(p);
    if (ancestor === undefined) {
      return kind === 'dir' ? allocateFolder(p) : allocate(p, '.dork-old');
    }
    let renamed = renamedAncestors.get(ancestor);
    if (renamed === undefined) {
      renamed = allocateFolder(ancestor);
      renamedAncestors.set(ancestor, renamed);
    }
    return `${renamed}${p.slice(ancestor.length)}`;
  };
  /** A write to `p` collides when the staged tree has something there the new version does not ship at exactly `p`. */
  const collides = (p: string, want: 'file' | 'dir'): boolean => {
    if (blockingAncestor(p) !== undefined) return true;
    const k = staged.kindOf(p);
    if (k === 'missing') return false;
    if (want === 'file' && k === 'file' && p in newFiles) return false;
    return true;
  };

  const plan: CarryOverPlan = { actions: [], notices: [], addedFiles: {}, pendingDefaults: {} };
  for (const u of unitDirs) {
    if (collides(u, 'dir')) {
      fixed.delete(u);
      const savedAs = saveTarget(u, 'dir');
      plan.actions.push({ kind: 'carry-dir-as', path: u, savedAs });
      plan.notices.push({ path: u, outcome: 'replaced-edit', savedAs });
    } else {
      plan.actions.push({ kind: 'carry-dir', path: u });
    }
  }
  for (const d of decisions) {
    switch (d.kind) {
      case 'skip-special':
        plan.actions.push({ kind: 'skip-special', path: d.path });
        plan.notices.push({ path: d.path, outcome: 'skipped-special' });
        break;
      case 'drop':
        plan.actions.push({ kind: 'drop', path: d.path });
        break;
      case 'carry-identity': {
        // Identity files are never recorded, so a shipped seed is not in
        // `newFiles`; it is still only a seed, and the agent's own file
        // replaces it. Only a directory (or a file ancestor) there is a clash.
        const k = staged.kindOf(d.path);
        if (blockingAncestor(d.path) === undefined && (k === 'missing' || k === 'file')) {
          plan.actions.push({ kind: 'carry', path: d.path });
          break;
        }
        fixed.delete(d.path);
        const savedAs = saveTarget(d.path, 'file');
        plan.actions.push({ kind: 'carry-as', path: d.path, savedAs });
        plan.notices.push({ path: d.path, outcome: 'replaced-edit', savedAs });
        break;
      }
      case 'carry':
      case 'kept-no-longer-shipped': {
        if (!(d.path in newFiles) && collides(d.path, 'file')) {
          // Something the new version put here under another spelling or kind.
          fixed.delete(d.path);
          const savedAs = saveTarget(d.path, 'file');
          plan.actions.push({ kind: 'carry-as', path: d.path, savedAs });
          plan.notices.push({ path: d.path, outcome: 'replaced-edit', savedAs });
          break;
        }
        plan.actions.push({ kind: 'carry', path: d.path });
        if (d.kind === 'kept-no-longer-shipped') {
          plan.notices.push({ path: d.path, outcome: 'kept-no-longer-shipped' });
        }
        break;
      }
      case 'carry-saved': {
        const savedAs = saveTarget(d.path, 'file');
        plan.actions.push({ kind: 'carry-as', path: d.path, savedAs });
        plan.notices.push({ path: d.path, outcome: d.notice ?? 'replaced-edit', savedAs });
        break;
      }
      case 'save-new': {
        // Reuse the pending `.dork-new` name: it is the package's copy to refresh.
        const savedAs = d.pending ?? allocate(d.path, '.dork-new');
        if (d.pending) allocated.add(d.pending);
        plan.actions.push({ kind: 'save-new-as', path: d.path, savedAs });
        plan.notices.push({ path: d.path, outcome: 'kept-edit', savedAs });
        plan.addedFiles[savedAs] = newFiles[d.path];
        plan.pendingDefaults[savedAs] = d.path;
        break;
      }
    }
  }
  return plan;
}

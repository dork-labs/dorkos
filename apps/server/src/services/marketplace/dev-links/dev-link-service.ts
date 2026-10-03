/**
 * Dev links: run a marketplace `plugin` or `skill-pack` straight from a folder
 * on this computer (DOR-2696, spec `marketplace-dev-link` §2).
 *
 * A link sits in the package's normal slot (`{dorkHome}/plugins/<name>` or
 * `<project>/.dork/plugins/<name>`), so every path a package uses stays the
 * same. The registry record (`registry.ts`) is what makes it a dev link. An
 * installed copy already in the slot is set aside beside it under the
 * `.dorkos-devlink-parked` marker, never deleted, and comes back on unlink.
 *
 * Every mutation runs under the install target lock on the slot, the same lock
 * install and uninstall take (DOR-711), so a link cannot interleave with an
 * install of the same package. Removing a link is always `unlink` (or `rmdir`
 * for a Windows junction) and never a recursive delete: a recursive delete
 * through a junction empties the developer's own folder.
 *
 * Nothing here decides WHO may link. That is the `marketplace.link`
 * capability's tier gate (destructive, no permission area) and the routes'
 * `trustedCaller` bar; this service only does what a person already approved.
 *
 * @module services/marketplace/dev-links/dev-link-service
 */
import {
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rmdir,
  stat,
  symlink,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import type { ExtensionApprovedSource } from '@dorkos/shared/config-schema';
import {
  DevLinkPackageNameSchema,
  MARKETPLACE_DEVLINK_PARKED_MARKER,
  type DevLinkPreview,
  type DevLinkRecord,
  type DevLinkState,
  type DevLinkStatus,
} from '@dorkos/shared/marketplace-schemas';
import { getBoundary, isContained } from '../../../lib/boundary.js';
import { readRunnableDeclarations } from '../preview/permission-preview.js';
import { disclosedEffectsOf } from '../preview/disclosed-effects.js';
import { readInstalledIdentity } from '../installed-scanner.js';
import { withInstallTargetLock } from '../transaction.js';
import type { NotifyPluginsChanged } from '../types.js';
import { DevLinkError } from './errors.js';
import { canonicalSlotPath, devLinkStateOf, readDevLinks, updateDevLinks } from './registry.js';

/** The approval fields of `config.extensions` a dev link reads and writes. */
export interface DevLinkApprovals {
  /** Extension ids a person approved to run code. */
  approvedToRun: string[];
  /** The copy each approval is for. */
  approvedSources: Record<string, ExtensionApprovedSource>;
}

/** Where a dev link records the person's yes for the extensions it carries. */
export interface DevLinkApprovalStore {
  /** Read the current approvals. */
  read(): DevLinkApprovals;
  /** Replace the approvals with `next`, keeping every other extensions setting. */
  write(next: DevLinkApprovals): void;
}

/** The filesystem calls that change a slot, a seam so a test can make one fail. */
export interface DevLinkFs {
  /** `fs.rename`. */
  rename: typeof rename;
  /** `fs.symlink`. */
  symlink: typeof symlink;
  /** `fs.unlink`: removes a symlink, or a junction on Windows. */
  unlink: typeof unlink;
  /** `fs.rmdir` (never recursive): the fallback for a junction `unlink` refuses. */
  rmdir: typeof rmdir;
}

/** What {@link DevLinkService} needs. */
export interface DevLinkServiceDeps {
  /** Resolved DorkOS data directory. */
  dorkHome: string;
  /** Where extension approvals live (`config.extensions`). */
  approvals: DevLinkApprovalStore;
  /** The marketplace's post-change notifier: refreshes plugins and projections. */
  onPluginsChanged: NotifyPluginsChanged;
  /** Ask extensions to re-scan, without waiting. */
  refreshExtensions: () => void;
  /** The directory boundary a linked folder must sit inside; defaults to the server's. */
  boundary?: () => string;
  /** The platform, for the link type; defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Filesystem seam; defaults to `node:fs/promises`. */
  fs?: Partial<DevLinkFs>;
}

/** Which folder to link, and where. */
export interface DevLinkTarget {
  /** Absolute real path of the working folder. */
  path: string;
  /** `global` for every session, `project` for one project. */
  scope: 'global' | 'project';
  /** The project folder, for `scope: 'project'`. */
  projectPath?: string;
}

/** A link request: the target plus the explicit switch and where it was approved. */
export interface DevLinkRequest extends DevLinkTarget {
  /** Set the installed copy in the slot aside (the explicit switch). */
  replaceInstalled?: boolean;
  /** Where the person said yes. */
  via: DevLinkRecord['linkedVia'];
}

/** Which dev link to unlink. */
export interface DevUnlinkRequest {
  /** The package name. */
  name: string;
  /** `global` or `project`. */
  scope: 'global' | 'project';
  /** The project folder, for `scope: 'project'`. */
  projectPath?: string;
}

/** What unlink did. */
export interface DevUnlinkResult {
  /** `installed` when the set-aside copy is back, `removed` when the package is gone. */
  restored: 'installed' | 'removed';
  /**
   * Set when an installed copy was set aside but could not be put back,
   * because something else now holds the slot: where it still is.
   */
  parkedLeftAt?: string;
}

/** The listing: every recorded dev link and its state. */
export interface DevLinkListing {
  /** One entry per record. */
  links: DevLinkStatus[];
  /** Set when the registry file cannot be read; no slot counts as dev-linked then. */
  registryUnreadable?: string;
}

/** Everything validation worked out about a link, before anything changes. */
interface LinkPlan {
  preview: DevLinkPreview;
  projectPath: string | undefined;
  /** What the slot holds now. */
  slotHolds: 'nothing' | 'adoptable-link' | 'installed';
}

/** The folder a package carries its extensions in. */
const EXTENSIONS_DIR = path.join('.dork', 'extensions');

/**
 * Creates, lists and removes dev links. One instance per server.
 */
export class DevLinkService {
  private readonly fs: DevLinkFs;

  /**
   * Build the service on its dependencies.
   *
   * @param deps - See {@link DevLinkServiceDeps}.
   */
  constructor(private readonly deps: DevLinkServiceDeps) {
    this.fs = { rename, symlink, unlink, rmdir, ...deps.fs };
  }

  /**
   * Say what linking a folder would do, changing nothing.
   *
   * @param target - The folder and scope.
   * @returns The preview the card shows.
   * @throws {DevLinkError} With the first reason it cannot be linked.
   */
  async preview(target: DevLinkTarget): Promise<DevLinkPreview> {
    return (await this.plan(target)).preview;
  }

  /**
   * Link a folder: set any installed copy aside, put the link in the slot,
   * record it, approve the extensions it carries now, and tell the rest of
   * DorkOS. Any failure after the installed copy was set aside puts it back.
   *
   * @param request - What a person approved.
   * @returns The new dev link's status.
   * @throws {DevLinkError} With the first reason it cannot be linked.
   */
  async link(request: DevLinkRequest): Promise<DevLinkStatus> {
    const first = await this.plan(request);
    return withInstallTargetLock(first.preview.slot, async () => {
      // Checked again under the lock: the slot may have changed since.
      const plan = await this.plan(request);
      if (plan.slotHolds === 'installed' && !request.replaceInstalled) {
        throw slotTaken(plan.preview);
      }
      const { preview, projectPath } = plan;
      const slot = preview.slot;
      const parked =
        plan.slotHolds === 'installed' ? `${slot}${MARKETPLACE_DEVLINK_PARKED_MARKER}` : undefined;
      const undo: Array<() => Promise<void>> = [];
      try {
        if (parked) {
          await this.fs.rename(slot, parked);
          undo.push(() => this.fs.rename(parked, slot));
        }
        if (plan.slotHolds !== 'adoptable-link') {
          await mkdir(path.dirname(slot), { recursive: true });
          await this.fs.symlink(preview.path, slot, this.linkType());
          undo.push(() => this.removeLink(slot));
        }
        const restoreExtensions = this.capturedApprovals(preview);
        const record: DevLinkRecord = {
          name: preview.name,
          type: preview.type,
          scope: preview.scope,
          ...(projectPath !== undefined && { projectPath }),
          slot,
          target: preview.path,
          ...(parked !== undefined && { parked }),
          ...(Object.keys(restoreExtensions).length > 0 && {
            restoreApprovals: { extensions: restoreExtensions },
          }),
          linkedAt: new Date().toISOString(),
          linkedVia: request.via,
        };
        await updateDevLinks(this.deps.dorkHome, (links) => [...links, record], {
          replaceUnreadable: true,
        });
        undo.push(() =>
          updateDevLinks(this.deps.dorkHome, (links) => links.filter((l) => !sameLink(l, record)))
        );
        this.approveExtensions(preview);
        this.notify(preview.name, projectPath, 'install');
        return this.statusOf(record, 'active');
      } catch (err) {
        for (const step of undo.reverse()) {
          await step().catch(() => undefined);
        }
        throw err;
      }
    });
  }

  /**
   * Remove a dev link from whatever state it is in: take the link out (never
   * its folder), put a set-aside installed copy back with the approvals it
   * had, forget the link's own approvals, drop the record, and tell the rest
   * of DorkOS. A slot that no longer holds the recorded link is never touched.
   *
   * @param request - Which dev link.
   * @returns What came back.
   * @throws {DevLinkError} `dev_link_not_found` when there is no such dev link.
   */
  async unlink(request: DevUnlinkRequest): Promise<DevUnlinkResult> {
    const projectPath =
      request.scope === 'project' ? await this.canonicalProject(request.projectPath) : undefined;
    const record = await this.findRecord(request.name, request.scope, projectPath);
    return withInstallTargetLock(record.slot, async () => {
      const state = await devLinkStateOf(record);
      if (state === 'active' || state === 'folder-missing') await this.removeLink(record.slot);
      let restored: DevUnlinkResult['restored'] = 'removed';
      let parkedLeftAt: string | undefined;
      if (record.parked && (await exists(record.parked))) {
        if (await exists(record.slot)) {
          parkedLeftAt = record.parked;
        } else {
          await this.fs.rename(record.parked, record.slot);
          restored = 'installed';
        }
      }
      this.forgetApprovals(record);
      await updateDevLinks(this.deps.dorkHome, (links) =>
        links.filter((link) => !sameLink(link, record))
      );
      this.notify(
        record.name,
        record.projectPath,
        restored === 'installed' ? 'install' : 'uninstall'
      );
      return { restored, ...(parkedLeftAt !== undefined && { parkedLeftAt }) };
    });
  }

  /**
   * Every recorded dev link and the state it is in on disk now. Never repairs:
   * the listing says what happened and unlink finishes the job.
   *
   * @returns The records with their states, or why the registry cannot be read.
   */
  async reconcile(): Promise<
    { records: Array<{ record: DevLinkRecord; state: DevLinkState }> } | { unreadable: string }
  > {
    const reading = await readDevLinks(this.deps.dorkHome);
    if ('unreadable' in reading) return reading;
    const records: Array<{ record: DevLinkRecord; state: DevLinkState }> = [];
    for (const record of reading.links) {
      records.push({ record, state: await devLinkStateOf(record) });
    }
    return { records };
  }

  /**
   * The listing `GET /api/marketplace/dev-links` returns.
   *
   * @returns Every dev link with its state.
   */
  async list(): Promise<DevLinkListing> {
    const reconciled = await this.reconcile();
    if ('unreadable' in reconciled) {
      return { links: [], registryUnreadable: reconciled.unreadable };
    }
    const links: DevLinkStatus[] = [];
    for (const { record, state } of reconciled.records) {
      links.push(await this.statusOf(record, state));
    }
    return { links };
  }

  /**
   * Validate a link request in the spec's order, each refusal one sentence.
   *
   * @internal
   */
  private async plan(target: DevLinkTarget): Promise<LinkPlan> {
    const folder = await this.realFolder(target.path);
    const identity = await readInstalledIdentity(folder);
    if (!identity) {
      throw new DevLinkError('dev_link_not_a_package', 400, 'No package found in this folder.');
    }
    if (!DevLinkPackageNameSchema.safeParse(identity.name).success) {
      throw new DevLinkError(
        'dev_link_not_a_package',
        400,
        `The package name "${identity.name}" isn't valid. Use lowercase letters, digits and hyphens.`
      );
    }
    if (identity.type !== 'plugin' && identity.type !== 'skill-pack') {
      throw new DevLinkError(
        'dev_link_unsupported_type',
        400,
        `Only plugins and skill packs can run from a folder. This is ${articleFor(identity.type)}.`
      );
    }
    const projectPath =
      target.scope === 'project' ? await this.canonicalProject(target.projectPath) : undefined;
    const name = identity.name;
    const reading = await readDevLinks(this.deps.dorkHome);
    if (
      'links' in reading &&
      reading.links.some(
        (link) =>
          link.name === name && link.scope === target.scope && link.projectPath === projectPath
      )
    ) {
      throw new DevLinkError(
        'dev_link_exists',
        409,
        `${name} already runs from a dev link here. Unlink it first.`,
        { name }
      );
    }

    const slot = await canonicalSlotPath(
      projectPath === undefined
        ? path.join(this.deps.dorkHome, 'plugins', name)
        : path.join(projectPath, '.dork', 'plugins', name)
    );
    if (await exists(`${slot}${MARKETPLACE_DEVLINK_PARKED_MARKER}`)) {
      throw new DevLinkError(
        'dev_link_parked_exists',
        409,
        `An earlier set-aside copy of ${name} is still at ${slot}${MARKETPLACE_DEVLINK_PARKED_MARKER}. Move it first.`,
        { name }
      );
    }

    let slotHolds: LinkPlan['slotHolds'] = 'nothing';
    let replaces: DevLinkPreview['replaces'] = null;
    const slotStats = await lstat(slot).catch(() => null);
    if (slotStats?.isSymbolicLink()) {
      const pointsAt = await realpath(slot).catch(() => null);
      if (pointsAt !== folder) {
        throw new DevLinkError(
          'dev_link_slot_is_linked',
          409,
          `${name} is already linked to another folder. Remove that link first.`,
          { name }
        );
      }
      // A link made by hand to this very folder: adopt it, nothing to set aside.
      slotHolds = 'adoptable-link';
    } else if (slotStats) {
      const installed = await readInstalledIdentity(slot);
      slotHolds = 'installed';
      replaces = { version: installed?.version ?? 'unknown' };
    }

    const declared = await readRunnableDeclarations(folder);
    const preview: DevLinkPreview = {
      name,
      type: identity.type,
      ...(identity.declaredVersion !== undefined && { version: identity.declaredVersion }),
      path: folder,
      scope: target.scope,
      slot,
      replaces,
      effects: disclosedEffectsOf({ ...declared, schedules: [] }),
      extensions: await carriedExtensions(folder),
    };
    return { preview, projectPath, slotHolds };
  }

  /**
   * The folder to link, checked: absolute and its own real path, a readable
   * directory, inside the boundary, and not inside DorkOS's own data.
   *
   * @internal
   */
  private async realFolder(candidate: string): Promise<string> {
    if (!path.isAbsolute(candidate)) {
      throw new DevLinkError('dev_link_path_not_real', 400, 'Use the full path to the folder.');
    }
    const real = await realpath(candidate).catch(() => null);
    if (real === null) {
      throw new DevLinkError('dev_link_path_not_allowed', 400, "That folder doesn't exist.");
    }
    if (real !== candidate) {
      throw new DevLinkError(
        'dev_link_path_not_real',
        400,
        `That path is a link. Use ${real} instead.`,
        {
          realPath: real,
        }
      );
    }
    const isDir = await stat(real)
      .then((stats) => stats.isDirectory())
      .catch(() => false);
    if (!isDir || !(await readable(real))) {
      throw new DevLinkError(
        'dev_link_path_not_allowed',
        400,
        "That path isn't a folder DorkOS can read."
      );
    }
    const boundary = (this.deps.boundary ?? getBoundary)();
    if (!isContained(real, boundary)) {
      throw new DevLinkError(
        'dev_link_path_not_allowed',
        403,
        'That folder is outside the folders DorkOS may use.'
      );
    }
    const home = await realpath(this.deps.dorkHome).catch(() => path.resolve(this.deps.dorkHome));
    if (isContained(real, home)) {
      throw new DevLinkError(
        'dev_link_path_not_allowed',
        403,
        "A folder inside DorkOS's own data can't be linked."
      );
    }
    return real;
  }

  /**
   * The canonical project folder, which must exist.
   *
   * @internal
   */
  private async canonicalProject(projectPath: string | undefined): Promise<string> {
    const real = projectPath ? await realpath(projectPath).catch(() => null) : null;
    if (real === null) {
      throw new DevLinkError(
        'dev_link_project_not_found',
        400,
        "That project folder doesn't exist."
      );
    }
    return real;
  }

  /**
   * The recorded dev link for a name in a scope.
   *
   * @internal
   */
  private async findRecord(
    name: string,
    scope: 'global' | 'project',
    projectPath: string | undefined
  ): Promise<DevLinkRecord> {
    const reading = await readDevLinks(this.deps.dorkHome);
    if ('unreadable' in reading) {
      throw new DevLinkError('dev_link_not_found', 409, "Dev links can't be read right now.");
    }
    const record = reading.links.find(
      (link) => link.name === name && link.scope === scope && link.projectPath === projectPath
    );
    if (!record) {
      throw new DevLinkError(
        'dev_link_not_found',
        404,
        `${name} doesn't run from a dev link here.`,
        {
          name,
        }
      );
    }
    return record;
  }

  /**
   * The approvals the link's own would replace, kept so unlink can put them
   * back: for each extension the folder carries, whatever approval that id has
   * now, when it is a real one (approved to run, not already a dev link's).
   *
   * @internal
   */
  private capturedApprovals(preview: DevLinkPreview): Record<string, ExtensionApprovedSource> {
    const current = this.deps.approvals.read();
    const kept: Record<string, ExtensionApprovedSource> = {};
    for (const id of preview.extensions) {
      const source = current.approvedSources[id];
      if (source && !source.devLink && current.approvedToRun.includes(id)) kept[id] = source;
    }
    return kept;
  }

  /**
   * Record the person's yes for the extensions the folder carries now, bound
   * to this dev link (spec §4). A new extension added later asks on its own.
   *
   * @internal
   */
  private approveExtensions(preview: DevLinkPreview): void {
    if (preview.extensions.length === 0) return;
    const current = this.deps.approvals.read();
    const approvedToRun = [...current.approvedToRun];
    const approvedSources = { ...current.approvedSources };
    for (const id of preview.extensions) {
      if (!approvedToRun.includes(id)) approvedToRun.push(id);
      approvedSources[id] = {
        path: path.join(preview.slot, EXTENSIONS_DIR, id),
        plugin: preview.name,
        devLink: preview.path,
      };
    }
    this.deps.approvals.write({ approvedToRun, approvedSources });
  }

  /**
   * Forget every approval given to this dev link, putting back what it
   * replaced. An id whose approval has since moved to another copy is left
   * alone.
   *
   * @internal
   */
  private forgetApprovals(record: DevLinkRecord): void {
    const current = this.deps.approvals.read();
    const restore = record.restoreApprovals?.extensions ?? {};
    let approvedToRun = [...current.approvedToRun];
    const approvedSources = { ...current.approvedSources };
    let changed = false;
    for (const [id, source] of Object.entries(current.approvedSources)) {
      if (source.devLink !== record.target) continue;
      changed = true;
      const previous = restore[id];
      if (previous) {
        approvedSources[id] = previous;
        if (!approvedToRun.includes(id)) approvedToRun.push(id);
      } else {
        delete approvedSources[id];
        approvedToRun = approvedToRun.filter((approved) => approved !== id);
      }
    }
    if (changed) this.deps.approvals.write({ approvedToRun, approvedSources });
  }

  /**
   * Take a link out of its slot. `unlink` removes a symlink, and a junction on
   * Windows; `rmdir` (never recursive) is the fallback for a junction an older
   * runtime refuses to `unlink`. Neither can delete a file inside the folder.
   *
   * @internal
   */
  private async removeLink(slot: string): Promise<void> {
    try {
      await this.fs.unlink(slot);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      if (code !== 'EISDIR' && code !== 'EPERM') throw err;
      await this.fs.rmdir(slot);
    }
  }

  /** The link type for this platform: a junction on Windows, needing no privilege. */
  private linkType(): 'junction' | 'dir' {
    return (this.deps.platform ?? process.platform) === 'win32' ? 'junction' : 'dir';
  }

  /**
   * Tell the runtime and the extensions about the change. Never throws: the
   * change already happened.
   *
   * @internal
   */
  private notify(
    packageName: string,
    projectPath: string | undefined,
    action: 'install' | 'uninstall'
  ): void {
    try {
      this.deps.onPluginsChanged({ packageName, action, ...(projectPath && { projectPath }) });
      this.deps.refreshExtensions();
    } catch {
      // Both are fire-and-forget by contract; a throw here is not the link's failure.
    }
  }

  /**
   * One record as the listing reports it.
   *
   * @internal
   */
  private async statusOf(record: DevLinkRecord, state: DevLinkState): Promise<DevLinkStatus> {
    let parked: DevLinkStatus['parked'] = null;
    if (record.parked && (await exists(record.parked))) {
      const identity = await readInstalledIdentity(record.parked);
      parked = identity?.declaredVersion !== undefined ? { version: identity.declaredVersion } : {};
    }
    return {
      name: record.name,
      type: record.type,
      scope: record.scope,
      ...(record.projectPath !== undefined && { projectPath: record.projectPath }),
      path: record.target,
      state,
      parked,
      linkedAt: record.linkedAt,
    };
  }
}

/** The refusal for an installed copy in the slot without the explicit switch. */
function slotTaken(preview: DevLinkPreview): DevLinkError {
  const version = preview.replaces?.version ?? 'unknown';
  return new DevLinkError(
    'dev_link_slot_taken',
    409,
    `${preview.name} v${version} is installed. Choose to use your folder instead.`,
    { name: preview.name, installedVersion: version }
  );
}

/** Whether two records name the same dev link. */
function sameLink(a: DevLinkRecord, b: DevLinkRecord): boolean {
  return a.name === b.name && a.scope === b.scope && a.projectPath === b.projectPath;
}

/** Whether anything is at `target`, links included (dangling ones too). */
async function exists(target: string): Promise<boolean> {
  return lstat(target).then(
    () => true,
    () => false
  );
}

/** Whether a directory can be listed. */
async function readable(dir: string): Promise<boolean> {
  return readdir(dir).then(
    () => true,
    () => false
  );
}

/** "an agent", "a shape", ... for the unsupported-type sentence. */
function articleFor(type: string): string {
  return /^[aeiou]/.test(type) ? `an ${type}` : `a ${type}`;
}

/**
 * The extension ids a folder carries: each directory under `.dork/extensions`
 * holding an `extension.json`, sorted.
 *
 * @param folder - The package folder.
 */
async function carriedExtensions(folder: string): Promise<string[]> {
  const dir = path.join(folder, EXTENSIONS_DIR);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const ids: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (await exists(path.join(dir, entry.name, 'extension.json'))) ids.push(entry.name);
  }
  return ids.sort();
}

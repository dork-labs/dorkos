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
import type { ApprovedPermissionSet, ExtensionApprovedSource } from '@dorkos/shared/config-schema';
import { ExtensionManifestSchema } from '@dorkos/extension-api';
import { PACKAGE_TEXT_MAX_BYTES, readPackageFileWithin } from '@dorkos/shared/bounded-read';
import { declaredSet, isCovered } from '../../extensions/isolation/permission-coverage.js';
import { hasServerHalf } from '../../extensions/isolation/server-half.js';
import { ISOLATED_SERVER_PARTS_RUN } from '@dorkos/shared/extension-server-status';
import {
  DevLinkPackageNameSchema,
  disclosesAnything,
  MARKETPLACE_DEVLINK_PARKED_MARKER,
  type DevLinkPreview,
  type DevLinkPreviewResponse,
  type DevLinkRecord,
  type DevLinkState,
  type DevLinkListing,
  type DevLinkStatus,
  type DevUnlinkResult,
} from '@dorkos/shared/marketplace-schemas';
import { getBoundary, isContained } from '../../../lib/boundary.js';
import { readRunnableDeclarations } from '../preview/permission-preview.js';
import { describeEffectsInFull, disclosedEffectsOf } from '../preview/disclosed-effects.js';
import { APPROVAL_DETAIL_MAX_LENGTH } from '@dorkos/shared/approval-schemas';
import { readInstalledIdentity } from '../installed-scanner.js';
import { withInstallTargetLock } from '../transaction.js';
import type { NotifyPluginsChanged } from '../types.js';
import {
  applyLinkConsent,
  forgetLinkConsent,
  planLinkConsent,
  type DevLinkConsentStore,
} from './consent.js';
import { DevLinkError } from './errors.js';
import { canonicalSlotPath, devLinkStateOf, readDevLinks, updateDevLinks } from './registry.js';

/** The approval fields of `config.extensions` a dev link reads and writes. */
export interface DevLinkApprovals {
  /** Extension ids a person approved to run code. */
  approvedToRun: string[];
  /** The copy each approval is for. */
  approvedSources: Record<string, ExtensionApprovedSource>;
  /**
   * The permission set each approval covers (DOR-2686). Absent, and an
   * absent entry, mean the full in-process set.
   */
  approvedPermissions?: Record<string, ApprovedPermissionSet>;
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

/**
 * The hot-reload watcher as the service drives it (`DevLinkWatcher`): told
 * when a link is made, told to stand down before one is removed, and asked
 * when each last reloaded.
 */
export interface DevLinkReloads {
  /** Watch every dev link in force, including one just made. Never throws. */
  sync(): Promise<void>;
  /** Stop watching and reloading one dev link before it is unlinked. */
  hold(record: Pick<DevLinkRecord, 'name' | 'scope' | 'projectPath'>): Promise<void>;
  /** Undo {@link hold} once the unlink has finished or failed. */
  release(record: Pick<DevLinkRecord, 'name' | 'scope' | 'projectPath'>): Promise<void>;
  /** When an edit last reloaded a dev link, since the server started. */
  lastReloadAt(record: Pick<DevLinkRecord, 'name' | 'scope' | 'projectPath'>): string | undefined;
}

/** What {@link DevLinkService} needs. */
export interface DevLinkServiceDeps {
  /** Resolved DorkOS data directory. */
  dorkHome: string;
  /** Where extension approvals live (`config.extensions`). */
  approvals: DevLinkApprovalStore;
  /**
   * Where the link-time yes for hooks and global activation is recorded (the
   * hook-decision lists, `hookDecisionConsentStore` in `consent.ts`).
   */
  consent: DevLinkConsentStore;
  /** The marketplace's post-change notifier: refreshes plugins and projections. */
  onPluginsChanged: NotifyPluginsChanged;
  /** Ask extensions to re-scan, without waiting. */
  refreshExtensions: () => void;
  /** The hot-reload watcher; absent means edits are not watched. */
  reloads?: DevLinkReloads;
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
  /**
   * The approval card's description ({@link DevLinkService.describeApproval})
   * the person said yes to. When given, the link is refused unless the folder
   * still describes exactly the same way under the lock, so the yes covers the
   * extensions and effects the card showed and nothing added since.
   */
  expectedChange?: string;
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

// What unlink did and the listing are the wire contract the app and the CLI
// read too, so they live in the shared schemas.
export type { DevLinkListing, DevUnlinkResult };

/** Everything validation worked out about a link, before anything changes. */
interface LinkPlan {
  preview: DevLinkPreview;
  projectPath: string | undefined;
  /** What the slot holds now. */
  slotHolds: 'nothing' | 'adoptable-link' | 'installed';
  /**
   * Whether every hook and program declaration in the folder could be read,
   * so the card shows all of them. A yes is recorded for what it runs only
   * when it does.
   */
  declarationsReadable: boolean;
  /**
   * The permission set each carried extension declares now (DOR-2686), read
   * once per plan: the card text lists it and the yes records exactly it, so
   * a folder that widens between the card and the click describes
   * differently and is asked about again.
   */
  permissions: Record<string, ApprovedPermissionSet>;
  /**
   * Whether each carried extension has a server half, so a screens-only one
   * is never described as having full access to the computer.
   */
  servers: Record<string, boolean>;
}

/** What the card text says each carried extension may reach. */
type CardSets = Pick<LinkPlan, 'permissions' | 'servers'>;

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
   * The answer carries `change`: the same text an approval card binds
   * ({@link DevLinkService.describeApproval}). A person who says yes after
   * reading the preview sends it back as `expectedChange`, so the link is
   * refused if the folder describes differently by then.
   *
   * @param target - The folder, scope and the explicit switch.
   * @returns The preview, with the text the yes binds to.
   * @throws {DevLinkError} With the first reason it cannot be linked.
   */
  async preview(
    target: DevLinkTarget & { replaceInstalled?: boolean }
  ): Promise<DevLinkPreviewResponse> {
    const plan = await this.plan(target);
    return {
      ...plan.preview,
      change: describePlan(plan.preview, target.replaceInstalled === true, plan),
    };
  }

  /**
   * What the approval card for this link says, and what the approval binds:
   * the folder in full, where it runs, what it sets aside, the extensions it
   * may run, and what it runs on its own. A yes is bound to this text, so a
   * folder that describes differently by the time the yes is used is asked
   * about again rather than linked.
   *
   * @param request - The folder, scope and the explicit switch.
   * @returns The whole description. It is never cut short: what a person
   *   approves is bound to every character of it.
   * @throws {DevLinkError} When the folder cannot be linked as asked, or its
   *   description does not fit on a card (`dev_link_card_too_long`), so no card
   *   is raised for a link that would be refused or only partly shown.
   */
  async describeApproval(request: DevLinkTarget & { replaceInstalled?: boolean }): Promise<string> {
    const plan = await this.plan(request);
    if (plan.slotHolds === 'installed' && !request.replaceInstalled) throw slotTaken(plan.preview);
    const description = describePlan(plan.preview, request.replaceInstalled === true, plan);
    // A card stores at most this much. Cutting the text would bind the
    // approval to only part of what the folder runs, and anything added past
    // the cut would ride in on it, so a folder that does not fit is refused.
    if (description.length > APPROVAL_DETAIL_MAX_LENGTH) {
      throw new DevLinkError(
        'dev_link_card_too_long',
        400,
        "This folder runs too much to show on one approval card, so it can't be linked this way."
      );
    }
    return description;
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
      if (
        request.expectedChange !== undefined &&
        describePlan(plan.preview, request.replaceInstalled === true, plan) !==
          request.expectedChange &&
        // A folder that only narrowed what an extension may reach since the
        // card asks for nothing the person did not see: link it, recording
        // the narrower sets it declares now. Anything else is a new card.
        !onlyNarrowed(request.expectedChange, plan, request.replaceInstalled === true)
      ) {
        throw new DevLinkError(
          'dev_link_changed',
          409,
          'The folder changed after you approved it. Ask again.'
        );
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
        // The slot must now resolve to the folder the person approved, and to
        // nothing else, before anything is recorded or approved.
        if ((await realpath(slot).catch(() => null)) !== preview.path) {
          throw new DevLinkError(
            'dev_link_slot_is_linked',
            409,
            `${preview.name}'s folder link didn't point at ${preview.path}. Nothing was linked.`
          );
        }
        const captured = this.capturedApprovals(preview);
        const base: DevLinkRecord = {
          name: preview.name,
          type: preview.type,
          scope: preview.scope,
          ...(projectPath !== undefined && { projectPath }),
          slot,
          target: preview.path,
          ...(parked !== undefined && { parked }),
          linkedAt: new Date().toISOString(),
          linkedVia: request.via,
        };
        // What the card's yes covers besides extensions: worked out from the
        // same plan the card text was just held to, under the lock.
        const consent = planLinkConsent(this.deps.consent, {
          preview,
          record: base,
          declarationsReadable: plan.declarationsReadable,
          dorkHome: this.deps.dorkHome,
        });
        const record: DevLinkRecord = {
          ...base,
          ...((Object.keys(captured.extensions).length > 0 ||
            consent.capturedGlobal.length > 0) && {
            restoreApprovals: {
              ...(Object.keys(captured.extensions).length > 0 && {
                extensions: captured.extensions,
              }),
              ...(captured.runIds.length > 0 && { runIds: captured.runIds }),
              ...(Object.keys(captured.permissions).length > 0 && {
                permissions: captured.permissions,
              }),
              ...(consent.capturedGlobal.length > 0 && {
                globalActivation: consent.capturedGlobal,
              }),
            },
          }),
          ...(consent.grantedHooks.length > 0 && { grantedHooks: consent.grantedHooks }),
        };
        await updateDevLinks(this.deps.dorkHome, (links) => [...links, record], {
          replaceUnreadable: true,
        });
        undo.push(() =>
          updateDevLinks(this.deps.dorkHome, (links) => links.filter((l) => !sameLink(l, record)))
        );
        applyLinkConsent(this.deps.consent, record, consent);
        undo.push(async () => forgetLinkConsent(this.deps.consent, record, true));
        await this.approveExtensions(preview, plan.permissions);
        this.notify(preview.name, projectPath, 'install');
        // Edits reload from now on. After everything else, so the first event
        // it could act on finds the link recorded and approved.
        await this.deps.reloads?.sync();
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
    const first = await this.findRecord(request.name, request.scope, projectPath);
    return withInstallTargetLock(first.slot, async () => {
      // Read again under the lock: another unlink may have finished meanwhile.
      const record = await this.findRecord(request.name, request.scope, projectPath);
      // Stop reloading first: nothing may rebuild from the folder while its
      // link and approvals are being taken away.
      await this.deps.reloads?.hold(record);
      try {
        return await this.unlinkHeld(record);
      } finally {
        await this.deps.reloads?.release(record);
      }
    });
  }

  /**
   * The body of {@link unlink}, under the lock with reloads held.
   *
   * @internal
   */
  private async unlinkHeld(record: DevLinkRecord): Promise<DevUnlinkResult> {
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
    const reading = await readDevLinks(this.deps.dorkHome);
    const others = 'links' in reading ? reading.links.filter((l) => !sameLink(l, record)) : [];
    await this.forgetApprovals(record, restored === 'installed', others);
    forgetLinkConsent(this.deps.consent, record, restored === 'installed');
    await updateDevLinks(this.deps.dorkHome, (links) =>
      links.filter((link) => !sameLink(link, record))
    );
    this.notify(
      record.name,
      record.projectPath,
      restored === 'installed' ? 'install' : 'uninstall'
    );
    return {
      restored,
      ...(parkedLeftAt !== undefined && { parkedLeftAt }),
      ...(state === 'link-replaced' && { leftInPlace: true as const }),
    };
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
    // A plugin repo linked into a project that is (or contains) the repo
    // itself: the slot would sit inside the folder it points at, a loop every
    // scanner would follow, finding each extension twice.
    if (isContained(slot, folder) || isContained(folder, slot)) {
      throw new DevLinkError(
        'dev_link_path_not_allowed',
        400,
        "A folder can't be linked into itself. Link it for another project, or for every session."
      );
    }
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
    const declarationsReadable =
      declared.unreadableHooks.length === 0 && declared.unreadableDeclarations.length === 0;
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
    const permissions: Record<string, ApprovedPermissionSet> = {};
    const servers: Record<string, boolean> = {};
    for (const id of preview.extensions) {
      const declared = await declaredIn(folder, id);
      permissions[id] = declared.set;
      servers[id] = declared.hasServer;
    }
    return { preview, projectPath, slotHolds, declarationsReadable, permissions, servers };
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
   * back: for each extension the folder carries, whatever source that id has
   * now (another dev link's included), and whether it was approved to run.
   *
   * @internal
   */
  private capturedApprovals(preview: DevLinkPreview): {
    extensions: Record<string, ExtensionApprovedSource>;
    runIds: string[];
    permissions: Record<string, ApprovedPermissionSet>;
  } {
    const current = this.deps.approvals.read();
    const extensions: Record<string, ExtensionApprovedSource> = {};
    const runIds: string[] = [];
    const permissions: Record<string, ApprovedPermissionSet> = {};
    for (const id of preview.extensions) {
      const source = current.approvedSources[id];
      if (!source) continue;
      extensions[id] = source;
      if (current.approvedToRun.includes(id)) runIds.push(id);
      // The set that approval covered goes back with it on unlink (DOR-2686).
      const set = current.approvedPermissions?.[id];
      if (set) permissions[id] = set;
    }
    return { extensions, runIds, permissions };
  }

  /**
   * Record the person's yes for the extensions the folder carries now, bound
   * to this dev link (spec §4). A new extension added later asks on its own.
   *
   * @internal
   */
  private async approveExtensions(
    preview: DevLinkPreview,
    sets: Record<string, ApprovedPermissionSet>
  ): Promise<void> {
    if (preview.extensions.length === 0) return;
    // `sets` is what the card listed and the yes was bound to (read with the
    // plan, before the approvals), so what is recorded is exactly what was
    // shown, and no other write lands between the read below and the write.
    const current = this.deps.approvals.read();
    const approvedToRun = [...current.approvedToRun];
    const approvedSources = { ...current.approvedSources };
    const approvedPermissions = { ...(current.approvedPermissions ?? {}) };
    for (const id of preview.extensions) {
      if (!approvedToRun.includes(id)) approvedToRun.push(id);
      approvedSources[id] = {
        path: path.join(preview.slot, EXTENSIONS_DIR, id),
        plugin: preview.name,
        devLink: preview.path,
      };
      // The yes covers what the folder declares now, beside the dev-link
      // binding, so an edit that widens it waits for the person (DOR-2686).
      approvedPermissions[id] = sets[id]!;
    }
    this.deps.approvals.write({ approvedToRun, approvedSources, approvedPermissions });
  }

  /**
   * Forget every approval given to THIS dev link (its folder, inside its own
   * slot), putting back what it replaced. An id whose approval has since moved
   * to another copy, or to another dev link of the same folder, is left alone.
   *
   * A replaced approval comes back only where it is still about the right
   * thing: one that named this slot only when the parked copy is back in it
   * (otherwise the slot holds something nobody approved), and one that named
   * another dev link only while that dev link still exists.
   *
   * @param record - The dev link being removed.
   * @param installedBack - Whether the parked installed copy is back in the slot.
   * @param others - Every other recorded dev link, read under the lock.
   * @internal
   */
  private async forgetApprovals(
    record: DevLinkRecord,
    installedBack: boolean,
    others: readonly DevLinkRecord[]
  ): Promise<void> {
    const current = this.deps.approvals.read();
    // Each approval's plugin folder, spelled canonically: an approval given
    // through a linked spelling of the project still belongs to this slot.
    const replaced = record.restoreApprovals?.extensions ?? {};
    const roots = new Map<string, string>();
    for (const source of [...Object.values(current.approvedSources), ...Object.values(replaced)]) {
      if (!roots.has(source.path)) roots.set(source.path, await canonicalRootOf(source.path));
    }
    const rootOf = (source: ExtensionApprovedSource): string =>
      roots.get(source.path) ?? path.resolve(source.path);
    const restore = record.restoreApprovals?.extensions ?? {};
    const runIds = new Set(record.restoreApprovals?.runIds ?? []);
    const restorePermissions = record.restoreApprovals?.permissions ?? {};
    let approvedToRun = [...current.approvedToRun];
    const approvedSources = { ...current.approvedSources };
    const approvedPermissions = { ...(current.approvedPermissions ?? {}) };
    let changed = false;
    for (const [id, source] of Object.entries(current.approvedSources)) {
      if (!isLinkApproval(source, record, rootOf)) continue;
      changed = true;
      const previous = restore[id];
      delete approvedSources[id];
      // The link's permission set goes with its approval (DOR-2686), so it
      // can never be read against the copy that comes back.
      delete approvedPermissions[id];
      approvedToRun = approvedToRun.filter((approved) => approved !== id);
      if (!previous || !stillMeaningful(previous, record, installedBack, others, rootOf)) continue;
      approvedSources[id] = previous;
      // The set the replaced approval had, or none (the full in-process set)
      // when it had none.
      const previousSet = restorePermissions[id];
      if (previousSet) approvedPermissions[id] = previousSet;
      if (runIds.has(id)) approvedToRun.push(id);
    }
    if (changed) this.deps.approvals.write({ approvedToRun, approvedSources, approvedPermissions });
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
      ...lastReload(this.deps.reloads?.lastReloadAt(record)),
    };
  }
}

/** The `lastReloadAt` field, present only once something reloaded. */
function lastReload(at: string | undefined): { lastReloadAt?: string } {
  return at === undefined ? {} : { lastReloadAt: at };
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

/**
 * The permission set one extension in a linked folder declares now
 * (DOR-2686), read inside the folder and never through a link out of it. A
 * manifest that cannot be read or does not parse declares nothing DorkOS can
 * vouch for, so it is recorded as the narrowest set: whatever it declares
 * once fixed is then compared against nothing and asks again, rather than
 * riding on a yes recorded as full access.
 *
 * @param folder - The linked folder (its real path).
 * @param id - The extension's folder name under `.dork/extensions`.
 */
async function declaredIn(
  folder: string,
  id: string
): Promise<{ set: ApprovedPermissionSet; hasServer: boolean }> {
  const narrowest = {
    set: { runtime: 'subprocess', net: [], run: [], agents: false } as ApprovedPermissionSet,
    hasServer: true,
  };
  try {
    const raw = await readPackageFileWithin(
      folder,
      path.join(EXTENSIONS_DIR, id, 'extension.json'),
      PACKAGE_TEXT_MAX_BYTES,
      "The extension's extension.json"
    );
    const parsed = ExtensionManifestSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return narrowest;
    return {
      set: declaredSet(parsed.data),
      hasServer: await hasServerHalf(path.join(folder, EXTENSIONS_DIR, id), parsed.data),
    };
  } catch {
    return narrowest;
  }
}

/**
 * The canonical plugin folder an approval's extension path sits in
 * (`<root>/.dork/extensions/<id>` → `<root>`, its ancestors resolved through
 * links, its own name kept), or the path itself when it has another shape.
 */
async function canonicalRootOf(extensionPath: string): Promise<string> {
  const resolved = path.resolve(extensionPath);
  const extensionsDir = path.dirname(resolved);
  if (
    path.basename(extensionsDir) !== 'extensions' ||
    path.basename(path.dirname(extensionsDir)) !== '.dork'
  ) {
    return resolved;
  }
  return canonicalSlotPath(path.dirname(path.dirname(extensionsDir)));
}

/** Whether an approval was given to this dev link: its folder, inside its own slot. */
function isLinkApproval(
  source: ExtensionApprovedSource,
  record: DevLinkRecord,
  rootOf: (source: ExtensionApprovedSource) => string
): boolean {
  return source.devLink === record.target && isContained(rootOf(source), record.slot);
}

/**
 * Whether a replaced approval still means what it meant once this dev link is
 * gone. See `forgetApprovals`.
 */
function stillMeaningful(
  previous: ExtensionApprovedSource,
  record: DevLinkRecord,
  installedBack: boolean,
  others: readonly DevLinkRecord[],
  rootOf: (source: ExtensionApprovedSource) => string
): boolean {
  if (isContained(rootOf(previous), record.slot)) return installedBack && !previous.devLink;
  if (previous.devLink) return others.some((other) => isLinkApproval(previous, other, rootOf));
  return true;
}

/** How a card line says an extension's server half runs inside DorkOS. */
const IN_PROCESS_LINE = 'runs inside DorkOS with full access to this computer';

/** How a card line says an extension has only screens. */
const SCREENS_ONLY_LINE = 'only screens, which run in DorkOS with your access';

/**
 * How a card line says an extension runs separately: in the future tense,
 * and saying so, while this version cannot run that half yet.
 */
const SEPARATE_LINE = ISOLATED_SERVER_PARTS_RUN
  ? 'runs separately'
  : 'will run separately (its server part can’t run in this version yet)';

/**
 * One extension's permission set as a card line: where it runs, then every
 * host, program and agent grant, never a count.
 *
 * @param set - What it declares.
 * @param hasServer - Whether it has a server half; without one it is screens only.
 */
function describePermissionSet(set: ApprovedPermissionSet, hasServer: boolean): string {
  if (set.runtime === 'in-process') return hasServer ? IN_PROCESS_LINE : SCREENS_ONLY_LINE;
  const parts = [
    SEPARATE_LINE,
    set.net.length > 0 ? `connects to ${set.net.join(', ')}` : 'no internet',
    ...(set.run.length > 0 ? [`runs ${set.run.join(', ')}`] : []),
    ...(set.agents ? ['messages your agents'] : []),
  ];
  return parts.join('; ');
}

/**
 * Read a card line back into the set it describes, or `null` when it is not
 * one {@link describePermissionSet} writes. Only ever trusted after the whole
 * card text is rebuilt from what it returns and matches exactly.
 *
 * @param line - The text after `<id>: `.
 */
function parsePermissionSet(line: string): ApprovedPermissionSet | null {
  if (line === IN_PROCESS_LINE || line === SCREENS_ONLY_LINE) {
    return { runtime: 'in-process', net: [], run: [], agents: false };
  }
  if (!line.startsWith(`${SEPARATE_LINE}; `)) return null;
  const set: ApprovedPermissionSet = { runtime: 'subprocess', net: [], run: [], agents: false };
  for (const part of line.slice(SEPARATE_LINE.length + 2).split('; ')) {
    if (part === 'no internet') continue;
    if (part === 'messages your agents') set.agents = true;
    else if (part.startsWith('connects to ')) set.net = part.slice(12).split(', ');
    else if (part.startsWith('runs ')) set.run = part.slice(5).split(', ');
    else return null;
  }
  return set;
}

/**
 * Whether a card's text differs from the folder's description now only in
 * extensions that ask for less than the card listed (DOR-2686). Every other
 * line must match exactly, each listed set must read back to the very text
 * the card showed, and each extension's set now must be covered by the one
 * shown, so a yes is never stretched over anything the person did not see.
 *
 * @param shown - The card text the person approved.
 * @param plan - The folder as it is now.
 * @param replaceInstalled - Whether the link sets an installed copy aside.
 */
function onlyNarrowed(shown: string, plan: LinkPlan, replaceInstalled: boolean): boolean {
  const shownLines = shown.split('\n');
  const nowLines = describePlan(plan.preview, replaceInstalled, plan).split('\n');
  if (shownLines.length !== nowLines.length) return false;
  const shownSets: Record<string, ApprovedPermissionSet> = {};
  for (const id of plan.preview.extensions) {
    const prefix = `${id}: `;
    const index = nowLines.findIndex((line) => line.startsWith(prefix));
    if (index < 0 || !shownLines[index]!.startsWith(prefix)) return false;
    const parsed = parsePermissionSet(shownLines[index]!.slice(prefix.length));
    if (!parsed || !isCovered(plan.permissions[id]!, parsed)) return false;
    shownSets[id] = parsed;
  }
  // Rebuilt from what was read back, the card must be exactly what was shown.
  return (
    describePlan(plan.preview, replaceInstalled, { ...plan, permissions: shownSets }) === shown
  );
}

/**
 * The approval card text for a planned link. Deterministic, so the same folder
 * describes the same way at the card and at the retry.
 */
function describePlan(preview: DevLinkPreview, replaceInstalled: boolean, sets: CardSets): string {
  const lines = [
    `Folder: ${preview.path}`,
    `Package: ${preview.name} (${preview.type})`,
    preview.scope === 'global'
      ? 'Runs in: every session'
      : `Runs in: the project at ${path.dirname(path.dirname(path.dirname(preview.slot)))}`,
  ];
  if (preview.replaces && replaceInstalled) {
    lines.push(`Sets aside: the installed copy (v${preview.replaces.version}), not deleted`);
  }
  lines.push(
    `Extensions it may run: ${preview.extensions.length > 0 ? preview.extensions.join(', ') : 'none'}`
  );
  // What each may reach, in full (DOR-2686): the yes records exactly these
  // sets, and is bound to this text, so a folder that widens one before the
  // click describes differently and is asked about again.
  for (const id of preview.extensions) {
    const set = sets.permissions[id];
    if (set) lines.push(`${id}: ${describePermissionSet(set, sets.servers[id] ?? true)}`);
  }
  // Every hook, server and program in full, never a count: the yes records
  // approval for exactly these (the global-activation and hook decisions,
  // `consent.ts`), and the approval is bound to this text, so a hook moved to
  // another event, or a changed command, is a different card.
  lines.push('It runs on its own:');
  lines.push(
    ...describeEffectsInFull(
      preview.effects,
      preview.scope === 'global'
        ? 'in every session'
        : 'declared, but not started for a project install'
    )
  );
  if (preview.scope === 'global' && preview.effects && disclosesAnything(preview.effects)) {
    lines.push('Approving lets these start in every session.');
  } else if (preview.scope === 'project' && (preview.effects?.hooks.length ?? 0) > 0) {
    lines.push('Approving lets its hooks run in this project.');
  }
  lines.push(
    'Anything new it adds later asks first. Edits to this folder run without another card.'
  );
  return lines.join('\n');
}

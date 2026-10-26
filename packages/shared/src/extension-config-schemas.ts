/**
 * The schemas `extensions.*` in user config is built from: where an approved
 * copy came from, what a person approved, and which sources they trust. Moved
 * out of `config-schema.ts`, which re-exports all of them, so that file can
 * stay under its size ratchet.
 *
 * @module shared/extension-config-schemas
 */
import { z } from 'zod';

/**
 * Where a copy of an extension came from, when this machine can prove it (spec
 * `flow-multiproject` §9.1): the plugin that carries it, and the `owner/repo`
 * DorkOS's own installer recorded fetching that plugin from (lowercased, e.g.
 * `dork-labs/marketplace`). Never read from a file inside a project.
 */
export const ExtensionOriginSchema = z.object({
  /** The plugin folder that carries the extension. */
  plugin: z.string().min(1),
  /** The normalized `owner/repo` the plugin was installed from. */
  source: z.string().min(1),
});

/** Where a copy of an extension provably came from. */
export type ExtensionOrigin = z.infer<typeof ExtensionOriginSchema>;

/**
 * One code source a person trusts (spec `flow-multiproject` §9.3): every
 * extension DorkOS installs from it runs without asking first. Only a person
 * can add one, once per source, and only a source DorkOS's installer proved.
 */
export const ExtensionTrustedSourceSchema = z.object({
  /** The normalized `owner/repo`, e.g. `dork-labs/marketplace`. */
  source: z.string().min(1),
  /** When the person trusted it. ISO 8601. */
  trustedAt: z.string(),
});

/** One code source a person trusts. */
export type ExtensionTrustedSource = z.infer<typeof ExtensionTrustedSourceSchema>;

/**
 * The one copy of an extension a person approved to run code (DOR-2383).
 *
 * An approval is about code, and an id is only a name: two copies of an
 * extension can carry the same id, and the marketplace tools an agent may call
 * can install a second one. So an approval also records WHICH copy it was
 * given to, by where that copy lives. Since DOR-3068 it is content too: an
 * approval carries the folder `digest` it was given to, and an edit waits for
 * a person. The one exception is an extension one of our agents created that
 * runs separately inside that agent's own folder (`authorHome` and `grants`
 * below), whose edits keep loading with nothing to click (DOR-504/506).
 * See `apps/server/src/services/extensions/extension-load-policy.ts`.
 */
export const ExtensionApprovedSourceSchema = z.object({
  /** Absolute path of the approved extension directory. */
  path: z.string().min(1),
  /**
   * The installed marketplace plugin that carries this extension, when it came
   * inside one; absent for an extension installed directly.
   */
  plugin: z.string().min(1).optional(),
  /**
   * Where the approved copy came from, when this machine can prove it (spec
   * `flow-multiproject` §9.1): the carrying plugin and the `owner/repo` DorkOS's
   * own installer recorded fetching it from. Present only when the approved
   * copy had such a trusted origin. Another copy with the same trusted origin
   * counts as approved too, so the same plugin installed into several projects
   * asks once. A file inside a project can never supply this: it is read only
   * from DorkOS's own install records.
   */
  origin: ExtensionOriginSchema.optional(),
  /**
   * The folder digest the yes was given to (DOR-3068): the whole plugin
   * folder for a plugin-carried copy, the extension's own folder otherwise.
   * Any change to those files waits for a person, because a path alone no
   * longer says what is there. Absent only for a dev link, or for a copy
   * that keeps its path trust (`authorHome`).
   */
  digest: z.string().min(1).optional(),
  /**
   * The real path of the folder of the agent that created this extension
   * with `create_extension` (DOR-3068). Its edits keep loading without a
   * digest only while the copy runs separately, declares exactly `grants`,
   * and its real path stays inside this folder. Absent for a copy a person
   * approved by hand, which is always pinned by `digest`.
   */
  authorHome: z.string().min(1).optional(),
  /**
   * A digest of what the copy declared it may reach when the yes was given
   * (DOR-3068): where it runs, its `allow` lists, its secrets, its data
   * proxy and its server entry. Any change waits for a person.
   */
  grants: z.string().min(1).optional(),
  /**
   * When DorkOS pinned an approval given before approvals named content to
   * the files it found then (DOR-3068), once, on the first scan after the
   * upgrade. ISO 8601. Absent for every approval given since.
   */
  pinnedOnFirstUse: z.string().optional(),
  /**
   * The digest of the exact screen code (the client bundle the app loads) the
   * yes was given to, for a copy that keeps path trust (DOR-3068). Path trust
   * covers the server half only: when the bundle the app would load differs,
   * the screen half stays off until a person approves again.
   */
  clientDigest: z.string().min(1).optional(),
  /**
   * The real path of the dev link this approval was given to (DOR-2696);
   * absent for an installed copy. A dev link sits at its package's normal
   * folder, so without this an approval of the installed copy would cover the
   * link's files at the same path, and the other way round.
   */
  devLink: z.string().min(1).optional(),
});

/** The one copy of an extension a person approved to run code. */
export type ExtensionApprovedSource = z.infer<typeof ExtensionApprovedSourceSchema>;

/**
 * The permission set a person approved for one extension (DOR-2686): where it
 * runs and, when it runs separately, what it may reach. Recorded at the
 * moment of approval from what the extension declared then, so a later
 * version that declares MORE (a new host, a new program, agent access, or a
 * move back inside DorkOS) waits for a person again, while one that declares
 * less keeps running. See
 * `apps/server/src/services/extensions/isolation/permission-coverage.ts`.
 */
export const ApprovedPermissionSetSchema = z.object({
  /** Where it was approved to run: `in-process` is full access, and covers everything. */
  runtime: z.enum(['in-process', 'subprocess']),
  /** The `allow.net` entries approved. */
  net: z.array(z.string()),
  /** The `allow.run` entries approved, by the name the manifest wrote. */
  run: z.array(z.string()),
  /** Whether agent access (`allow.agents`) was approved. */
  agents: z.boolean(),
});

/** The permission set a person approved for one extension. */
export type ApprovedPermissionSet = z.infer<typeof ApprovedPermissionSetSchema>;

/**
 * A copy of an extension a person said "Not now" to (DOR-2517).
 *
 * Declining removes, disables and revokes nothing: the extension stays
 * installed, and Settings → Extensions can still turn it on. This only stops
 * the Activity inbox asking about the same copy again. It asks again when the
 * path, the carrying plugin or the version changes, because then it is a
 * different thing to decide about.
 */
export const ExtensionDismissedApprovalSchema = z.object({
  /** Absolute path of the extension directory the person declined. */
  path: z.string().min(1),
  /** The installed marketplace plugin that carries it, when it came inside one. */
  plugin: z.string().min(1).optional(),
  /** The manifest version the person declined. */
  version: z.string().min(1),
  /** When they said "Not now". ISO 8601. */
  dismissedAt: z.string(),
});

/** A copy of an extension a person said "Not now" to. */
export type ExtensionDismissedApproval = z.infer<typeof ExtensionDismissedApprovalSchema>;

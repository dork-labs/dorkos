/**
 * The wire shapes for an extension waiting for a person to let it run
 * (DOR-2517, spec `flow-multiproject` §5).
 *
 * An installed extension that is not approved to run used to be visible only
 * on its card in Settings → Extensions, so a person who installed a plugin
 * never learned that half of it was waiting on them. The server now lists every
 * such extension (`GET /api/extensions/pending-approvals`) and the Activity
 * inbox asks about each one with a single row. These are the shapes that list
 * and the "Not now" answer travel in.
 *
 * Nothing here is ever used for trust. `sourceLabel` and `why` are display
 * text; which copy a person approved is recorded by the server from its own
 * discovery record, never from anything a client sends back.
 *
 * @module shared/extension-approval-schemas
 */
import { z } from 'zod';
import { extendZodWithOpenApiOnce } from './zod-openapi.js';

extendZodWithOpenApiOnce();

/** Where an extension runs and what it may reach, as an approval card shows it (DOR-2686). */
export const ExtensionApprovalPermissionsSchema = z
  .object({
    /** `in-process`: inside DorkOS with full access. `subprocess`: limited to the lists below. */
    runtime: z.enum(['in-process', 'subprocess']),
    /** Hosts it may connect to (`allow.net`), as declared. */
    net: z.array(z.string()),
    /**
     * Programs it may start (`allow.run`), and whether each was found on this
     * computer. `refusedReason` is set when a file was found but DorkOS will
     * not let it run (it sits in extension files, or is a Windows script), in
     * a plain sentence the card shows; absent for a program simply not found.
     */
    run: z.array(
      z.object({
        name: z.string(),
        found: z.boolean(),
        refusedReason: z.string().optional(),
      })
    ),
    /** Whether it may message agents and start agent sessions (`allow.agents`). */
    agents: z.boolean(),
    /** Whether it has screens (a client bundle), which run in DorkOS with your access. */
    hasPage: z.boolean(),
  })
  .openapi('ExtensionApprovalPermissions');

/** Where an extension runs and what it may reach, as an approval card shows it. */
export type ExtensionApprovalPermissions = z.infer<typeof ExtensionApprovalPermissionsSchema>;

/** What an extension asks for that its last approval did not cover (DOR-2686). */
export const ExtensionApprovalAdditionsSchema = z
  .object({
    /** Hosts not covered before. */
    net: z.array(z.string()),
    /** Programs not approved before. */
    run: z.array(z.string()),
    /** Whether agent access is new. */
    agents: z.boolean(),
    /** Whether it now asks to run inside DorkOS, with full access. */
    runtime: z.boolean(),
  })
  .openapi('ExtensionApprovalAdditions');

/** What an extension asks for that its last approval did not cover. */
export type ExtensionApprovalAdditions = z.infer<typeof ExtensionApprovalAdditionsSchema>;
/**
 * One tool an extension would give agents, as the approval row lists it
 * (DOR-2685). Built by the server from discovery's check of the manifest.
 */
export const ExtensionAgentToolSummarySchema = z
  .object({
    /** The tool's name inside the extension, e.g. `send_message`. Lowercase words and underscores. */
    name: z.string().min(1),
    /**
     * The title a person reads, e.g. "Send an email". Checked to one safe line
     * only when the tool was accepted, so a surface shows `name` for a refused one.
     */
    title: z.string().min(1),
    /** Its permission tier, which picks the row's label ("Reads", "Acts", "Asks you first"). */
    tier: z.enum(['observe', 'act', 'destructive']),
    /** Why DorkOS refused it, when it did. A refused tool never reaches an agent. */
    refusedReason: z.string().optional(),
  })
  .openapi('ExtensionAgentToolSummary');

/** One tool an extension would give agents. */
export type ExtensionAgentToolSummary = z.infer<typeof ExtensionAgentToolSummarySchema>;

/** One skill an extension would give agents, as the approval row lists it (DOR-2685). */
export const ExtensionAgentSkillSummarySchema = z
  .object({
    /** The skill's folder name, e.g. "tidy-notes". */
    name: z.string().min(1),
    /** Why it is left out, when it is. A dropped skill never reaches an agent. */
    droppedReason: z.string().optional(),
  })
  .openapi('ExtensionAgentSkillSummary');

/** One skill an extension would give agents. */
export type ExtensionAgentSkillSummary = z.infer<typeof ExtensionAgentSkillSummarySchema>;

/** One extension waiting for a person to allow it to run. */
export const PendingExtensionApprovalSchema = z
  .object({
    /** Extension id. */
    id: z.string().min(1),
    /** Manifest name, e.g. "Flow". */
    name: z.string().min(1),
    /** Manifest version of the copy that would run. */
    version: z.string().min(1),
    /**
     * Resolved path of that copy; part of the source it would be bound to.
     * Present only for the person: a caller DorkOS cannot show is a person
     * (an agent) gets the list without it, so no absolute path or home folder
     * leaves the machine's owner.
     */
    path: z.string().min(1).optional(),
    /** Plugin folder it came inside, when plugin-carried. */
    plugin: z.string().min(1).nullable(),
    /** The mono source line, e.g. "flow plugin · dork-labs/marketplace". Display only. */
    sourceLabel: z.string(),
    /** Whether it has a server half, which picks the consent copy variant. */
    runsInServer: z.boolean(),
    /** Plain one-liner of what it adds ("It adds a Flow tab"), or null when the manifest does not say. */
    adds: z.string().nullable(),
    /** When this copy was first seen waiting. ISO 8601. Only orders rows. */
    since: z.string(),
    /** The second line: what happens and why, derived from the manifest by the server. */
    why: z.string(),
    /**
     * Where it runs and what it may reach (DOR-2686), so the card can state
     * its access level: `in-process` is inside DorkOS with full access (the
     * lists are empty); `subprocess` is limited to the lists. `run` says, per
     * program, whether it was found on this computer. `hasPage` says it has
     * screens, which run in DorkOS with the person's access either way.
     * `null` when DorkOS has no record of what it declares — which is also
     * what a server one version behind, that never sends it, reads as, so
     * one missing field cannot empty the whole inbox.
     */
    permissions: ExtensionApprovalPermissionsSchema.nullable().default(null),
    /**
     * What it asks for that the person's last approval of this copy did not
     * cover (DOR-2686), so a re-ask card leads with what changed. `null` on a
     * first ask, or when nothing in the permission set changed. Defaults to
     * `null` for a server that never sends it.
     */
    added: ExtensionApprovalAdditionsSchema.nullable().default(null),
    /**
     * The tools it would give agents once it runs, in manifest order, so a
     * person sees each tool and its tier before saying yes (DOR-2685).
     * Defaults to empty so an older server that never sends it still lists
     * every waiting extension instead of failing the whole response.
     */
    agentTools: z.array(ExtensionAgentToolSummarySchema).default([]),
    /** The skills it would give agents once it runs, in manifest order (DOR-2685). Defaults to empty. */
    agentSkills: z.array(ExtensionAgentSkillSummarySchema).default([]),
  })
  .openapi('PendingExtensionApproval');

/** One extension waiting for a person to allow it to run. */
export type PendingExtensionApproval = z.infer<typeof PendingExtensionApprovalSchema>;

/** Response of `GET /api/extensions/pending-approvals`. */
export const PendingExtensionApprovalsResponseSchema = z
  .object({
    /** Every extension that is waiting, oldest first. */
    approvals: z.array(PendingExtensionApprovalSchema),
  })
  .openapi('PendingExtensionApprovalsResponse');

/** Response of `GET /api/extensions/pending-approvals`. */
export type PendingExtensionApprovalsResponse = z.infer<
  typeof PendingExtensionApprovalsResponseSchema
>;

/**
 * Body of `POST /api/extensions/:id/dismiss-approval` ("Not now").
 *
 * The copy the person saw, so an answer to a row that went out of date (the
 * extension moved or updated while it was on screen) is refused with
 * `409 stale_approval` instead of silencing a copy nobody looked at.
 */
export const DismissExtensionApprovalRequestSchema = z
  .object({
    /** The resolved path of the copy the row showed. */
    path: z.string().min(1),
    /** The manifest version of the copy the row showed. */
    version: z.string().min(1),
    /** The plugin that carried it, or `null` for a direct install. Compared when sent. */
    plugin: z.string().min(1).nullable().optional(),
  })
  .openapi('DismissExtensionApprovalRequest');

/** Body of `POST /api/extensions/:id/dismiss-approval`. */
export type DismissExtensionApprovalRequest = z.infer<typeof DismissExtensionApprovalRequestSchema>;

/** The code a "Not now" answer to an out-of-date row is refused with. */
export const STALE_APPROVAL_CODE = 'stale_approval';

/**
 * Which copy of an extension a person was asked about: its id, the resolved
 * path of that copy, the plugin that carried it (or `null`), and its version.
 * Everything an answer has to match before DorkOS acts on it (DOR-2517).
 */
export interface ExtensionCopyIdentity {
  /** Extension id. */
  id: string;
  /** Resolved path of the copy. */
  path: string;
  /** The plugin it came inside, or `null` for a direct install. */
  plugin: string | null;
  /** Manifest version of the copy. */
  version: string;
}

/**
 * Optional body of `POST /api/extensions/:id/approve`: the copy the person was
 * shown. When present, the approval is refused with `409 stale_approval` unless
 * the copy on disk is still exactly that one, so a click on an old row can
 * never approve a copy that took its place (another plugin, or a project folder
 * reusing the id).
 */
export const ApproveExtensionRequestSchema = z
  .object({
    /**
     * The resolved path of the copy the row showed. Compared when sent; the
     * Settings card, which is never told a path, leaves it out and binds the
     * version and plugin it shows.
     */
    path: z.string().min(1).optional(),
    /** The manifest version of the copy the row showed. */
    version: z.string().min(1),
    /** The plugin that carried it, or `null` for a direct install. Compared when sent. */
    plugin: z.string().min(1).nullable().optional(),
    /**
     * The permission set the card showed (DOR-2686): where it runs and the
     * hosts, programs and agent access it declared. Compared when sent, as a
     * set, so a manifest that changed what it asks for while the card was on
     * screen is refused with `409 stale_approval` instead of being approved
     * on a yes given to the old lists.
     */
    permissions: z
      .object({
        runtime: z.enum(['in-process', 'subprocess']),
        net: z.array(z.string()).max(64),
        run: z.array(z.string()).max(16),
        agents: z.boolean(),
      })
      .optional(),
  })
  .openapi('ApproveExtensionRequest');

/** Optional body of `POST /api/extensions/:id/approve`. */
export type ApproveExtensionRequest = z.infer<typeof ApproveExtensionRequestSchema>;

/**
 * The subject id an `extension.approval` notification is filed under: the full
 * copy identity, as JSON, so a history row can name exactly the copy it was
 * about. Notifications are read only by the person they are for, so the path is
 * safe here.
 *
 * @param copy - The copy the person was asked about.
 * @returns A stable string for `subject.id`.
 */
export function extensionApprovalSubjectId(copy: ExtensionCopyIdentity): string {
  return JSON.stringify({
    id: copy.id,
    path: copy.path,
    plugin: copy.plugin,
    version: copy.version,
  });
}

/**
 * Read an `extension.approval` subject id back into the copy it names.
 *
 * @param subjectId - A notification's `subject.id`.
 * @returns The copy, or `null` when the id is not in that form.
 */
export function parseExtensionApprovalSubjectId(subjectId: string): ExtensionCopyIdentity | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(subjectId);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { id, path, plugin, version } = parsed as Record<string, unknown>;
  if (typeof id !== 'string' || !id) return null;
  if (typeof path !== 'string' || !path) return null;
  if (typeof version !== 'string' || !version) return null;
  if (plugin !== null && typeof plugin !== 'string') return null;
  return { id, path, plugin, version };
}

/**
 * The one-time follow-up a person sees right after turning on an extension
 * whose copy provably came from a source they do not trust yet (spec
 * `flow-multiproject` §9.3, V9): "Next time, trust everything from
 * dork-labs/marketplace?". Returned only to the app that answered, never
 * stored or pushed, so it shows once, on that device.
 */
export const ExtensionTrustOfferSchema = z
  .object({
    /** The exact normalized `owner/repo` "Yes" would trust. */
    source: z.string().min(1),
  })
  .openapi('ExtensionTrustOffer');

/** The one-time trust offer after an approval. */
export type ExtensionTrustOffer = z.infer<typeof ExtensionTrustOfferSchema>;

/** Body of `POST` and `DELETE /api/extensions/trusted-sources`. */
export const TrustedSourceRequestSchema = z
  .object({
    /** A normalized `owner/repo`, as a trust offer or the trusted list named it. */
    source: z.string().min(1).max(200),
  })
  .openapi('TrustedSourceRequest');

/** Body of `POST` and `DELETE /api/extensions/trusted-sources`. */
export type TrustedSourceRequest = z.infer<typeof TrustedSourceRequestSchema>;

/** One code source a person trusts, as `GET /api/extensions/trusted-sources` lists it. */
export const TrustedSourceSchema = z
  .object({
    /** The normalized `owner/repo`. */
    source: z.string().min(1),
    /** When the person trusted it. ISO 8601. */
    trustedAt: z.string(),
  })
  .openapi('TrustedSource');

/** One trusted code source. */
export type TrustedSource = z.infer<typeof TrustedSourceSchema>;

/** Response of `GET /api/extensions/trusted-sources`. */
export const TrustedSourcesResponseSchema = z
  .object({
    /** Every trusted source, in the order they were trusted. */
    sources: z.array(TrustedSourceSchema),
  })
  .openapi('TrustedSourcesResponse');

/** Response of `GET /api/extensions/trusted-sources`. */
export type TrustedSourcesResponse = z.infer<typeof TrustedSourcesResponseSchema>;

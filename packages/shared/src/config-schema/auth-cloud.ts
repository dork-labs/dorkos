/**
 * Remote MCP servers, cloud credits, and the `auth`, `cloud` and `connectors` sections of `UserConfigSchema`.
 *
 * Split out of `config-schema.ts`, which composes `UserConfigSchema` and
 * re-exports every public name from here. Plain Zod, no OpenAPI.
 *
 * @module shared/config-schema/auth-cloud
 */
import { z } from 'zod';
import * as remote from '../remote-access-settings.js';

/**
 * One remote MCP server the raw-MCP connector exposes as a connectable service
 * (`connectors.rawMcpServers`, connector-completion spec §Detailed Design 1).
 * Read at boot by the connector bootstrapper; config edits take effect on the
 * next server start.
 */
export const RawMcpServerConfigSchema = z.object({
  /** Stable service slug used as the toolkit id, e.g. `'notion'`. */
  slug: z.string().min(1),
  /** Human-facing name shown in the connect picker. */
  displayName: z.string().min(1),
  /** The remote MCP endpoint URL. */
  url: z.string().url(),
  /** Streamable HTTP or SSE — the two remote MCP transports. */
  transport: z.enum(['http', 'sse']),
});

/** One configured remote MCP server. See {@link RawMcpServerConfigSchema}. */
export type RawMcpServerConfig = z.infer<typeof RawMcpServerConfigSchema>;
/**
 * One runtime's recorded Runs on choice about DorkOS credits (ADR
 * 261001-000811): new work on that runtime runs on credits when the record says
 * `credits` and nothing more specific (a session's own pick, its agent) names
 * an account. A project rule can block credits; it never chooses them.
 *
 * `own-sign-in` is a recorded "no": the person turned credits off, or undid a
 * choice DorkOS made. A new link fills gaps only where NO record exists, so a
 * "no" is never overridden.
 *
 * Kept here rather than in the runtime's `defaultAccount`, on purpose: that
 * field names the person's OWN sign-in, which is what turning credits off
 * returns to, and what flow's CLI reads as the runtime's default account. A
 * credits choice must never change either.
 */
export const CloudCreditsDefaultSchema = z.object({
  /** What new work on this runtime runs on by default. */
  runsOn: z.enum(['credits', 'own-sign-in']),
  /**
   * `default` when DorkOS set credits on a new link because the runtime had no
   * sign-in at all; `user` when a person chose.
   */
  chosenBy: z.enum(['default', 'user']),
  /** Whether the person has seen the notice that DorkOS made this choice. */
  announced: z.boolean().default(true),
  /**
   * Whether switching back to the runtime's own sign-in was offered once after
   * a working sign-in appeared under a `default` choice.
   */
  signInReoffered: z.boolean().default(false),
});

/** One runtime's credits choice. See {@link CloudCreditsDefaultSchema}. */
export type CloudCreditsDefault = z.infer<typeof CloudCreditsDefaultSchema>;

/**
 * The person's DorkOS credits choices (`cloud.credits`, ADR 261001-000811).
 * Written only by the server: a person's pick in Runs on, the fill-the-gaps
 * step of a NEW link, an agent a person allowed onto credits, and the
 * dismissals of the notices about those.
 */
export const CloudCreditsSettingsSchema = z.object({
  /**
   * Runtime type → its recorded choice. A runtime with no record runs new work
   * on its own sign-in and is a gap a new link may fill.
   */
  defaults: z.record(z.string(), CloudCreditsDefaultSchema).default({}),
  /**
   * The one dismissible offer a computer linked BEFORE credits were a choice
   * gets instead of being switched over: `pending` until it is answered,
   * `dismissed` after, `none` when it was never owed (a new link, or no link).
   */
  offer: z.enum(['none', 'pending', 'dismissed']).default('none'),
  /**
   * The ids of agents a person allowed onto credits in the app. An agent's own
   * file naming `dorkos-credits` puts it on credits only when its id is here,
   * so a cloned or agent-written file can never start spending.
   */
  agents: z.array(z.string()).default([]),
  /**
   * The DorkOS account these choices were made under (its id, else its org's),
   * or `null` while unknown. A link to a different account starts over; a
   * relink to the same one keeps every choice.
   */
  linkedTo: z.string().nullable().default(null),
});

/** The `cloud.credits` block. See {@link CloudCreditsSettingsSchema}. */
export type CloudCreditsSettings = z.infer<typeof CloudCreditsSettingsSchema>;

/** The `auth` section of `UserConfigSchema`; its documentation sits on the field there. */
export const AuthConfigSchema = z
  .object({
    /**
     * Whether local login (Better Auth) is required to use this instance.
     * Defaults to `false`: no auth gate runs and DorkOS shows no user concept
     * anywhere (progressive disclosure). The enable-login flow creates the
     * owner account and then flips this to `true`. See the accounts-and-auth
     * spec.
     */
    enabled: z.boolean().default(false),
  })
  .default(() => ({ enabled: false }));

/** The `cloud` section of `UserConfigSchema`; its documentation sits on the field there. */
export const CloudConfigSchema = z
  .object({
    /**
     * The scoped instance API key issued by the DorkOS cloud when this
     * instance is device-linked to an account (accounts-and-auth P2). Held as
     * the credential for `POST /api/instances/heartbeat`; a `401` from the
     * cloud means it was revoked (unlinked). Sensitive — see
     * {@link SENSITIVE_CONFIG_KEYS}. `null` when this instance is not linked.
     */
    instanceToken: z.string().nullable().default(null),
    /** This instance's display name registered with the cloud (typically the hostname). */
    instanceName: z.string().nullable().default(null),
    /** Human-readable label of the linked DorkOS account, when the cloud reports one. */
    linkedAccountLabel: z.string().nullable().default(null),
    /**
     * Relink proof of the last instance key this install dropped (user
     * unlink, a `401` from the cloud, or `dorkos cloud logout`):
     * base64url-unpadded HMAC-SHA256 keyed by that key over
     * `dorkos-relink-v1`. Sent once with the next device-link request so the
     * cloud can continue the same link, and the apps connected through it,
     * for the same DorkOS account. Cleared after the next successful link.
     * Never the raw key, but it IS the credential that continues a link (with
     * the same account's approval), so it is in {@link SENSITIVE_CONFIG_KEYS},
     * withheld from agents, and only a person may write it. `null` when no
     * key has been dropped since the last link. Absent from configs written
     * before it existed; every reader treats absence as `null`.
     */
    previousLinkProof: z.string().nullable().default(null),
    /**
     * Which runtimes run new work on DorkOS credits by default, and who chose
     * that (ADR 261001-000811). See {@link CloudCreditsSettingsSchema}.
     */
    credits: CloudCreditsSettingsSchema.default(() => ({
      defaults: {},
      offer: 'none' as const,
      agents: [],
      linkedTo: null,
    })),
    /**
     * Managed remote access: the selected mode, the enrolment a person
     * approved, and references to the stored credential (DOR-2086). See
     * {@link RemoteAccessSettingsSchema}.
     */
    remote: remote.RemoteAccessSettingsSchema.default(remote.defaultRemoteAccessSettings),
  })
  .default(() => ({
    instanceToken: null,
    instanceName: null,
    linkedAccountLabel: null,
    previousLinkProof: null,
    credits: { defaults: {}, offer: 'none' as const, agents: [], linkedTo: null },
    remote: remote.defaultRemoteAccessSettings(),
  }));

/** The `connectors` section of `UserConfigSchema`; its documentation sits on the field there. */
export const ConnectorsConfigSchema = z
  .object({
    /** Remote MCP servers the raw-MCP connector exposes (boot-read). */
    rawMcpServers: z.array(RawMcpServerConfigSchema).default(() => []),
  })
  .default(() => ({ rawMcpServers: [] }));

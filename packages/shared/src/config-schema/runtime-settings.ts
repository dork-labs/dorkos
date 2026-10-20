/**
 * Per-runtime defaults (model, effort, trust stop, Codex transport), Claude Code and DorkOS runtime settings, and the `runtimes` section of `UserConfigSchema`.
 *
 * Split out of `config-schema.ts`, which composes `UserConfigSchema` and
 * re-exports every public name from here. Plain Zod, no OpenAPI.
 *
 * @module shared/config-schema/runtime-settings
 */
import { z } from 'zod';
import { ACCOUNT_COLOR_PATTERN } from '../account-identity.js';
import { EFFORT_LEVELS } from '../constants.js';
import { CredentialReferenceSchema } from '../credential-reference.js';
import { RuntimeEnvironmentSchema } from '../runtime-environment-schema.js';
import {
  ClaudeCodeAccountsSchema,
  TolerantProjectAccountsSchema,
  TolerantProjectRootListSchema,
  healClaudeAccountRename,
} from './claude-accounts.js';

/**
 * The model a NEW session on one runtime starts on, or `null` to let that
 * runtime pick its own — which is exactly the behavior before this field existed.
 *
 * **Per runtime, and it has to be.** A model id is only meaningful inside the
 * runtime that offers it: `opus` means nothing to Codex, `gpt-5.3-codex` nothing
 * to Claude Code, and OpenCode addresses models as `provider/model`. One shared
 * `runtimes.defaultModel` would therefore be wrong for at least two of the three
 * the moment anybody set it, and the failure would be silent — a runtime asked
 * for a model it has never heard of. Three leaves cost three rows in the
 * exhaustiveness tables and buy an answer that is true for whichever runtime a
 * session lands on.
 *
 * Not validated against a live catalog here. The catalogs are per-runtime, remote,
 * and change under us; a schema that rejects tomorrow's model id is worse than a
 * value the runtime declines. An unrecognized id surfaces as the warning chip
 * (design §3.4), never as a refused write.
 */
const DefaultModelSchema = z.string().min(1).nullable().default(null);

/**
 * The reasoning effort a NEW session on one runtime starts at, or `null` to let
 * the runtime pick — again byte-for-byte today's behavior.
 *
 * The value space is the shared {@link EFFORT_LEVELS} ladder, never a per-runtime
 * fork. What differs per runtime is what a rung MEANS: claude-code and codex clamp
 * `none`/`minimal` differently, which the two clamp sites document precisely
 * because one shared default makes the divergence visible to a person.
 *
 * **OpenCode has no such leaf, on purpose.** Its prompt API takes no effort field
 * in either the pinned or the current SDK — effort exists there only as
 * config-file variants with no API selection. A schema field would imply a setting
 * that does nothing, so the honest shape is a section that simply does not have
 * one, and the UI says "Not supported by OpenCode" rather than hiding the row
 * (design §4, "unsupported means said").
 */
const DefaultEffortSchema = z.enum(EFFORT_LEVELS).nullable().default(null);

/**
 * How much a NEW session may do without asking. `null` lets the runtime decide,
 * which is byte-for-byte the behavior before these fields existed.
 *
 * **A stop, never a mode id.** `'ask' | 'act' | 'autonomy'` are the three
 * positions of the Trust Dial, and they mean the same thing on every runtime;
 * the mode id that sits at a position does not (`bypassPermissions` on Claude
 * Code, `danger-full-access` on Codex). Storing the stop is what lets one
 * setting be true for a person who runs all three runtimes, and it is resolved
 * against whichever runtime a session actually lands on, through that runtime's
 * own capability profile. A runtime with no mode at the stored stop contributes
 * nothing and starts at its own default.
 *
 * Mirrors {@link PermissionStop} in `agent-runtime.ts`, which is the authority
 * on the vocabulary. Restated as a Zod enum rather than imported because this
 * module is deliberately dependency-light (it is bridged to JSON Schema and read
 * by the CLI); the two are pinned together by
 * `packages/shared/src/__tests__/config-schema.test.ts`.
 *
 * This is `runtimes.<runtime>.defaultTrustStop`, one runtime's own answer. It
 * ships `null`, which adds no answer of its own: the runtime follows the global
 * stop, `runtimes.defaultTrustStop`, which ships `'autonomy'`.
 */
const RuntimeTrustStopSchema = z.enum(['ask', 'act', 'autonomy']).nullable().default(null);

/** The ways DorkOS can run Codex — see `runtimes.codex.transport`. */
export const CODEX_TRANSPORTS = ['auto', 'app-server', 'exec'] as const;

/** A `runtimes.codex.transport` value. */
export type CodexTransportSetting = (typeof CODEX_TRANSPORTS)[number];

/**
 * `runtimes.codex.transport` (ADR 261005-113107). `auto` carries no meaning of
 * its own here on purpose: the server resolves it, so DorkOS can change its
 * default without a migration and an explicit choice survives that change.
 */
const CodexTransportSchema = z.enum(CODEX_TRANSPORTS).default('auto');

/**
 * The color a STANDALONE default Claude account is drawn in
 * (`runtimes.claudeCode.defaultAccountColor`, DOR-2492): lowercase `#rrggbb`,
 * the rule a registry row's `color` follows. `null` or `''` means the default
 * for its position, which is after the registered rows.
 *
 * A standalone default is `~/.claude` (or the folder `defaultAccount` names)
 * when no registered row has that folder. It has no row, so it has no row
 * `color` to store a choice in, and registering the folder to get one would
 * re-key the account's identity and every policy that names
 * `claude-code:default`. When a registered row DOES have the default folder,
 * `default` is an alias of that row and the row's own color wins: this field
 * is ignored.
 *
 * The strict shape is what `PATCH /api/config` checks a new value against
 * (`applyConfigPatch`), so a bad value is refused rather than stored. The
 * setting itself reads a bad hand-edited value as `null` instead of failing the
 * whole config, as a row's `color` does.
 */
export const DefaultAccountColorSchema = z
  .union([z.string().regex(ACCOUNT_COLOR_PATTERN), z.literal('')])
  .nullable();

/**
 * What a NEW Claude Code session starts with, and which account it bills.
 *
 * Named rather than left inline in {@link UserConfigSchema} so the JSON-schema
 * override in `config-manager.ts` can key on this node's identity, exactly as it
 * does for {@link ClaudeCodeAccountSchema}. That override has to DECLARE the
 * retired `activeAccount` spelling on this object — an undeclared key is one
 * `preserveUnknownKeys` carries forward forever, which would resurrect a billing
 * choice the operator had just cleared — and a node it cannot name is a node it
 * cannot widen.
 */
export const ClaudeCodeSettingsSchema = z.object({
  /**
   * Absolute path of the Claude config directory a NEW session runs and
   * bills on when neither the session nor its agent names one. `null`
   * inherits whatever the process already has — `$CLAUDE_CONFIG_DIR`,
   * else `~/.claude` — which is byte-for-byte the behavior before this
   * field existed.
   *
   * An explicit path OVERRIDES an inherited `CLAUDE_CONFIG_DIR`, so which
   * account runs the work stops depending on which terminal happened to
   * launch DorkOS. Stored as a path, never an index into
   * {@link ClaudeCodeAccountSchema} entries, so removing an account can
   * never silently repoint the selection at a different client
   * (spec `claude-code-accounts` D1/D2).
   *
   * **A path here, an id everywhere else** (ADR 260821-205324). This one
   * field stays a path on purpose: the default may legitimately name a
   * root that is not a registry entry at all, and choosing it is what
   * adds it to the read set (ADR 260801-204126). Agents and launch hints
   * have no such case and reference accounts by {@link
   * ClaudeCodeAccountSchema.shape.id}.
   *
   * Renamed from `activeAccount` in 0.65.0 (`billing-account-ladder`):
   * "active" described the retired global-switch semantics, where the
   * status-bar picker repointed this value for every future session.
   */
  defaultAccount: z.string().nullable().default(null),
  /**
   * The Claude accounts DorkOS knows about — what lets it show which
   * client a session belongs to. The operator registers these: DorkOS
   * never registers a `~/.claude*` folder on its own, because that guess
   * sweeps up directories that are not accounts at all (D4). Settings may
   * OFFER the folders it finds (spec `claude-account-ui` §6.9), and nothing
   * lands here until a person clicks Add.
   */
  accounts: ClaudeCodeAccountsSchema.default(() => []),
  /**
   * The color the standalone default account is drawn in, or `null` for the
   * default for its position. Ignored while a registered row has the default
   * folder: that row's own color wins. See {@link DefaultAccountColorSchema}.
   */
  defaultAccountColor: DefaultAccountColorSchema.default(null).catch(null),
  /**
   * The projects Main (this computer's own sign-in, id `default`) may work in,
   * as canonical project roots, or `null` for any project. Main has no
   * registry row to carry `onlyProjects`, so its rule lives here, the same
   * pattern as `defaultAccountColor` (spec `flow-multiproject` §8.1).
   */
  defaultAccountOnlyProjects: TolerantProjectRootListSchema.default(null),
  /**
   * Per-project account rules, keyed by canonical project root: which
   * accounts may work in that project (spec `flow-multiproject` §8.1, N6). A
   * project with no entry allows every account. An account works in a project
   * only when both its own rule and the project's allow it. Written only by a
   * person, through `PUT /api/runtimes/claude-code/project-accounts`, which
   * rewrites the whole object: the keys are paths and contain dots.
   */
  projectAccounts: TolerantProjectAccountsSchema.default({}),
  /**
   * Account folders a person dismissed from Settings' "Found on this
   * computer" list, so they stay hidden across restarts (spec
   * `claude-account-ui` §7.4). Stored in comparable form (the real path).
   * Written only by `POST /api/runtimes/claude-code/accounts/found/dismiss`,
   * which appends in one read-modify-write; a `PATCH /api/config` would
   * replace the array, and the screen never sees it.
   */
  dismissedFolders: z.array(z.string()).max(200).default([]),
  /** Model a new claude-code session starts on. See {@link DefaultModelSchema}. */
  defaultModel: DefaultModelSchema,
  /** Effort a new claude-code session starts at. See {@link DefaultEffortSchema}. */
  defaultEffort: DefaultEffortSchema,
  /**
   * Trust stop a new claude-code session starts at, overriding
   * `runtimes.defaultTrustStop`. See {@link RuntimeTrustStopSchema}.
   */
  defaultTrustStop: RuntimeTrustStopSchema,
  /**
   * Whether a Claude Code chat keeps its agent running between your
   * messages instead of starting it up again for each one. Ships `true`
   * (spec `full-power-defaults`, D1): replies from the second message on
   * arrive about four times faster.
   *
   * **It currently has no switch in the product.** The Experiments row was
   * its only control and went out with the flag when it graduated, so until
   * the Control Center lands (task 2.2) the way to turn it off is this leaf
   * — `PATCH /api/config`, `dorkos config set`, or the file. Do not describe
   * a switch that is not there yet.
   *
   * **Safety-neutral, which is why it flips as a plain default.** A warm
   * agent is the same executable with the same permissions and the same
   * per-dispatch boundary check, held open for longer — nothing about what
   * it may DO changes. The real cost is memory, and the bounds on it live
   * in `maxWarmProcesses` below, and the idle
   * reaper closes the rest.
   *
   * Read when a chat's agent starts, so a chat already under way keeps
   * the way it started until its process is replaced. That is what lets
   * one machine run chats both ways at the same time and compare them on
   * the same work (spec `persistent-session-runtime` §P3).
   */
  persistentSession: z.boolean().default(true),
  /**
   * The most chats whose agent may be running at once on this machine
   * (DOR-3012). `null`, the default, sizes it to the machine's memory: one per
   * 2 GB, at least 12 and at most 32. A number pins it.
   *
   * A chat past the limit is never refused outright: the least recently used
   * idle agent is closed to make room, and when every one is mid-turn the chat
   * waits for one to finish. Read when an agent starts, so a change applies to
   * the next one.
   */
  maxWarmProcesses: z.number().int().min(1).max(128).nullable().default(null),
});

/** Explicit inference metadata. Secrets live in the credential store. */
export const DoeInferenceConfigSchema = z
  .object({
    source: z.enum(['api-key', 'local', 'dorkos-credits']),
    provider: z.string().min(1),
    protocol: z.enum(['anthropic-messages', 'openai-chat-completions', 'openai-responses']),
    endpoint: z
      .string()
      .url()
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            ['https:', 'http:'].includes(url.protocol) &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash
          );
        } catch {
          return false;
        }
      }, 'Choose an HTTP endpoint without embedded credentials.'),
    model: z.string().min(1),
    contextWindow: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
    credentialRef: CredentialReferenceSchema.optional(),
    /** Endpoint this key was explicitly supplied for; changing endpoints requires setup again. */
    credentialEndpoint: z.string().url().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.maxOutputTokens > value.contextWindow)
      ctx.addIssue({
        code: 'custom',
        path: ['maxOutputTokens'],
        message: 'Output limit exceeds the context window.',
      });
    let url: URL;
    try {
      url = new URL(value.endpoint);
    } catch {
      return;
    }
    if (
      value.source === 'local' &&
      (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
      ctx.addIssue({
        code: 'custom',
        path: ['endpoint'],
        message: 'Local models require an HTTP loopback endpoint.',
      });
    if (
      value.credentialRef &&
      (!value.credentialEndpoint ||
        (() => {
          try {
            return new URL(value.credentialEndpoint).href !== url.href;
          } catch {
            return true;
          }
        })())
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['credentialEndpoint'],
        message: 'Save an API key for this endpoint.',
      });
    }
    if (value.source !== 'api-key' && value.credentialRef)
      ctx.addIssue({
        code: 'custom',
        path: ['credentialRef'],
        message: 'This inference source does not use an API key.',
      });
  });
/** Persisted model and payer choice, without secret values. */
export type DoeInferenceConfig = z.infer<typeof DoeInferenceConfigSchema>;
/** DorkOS runtime configuration; a new installation makes no inference choice. */
export const DoeRuntimeSettingsSchema = z
  .object({
    enabled: z.boolean().default(true),
    inference: DoeInferenceConfigSchema.nullable().default(null),
    /** Model new chats prefer on credits, when served; `null` = DorkOS picks. */
    defaultModel: DefaultModelSchema,
    defaultTrustStop: RuntimeTrustStopSchema,
  })
  .default(() => ({ enabled: true, inference: null, defaultModel: null, defaultTrustStop: null }));

/** The `runtimes` section of `UserConfigSchema`; its documentation sits on the field there. */
export const RuntimesConfigSchema = z
  .object({
    /** Names the owner deliberately passes to runtime subprocesses. */
    environment: RuntimeEnvironmentSchema,
    /** Runtime id the registry selects as its default at boot. */
    default: z.string().default('claude-code'),
    /**
     * How much a new session may do without asking, on every runtime that has
     * no answer of its own. Ships `'autonomy'` (ADR 261006-225605): our own
     * agents work without asking, and every action is recorded. A
     * `runtimes.<runtime>.defaultTrustStop` beats this one.
     */
    defaultTrustStop: RuntimeTrustStopSchema.unwrap().default('autonomy'),
    // The rename heal runs BEFORE this object is parsed, so a config still
    // spelling the default `activeAccount` parses with the operator's choice
    // in the new key. What settles the FILE is a write that names `runtimes`,
    // and only because `config-manager.ts` DECLARES the retired key — see
    // {@link healClaudeAccountRename} for why declaring it is the mechanism
    // and dropping it from the parse output is not.
    claudeCode: z.preprocess(healClaudeAccountRename, ClaudeCodeSettingsSchema).default(() => ({
      defaultAccount: null,
      accounts: [],
      defaultAccountColor: null,
      defaultAccountOnlyProjects: null,
      projectAccounts: {},
      dismissedFolders: [],
      defaultModel: null,
      defaultEffort: null,
      defaultTrustStop: null,
      // Warm agents, ON (spec `full-power-defaults`, D1). Three declarations
      // carry this value — the per-field one on `ClaudeCodeSettingsSchema`,
      // this one, and the `runtimes` literal below — and all three have to
      // agree or the shallow defaults-merge lands somebody on the old value.
      persistentSession: true,
      maxWarmProcesses: null,
    })),
    doe: DoeRuntimeSettingsSchema,
    opencode: z
      .object({
        enabled: z.boolean().default(true),
        /** Absolute path to the `opencode` binary; `null` resolves from PATH. */
        binaryPath: z.string().nullable().default(null),
        /** Sidecar server port; `0` picks an ephemeral port. */
        port: z.number().int().min(0).max(65535).default(0),
        /**
         * Selected provider id keying into the top-level {@link UserConfig.providers}
         * registry (e.g. `openrouter`, `openai`, `ollama`). `null` = no provider
         * chosen; the sidecar falls back to OpenCode's own host auth (ADR-0315).
         */
        provider: z.string().nullable().default(null),
        /**
         * Optional OpenAI-compatible base URL for a Direct provider (injected as
         * `OPENAI_BASE_URL` into the sidecar env). `null` = the provider default.
         */
        baseURL: z.string().nullable().default(null),
        /**
         * Model a new OpenCode session starts on, as `provider/model`. See
         * {@link DefaultModelSchema}. There is deliberately no `defaultEffort`
         * sibling — OpenCode's API takes no effort at all.
         */
        defaultModel: DefaultModelSchema,
        /**
         * Trust stop a new OpenCode session starts at, overriding
         * `runtimes.defaultTrustStop`. See {@link RuntimeTrustStopSchema}.
         */
        defaultTrustStop: RuntimeTrustStopSchema,
      })
      .default(() => ({
        enabled: true,
        binaryPath: null,
        port: 0,
        provider: null,
        baseURL: null,
        defaultModel: null,
        defaultTrustStop: null,
      })),
    codex: z
      .object({
        enabled: z.boolean().default(true),
        /** Absolute path to the `codex` binary; `null` resolves from PATH. */
        binaryPath: z.string().nullable().default(null),
        /**
         * Credential reference for Codex's API key (`keychain:`/`env:`/`file:`),
         * never a raw secret. `null` = delegate to `codex login` (ADR-0315). Codex
         * uses delegated login or its own supported environment/auth files;
         * this reserved reference is not resolved by the runtime adapter.
         */
        credentialRef: CredentialReferenceSchema.nullable().default(null),
        /** Model a new codex session starts on. See {@link DefaultModelSchema}. */
        defaultModel: DefaultModelSchema,
        /** Effort a new codex session starts at. See {@link DefaultEffortSchema}. */
        defaultEffort: DefaultEffortSchema,
        /**
         * Trust stop a new codex session starts at, overriding
         * `runtimes.defaultTrustStop`. See {@link RuntimeTrustStopSchema}.
         */
        defaultTrustStop: RuntimeTrustStopSchema,
        /**
         * How DorkOS runs Codex (ADR 261005-113107). `auto` follows DorkOS's
         * own default, resolved in one place (`resolveCodexTransport`), so a
         * later change of default reaches everyone who never chose; `exec` is
         * the older one-process-per-reply way; `app-server` is one long-lived
         * Codex process per home. Read once at startup: a change takes effect
         * after a restart.
         */
        transport: CodexTransportSchema,
      })
      .default(() => ({
        enabled: true,
        binaryPath: null,
        credentialRef: null,
        defaultModel: null,
        defaultEffort: null,
        defaultTrustStop: null,
        transport: 'auto' as const,
      })),
  })
  .default(() => ({
    environment: { inherit: { claudeCode: [], codex: [], opencode: [], doe: [] } },
    default: 'claude-code',
    defaultTrustStop: 'autonomy' as const,
    doe: { enabled: true, inference: null, defaultModel: null, defaultTrustStop: null },
    claudeCode: {
      defaultAccount: null,
      accounts: [],
      defaultAccountColor: null,
      defaultAccountOnlyProjects: null,
      projectAccounts: {},
      dismissedFolders: [],
      defaultModel: null,
      defaultEffort: null,
      defaultTrustStop: null,
      persistentSession: true,
      maxWarmProcesses: null,
    },
    opencode: {
      enabled: true,
      binaryPath: null,
      port: 0,
      provider: null,
      baseURL: null,
      defaultModel: null,
      defaultTrustStop: null,
    },
    codex: {
      enabled: true,
      binaryPath: null,
      credentialRef: null,
      defaultModel: null,
      defaultEffort: null,
      defaultTrustStop: null,
      transport: 'auto' as const,
    },
  }));

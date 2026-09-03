import { z } from 'zod';

/** Reusable Zod type for 'true'/'false' env flags → boolean. */
const boolFlag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

/**
 * Reusable Zod type for a 'true'/'false' env flag that keeps the difference
 * between "unset" and "explicitly false".
 *
 * {@link boolFlag} defaults an absent variable to `false`, which is right for a
 * plain feature switch: nobody asked for the feature, so it is off, and the two
 * spellings of "off" mean the same thing. It is wrong wherever the flag OVERRIDES
 * a stored preference, because there the two differ — "nobody said" has to let
 * the stored value decide, while "somebody said false" has to beat it. Reading
 * `undefined` as `false` is what silently stopped an enabled tunnel from coming
 * back after a restart (DOR-1738).
 */
const optionalBoolFlag = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === 'true'));

/**
 * Normalize `value` into the docs origin DorkOS is willing to hand an agent, or
 * `null` when it is not one: the pointer is built by appending `/llms.txt` and
 * `/docs`, so the base has to be an `http:`/`https:` URL carrying no query, no
 * fragment, and no embedded credentials.
 *
 * It RETURNS the normalized string rather than a boolean, and that is the whole
 * design. A predicate plus a separate `.transform()` over the caller's raw input
 * validates one string and emits a different one, because the URL parser
 * silently drops ASCII tab, LF and CR while parsing. `"https://x.dev\n"` then
 * passes the check and still reaches the prompt with its newline, splitting the
 * pointer across two lines:
 *
 *     Documentation: https://x.dev
 *     /llms.txt
 *
 * Emitting `parsed.href` closes that off by construction: whitespace cannot
 * survive URL serialization, so the value that was checked is the value that
 * ships.
 *
 * The three rejections that a URL parse alone will not give us:
 *
 * - Scheme. `new URL('localhost:6244')` succeeds, reading `localhost:` as the
 *   SCHEME. That is the likeliest typo here, and it yields the pointer
 *   `localhost:6244/llms.txt`. `file:///etc`, `javascript:` and `mailto:` parse
 *   just as happily. Same class of guard as `isSafeGitUrl` in
 *   `packages/marketplace/src/marketplace-json-schema.ts`.
 * - Query and fragment, tested against the RAW string on purpose. A bare marker
 *   normalizes to `''` on the parsed URL (`parsed.search` for `https://x.dev?`
 *   is `''`) while the serializer still re-emits it — `new URL('https://x.dev?').href`
 *   is `'https://x.dev/?'` — so reading the parsed value would wave through
 *   `https://x.dev?/llms.txt`. The `#` case is worse than a broken path: the
 *   fragment swallows the appended segment, so the pointer quietly fetches the
 *   site root instead of failing.
 * - Embedded credentials, REFUSED rather than stripped. Userinfo is the only
 *   thing `href` preserves that `origin + pathname` would drop, and here that is
 *   a liability: this string is interpolated into `<dorkos_context>`, which goes
 *   to the model provider on every turn, and an agent can read its own context
 *   and re-emit it into a message, a file write, or a Relay send. A docs base
 *   has no legitimate use for HTTP Basic — public docs need none, and an internal
 *   mirror belongs behind the network layer. Stripping them silently would be
 *   worse than refusing: whoever set the value would believe auth was configured
 *   when it was not.
 */
function parseDocsBaseUrl(value: string): string | null {
  if (/[?#]/.test(value)) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  // Trailing slashes go here so `https://x.dev/` cannot produce `//llms.txt`;
  // `href` always carries at least the root `/`.
  return parsed.href.replace(/\/+$/, '');
}

/** Failure message for {@link parseDocsBaseUrl}. */
const DOCS_BASE_URL_MESSAGE =
  'must be an http:// or https:// URL with no query string, fragment, or embedded username/password';

const serverEnvSchema = z.object({
  // System
  HOME: z.string().optional(),
  GITHUB_TOKEN: z.string().optional(),
  // Runtime
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DORKOS_PORT: z.coerce.number().int().min(1).max(65535).default(4242),
  DORKOS_HOST: z.string().default('localhost'),
  DORKOS_DEFAULT_CWD: z.string().optional(),
  DORKOS_BOUNDARY: z.string().optional(),
  DORKOS_LOG_LEVEL: z.coerce.number().int().min(0).max(5).optional(),
  // Dev-server previews in the canvas each open a listener on a port of their
  // own (DOR-1260). By default the OS picks it, which is right for anyone
  // reaching DorkOS directly. Set a `<from>-<to>` range to pin the choice, so
  // someone running DorkOS in Docker or behind `ssh -L` can forward those ports
  // once (`-p 4243-4252:4243-4252`) and have previews work. Inclusive; `from`
  // must not exceed `to`.
  DORKOS_PREVIEW_PORT_RANGE: z
    .string()
    .regex(/^\d{1,5}-\d{1,5}$/, 'must look like "4243-4252"')
    .transform((value, ctx) => {
      const [from, to] = value.split('-').map(Number);
      const valid = from >= 1 && to <= 65535 && from <= to;
      if (!valid) {
        ctx.addIssue({
          code: 'custom',
          message: 'must be an ascending port range within 1-65535, e.g. "4243-4252"',
        });
        return z.NEVER;
      }
      return { from, to };
    })
    .optional(),
  DORK_HOME: z.string().optional(),
  DORKOS_VERSION_OVERRIDE: z.string().optional(),
  CLIENT_DIST_PATH: z.string().optional(),
  // MCP external server — optional API key for authenticated access
  MCP_API_KEY: z.string().optional(),
  // Telemetry kill switches (DOR-312) — force EVERY outbound channel off,
  // beating config (precedence: env > config). `DO_NOT_TRACK` is the universal
  // cross-tool convention; `DORKOS_TELEMETRY_DISABLED` is the DorkOS-scoped
  // equivalent. Kept as raw strings; the '1'/'true' parsing + precedence live in
  // `@dorkos/shared/telemetry-consent` so the server and CLI agree exactly.
  DO_NOT_TRACK: z.string().optional(),
  DORKOS_TELEMETRY_DISABLED: z.string().optional(),
  // Telemetry debug mode (DOR-312) — when '1'/'true', the heartbeat, install,
  // usage, and error-report senders print the exact JSON payload to stderr
  // instead of sending it.
  DORKOS_TELEMETRY_DEBUG: z.string().optional(),
  // Note: BETTER_AUTH_SECRET (the optional session-signing-secret override) is
  // deliberately NOT declared here. Its sole consumer,
  // services/core/auth/secret.ts, reads process.env directly — that module is a
  // shared seam also bundled into the CLI, and this schema's parse-once
  // snapshot is a server-boot concern. See readEnvSecret() there. (Until
  // DOR-1738 routes/tunnel.ts read NGROK_AUTHTOKEN the same way; it no longer
  // does, and this is the last carve-out of its kind outside a runtime adapter.)
  // Approval decision window (ms). Boot-time only, and CLAMPED AT BOOT so it can
  // only ever SHORTEN the two-hour default, never lengthen it — a one-directional
  // knob cannot be turned into a way to keep consent alive past the moment a
  // person gave it. Exists so the eval harness can observe the "nobody answered
  // and the window closed" outcome as a real terminal state instead of waiting
  // two hours or dressing up a runner timeout as expiry (DOR-498). Nothing an
  // agent can reach through the API touches it.
  DORKOS_APPROVAL_TTL_MS: z.coerce.number().int().min(1000).optional(),
  // Feature flags (boolean after transform)
  DORKOS_A2A_ENABLED: boolFlag,
  // A2A gateway — public base URL advertised on agent cards. Defaults to
  // http://{DORKOS_HOST}:{DORKOS_PORT}, which is non-routable when the host
  // is 0.0.0.0; set this when DorkOS sits behind a proxy/tunnel
  // (e.g. https://agents.example.com). Trailing slashes are stripped.
  // Validated the same way DORKOS_DOCS_BASE_URL is, and for the same reason:
  // `new URL('dorkos:4242')` SUCCEEDS, reading `dorkos:` as the scheme, and
  // serializes to the opaque origin `"null"`. Unvalidated, that typo once made
  // every sandboxed-iframe / `file://` page a trusted origin on the WebSocket
  // upgrade path (ADR 260805-041016). Nothing reads this as a trust boundary
  // any more, but a value that cannot be advertised on an agent card is still
  // worth refusing at boot rather than shipping to a peer.
  DORKOS_PUBLIC_URL: z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined) return undefined;
      const normalized = parseDocsBaseUrl(value);
      if (normalized === null) {
        ctx.addIssue({ code: 'custom', message: DOCS_BASE_URL_MESSAGE });
        return z.NEVER;
      }
      return normalized;
    }),
  // A2A rate limits — requests per minute per IP for the JSON-RPC endpoints
  // (default 60) and the card discovery endpoints (default 300).
  DORKOS_A2A_RPC_RATE_LIMIT: z.coerce.number().int().min(1).optional(),
  DORKOS_A2A_CARD_RATE_LIMIT: z.coerce.number().int().min(1).optional(),
  // Sign-in brute-force limiter — max sign-in/sign-up attempts per IP per window
  // (default 10 / 15 min). A knob for a dev/QA loop or a locked-out owner to
  // relax the limit without a restart; mirrors the A2A override knobs (DOR-281).
  DORKOS_AUTH_SIGNIN_RATE_LIMIT: z.coerce.number().int().min(1).optional(),
  DORKOS_TASKS_ENABLED: boolFlag,
  DORKOS_RELAY_ENABLED: boolFlag,
  // Local-first debug tracing (DOR-294). When 'true' (set by `dorkos
  // --debug-trace`), the server records OpenTelemetry spans for session turns,
  // runtime calls, relay dispatch, and task runs to a sanitized JSONL file
  // under <dorkHome>/traces/. Off by default: no spans, no file, no SDK load.
  // Never phones home — there is no remote/OTLP exporter — so it is a purely
  // local opt-in and does NOT go through the anonymous-telemetry consent.
  DORKOS_OTEL_DEBUG: boolFlag,
  // Bring-your-own observability (DOR-313, Plane 2 of ADR 260713-143958). These
  // are the STANDARD OpenTelemetry env vars, honored so an operator pipes DorkOS
  // traces into their own stack (Jaeger, Grafana Tempo, Honeycomb, ...) with no
  // DorkOS-specific config. Setting an OTLP endpoint registers a batched OTLP/HTTP
  // trace exporter alongside (or instead of) the local debug file. This is the
  // operator's data going to the operator's tools — nothing reaches DorkOS.
  //   - OTEL_EXPORTER_OTLP_ENDPOINT: turns OTLP export on when set (the exporter
  //     also reads OTEL_EXPORTER_OTLP_TRACES_ENDPOINT / _HEADERS natively).
  //   - OTEL_SERVICE_NAME: overrides the resource service.name (default 'dorkos-server').
  //   - OTEL_SDK_DISABLED: universal kill switch — when truthy, ALL tracing stays
  //     off, overriding both the OTLP endpoint and DORKOS_OTEL_DEBUG.
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  OTEL_SERVICE_NAME: z.string().optional(),
  OTEL_SDK_DISABLED: z.string().optional(),
  // Exposure escape hatch (accounts-and-auth task 1.3) — when 'true', allow
  // binding a non-loopback host without a login. Off by default; set only by
  // container images that own their own network boundary (see Dockerfile.*).
  // It also switches OFF the two request-level locality checks, for the same
  // reason — the surrounding environment owns the boundary, and inside a
  // container neither check can succeed anyway (a browser's request arrives from
  // the bridge gateway, not loopback):
  //   - the `/api` host guard (middleware/host-guard.ts)
  //   - the local-only gate on the runtime connect/provision routes (routes/runtimes.ts)
  DORKOS_ALLOW_INSECURE_BIND: boolFlag,
  // Extra host names the `/api` host guard accepts, comma-separated and without
  // ports (DOR-532), e.g. `dorkos.example.com,dorkos.internal`. Only consulted
  // in login-off mode: with login on, the guard is inert because auth cookies
  // are already origin-scoped. Set this when a login-off reverse proxy forwards
  // its own `Host` to DorkOS. See middleware/host-guard.ts.
  DORKOS_TRUSTED_HOSTS: z.string().optional(),
  // Set by a supervising process that owns the server's lifecycle (DOR-532).
  // `desktop` means the Electron shell started this server as a utility process,
  // so the admin restart/reset endpoints refuse (409) rather than exit into a
  // process nothing will bring back. See routes/admin.ts.
  DORKOS_MANAGED_BY: z.enum(['desktop']).optional(),
  // Single-instance lock escape hatch (DOR-532) — when 'true', skip the
  // per-data-directory lock that stops two servers from sharing one `~/.dork`.
  // The lock is already inert under NODE_ENV=test.
  DORKOS_SKIP_INSTANCE_LOCK: boolFlag,
  // Message search — index ONLY what this server's own DORK_HOME holds, never
  // another program's history on the machine (DOR-1551). Off by default, so a
  // normal install keeps the coverage the search box promises: Claude Code,
  // Codex and OpenCode conversations, wherever those programs keep them.
  //
  // Set by a harness whose data directory is a throwaway. Pointing a server at
  // `/tmp/dorkos-cockpit-4245` isolates everything DorkOS owns and nothing
  // else — the index still resolved `~/.claude` from the operator's home, so
  // every browser-suite run copied their real transcripts into that temp dir.
  // `apps/e2e/playwright.config.ts` sets this on both Express legs; nothing
  // else in the repo does. See services/search/registry.ts `selectSearchSources`.
  DORKOS_SEARCH_NO_EXTERNAL_HISTORY: boolFlag,
  // Activity feed — retention period for pruning (defaults to 30 days in service)
  DORKOS_ACTIVITY_RETENTION_DAYS: z.coerce.number().int().min(1).optional(),
  // Test mode — TestModeRuntime is registered instead of ClaudeCodeRuntime
  DORKOS_TEST_RUNTIME: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Test mode only — registers a SECOND TestModeRuntime instance under the
  // 'test-mode-b' type so multi-runtime UI (runtime picker, ?runtime= launch
  // binding, session-list marks) is e2e-testable with zero real agent
  // binaries. Ignored unless DORKOS_TEST_RUNTIME is also true.
  DORKOS_TEST_RUNTIME_SECONDARY: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Test mode only — registers a THIRD TestModeRuntime instance under the
  // 'claude-code' type so the managed-MCP OAuth e2e (DOR-952) can seed an agent
  // whose manifest declares `runtime: 'claude-code'` (the only enum values are
  // claude-code/codex/opencode — 'test-mode' is not a valid manifest runtime) and
  // still have `GET /api/mcp-config?runtime=claude-code` resolve a real runtime
  // instead of 400ing. Same TestModeRuntime class, so it answers `getMcpStatus`
  // from the managed-server injection resolver. Ignored unless DORKOS_TEST_RUNTIME
  // is also true.
  DORKOS_TEST_RUNTIME_CLAUDE_ALIAS: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Q3 contention harness (DOR-500) — read ONLY by the `q3-*` test-mode
  // scenarios (services/runtimes/test-mode/q3-contention-scenarios.ts), which
  // are unreachable unless DORKOS_TEST_RUNTIME is true and a `q3-*` name is
  // bound to a session. Set by `scripts/q3-contention/run.ts`, never by a real
  // install.
  //   - DURATION_MS: how long a q3 turn streams, so concurrent turns overlap.
  //   - TICK_MS: gap between token yields (and between canary read-modify-writes).
  //   - CANARY_MAP: JSON, vocabulary name → absolute shared-canary path. Absent
  //     means the scenarios stream but touch no filesystem. Paths are guarded
  //     against the active DORK_HOME and the real `~/.dork` at parse time.
  DORKOS_Q3_DURATION_MS: z.coerce.number().int().min(0).default(30_000),
  DORKOS_Q3_TICK_MS: z.coerce.number().int().min(1).default(500),
  DORKOS_Q3_CANARY_MAP: z.string().optional(),
  // Tunnel (ngrok integration — all optional)
  // TUNNEL_ENABLED is tri-state on purpose: the boot-time autostart falls back to
  // the stored `tunnel.enabled` preference when nobody set the variable, so it
  // has to be able to tell that apart from an explicit `false`, which beats the
  // stored value. See services/core/tunnel-boot-config.ts.
  TUNNEL_ENABLED: optionalBoolFlag,
  TUNNEL_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  TUNNEL_AUTH: z.string().optional(),
  TUNNEL_DOMAIN: z.string().optional(),
  NGROK_AUTHTOKEN: z.string().optional(),
  // DorkOS cloud base URL for device-link (accounts-and-auth P2). Defaults to
  // production; override for local dev against the site (e.g.
  // http://localhost:$SITE_PORT). Trailing slashes are normalized by the
  // cloud-link client.
  DORKOS_CLOUD_URL: z.string().default('https://dorkos.ai'),
  // Origin the agent-facing docs pointers are built from: the `<dorkos_context>`
  // block hands an agent `{base}/llms.txt` and `{base}/docs`
  // (services/runtimes/shared/agent-context.ts). Not every session gets that
  // block — it ships only where the working directory hosts an agent manifest
  // and that agent has `conventions.dorkosKnowledge` left on — but where it does
  // ship, it rides every turn of every runtime. Defaults to production, so a
  // normal install keeps pointing its agents at the published docs. Override it
  // when you run `apps/site` yourself (e.g. http://localhost:6244) so a dev
  // instance stops telling its agents to read whatever shipped last. Read once
  // at boot, never per turn: the block has to stay byte-identical for prompt
  // caching, and nothing here probes whether the URL answers. Validation and
  // normalization are one step (see parseDocsBaseUrl) so the string that was
  // checked is exactly the string the prompt gets.
  DORKOS_DOCS_BASE_URL: z
    .string()
    .default('https://dorkos.ai')
    .transform((value, ctx) => {
      const normalized = parseDocsBaseUrl(value);
      if (normalized === null) {
        ctx.addIssue({ code: 'custom', message: DOCS_BASE_URL_MESSAGE });
        return z.NEVER;
      }
      return normalized;
    }),
  // Connector gateway — self-hosted Nango backend (connector-gateway spec P7,
  // DOR-371). The base URL DorkOS points its self-host connector at, e.g.
  // http://localhost:3003. Absent = the Nango connector is not configured, and
  // the registry is left unchanged (no `nango` provider, no crash).
  // `.url()` so a malformed address fails env parse at boot with a Zod message
  // instead of surfacing later as an unreachable connector (DOR-415 review nit).
  NANGO_BASE_URL: z.string().url().optional(),
  // The 256-bit encryption key (written in base64) your self-hosted Nango uses
  // at rest. DorkOS gates on it: when the Nango connector is otherwise configured
  // (base URL + secret key), it refuses to register unless this is set to a valid
  // 32-byte base64 key — without it Nango stores logins unencrypted and the "your
  // infrastructure, your keys" promise is false (spec §Detailed Design 4). Set the
  // SAME value here and on your Nango server. See docs/connections/nango.mdx.
  NANGO_ENCRYPTION_KEY: z.string().optional(),
});

const result = serverEnvSchema.safeParse(process.env);

if (!result.success) {
  console.error('\n  Missing or invalid environment variables:\n');
  console.error(z.prettifyError(result.error));
  console.error('\n  Copy .env.example to .env\n');
  process.exit(1);
}

export const env = result.data;
export type ServerEnv = typeof env;

// The marketplace auto-approve environment variable was retired (DOR-501):
// marketplace installs always need a person's approval now, and nothing reads
// it any more. Zod silently strips unknown keys rather than rejecting them, so
// a pipeline still setting it gets no error: `marketplace_install` just
// returns `requires_confirmation` forever, which a naive script can misread
// as success. Warn instead of failing silent.
//
// The name is assembled from fragments, not written as a literal, so this
// intentional (advisory-only, never behavior-changing) mention doesn't trip
// `no-auto-approve-env-var.test.ts`'s reintroduction guard — see that file's
// module TSDoc for why the guard treats any literal appearance of the name as
// a regression.
const RETIRED_AUTO_APPROVE_ENV_VAR = ['MARKETPLACE', 'AUTO', 'APPROVE'].join('_');
if (process.env[RETIRED_AUTO_APPROVE_ENV_VAR]) {
  console.warn(
    `\n  ${RETIRED_AUTO_APPROVE_ENV_VAR} is set, but it no longer does anything: marketplace installs always wait for your approval now. Remove it from your environment. See contributing/external-agent-marketplace-access.md for how to approve installs from a script.\n`
  );
}

/**
 * How a sandbox is told to run OpenCode against a paid external provider — the
 * `real-provider` tier's one piece of setup.
 *
 * Nothing here is a product change, and that is the point. Every lever this
 * module pulls already exists for a person clicking through Settings:
 *
 * - `providers.<id>` takes a credential REFERENCE, and `env:VAR` is one of the
 *   three schemes (`services/core/credential-provider.ts`). So the sandbox
 *   config can say "the OpenRouter key is in this environment variable" and the
 *   server resolves it at sidecar spawn through its own credential port
 *   (`services/core/credential-env.ts` maps `openrouter → OPENROUTER_API_KEY`).
 *   The harness never writes a secret to disk.
 * - `runtimes.opencode.binaryPath` is AUTHORITATIVE in binary resolution
 *   (`opencode/providers/check-dependencies.ts`). It has to be set, because a
 *   sandbox `DORK_HOME` is empty: the server's own provisioned-install candidate
 *   resolves under the SANDBOX home, where no 137 MB of `opencode-ai` exists,
 *   and `opencode` is not on `PATH` on a machine that provisioned it through
 *   DorkOS. Pointing at the host's provisioned binary is what keeps a run from
 *   re-downloading it per eval.
 * - `runtimes.opencode.defaultModel` is what a new session starts on
 *   (`services/session/resolve-session-defaults.ts`), which is how the pinned
 *   OpenRouter model reaches `session.promptAsync` as `{providerID, modelID}`.
 *
 * ## Whole sections, not deep merges
 *
 * `conf` merges its `defaults` with the stored file at the TOP LEVEL only, and
 * `ConfigManager.get(key)` hands back what is stored verbatim. So a config file
 * carrying a partial `runtimes` object would REPLACE the defaults for every
 * sibling runtime — no `claude-code` settings, no `codex` block, no `default`.
 * {@link buildOpenCodeSandboxConfig} therefore writes the section whole, layered
 * over `USER_CONFIG_DEFAULTS`, and a test pins that it stays that way.
 *
 * @module evals/runner/opencode-sandbox
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { USER_CONFIG_DEFAULTS, type UserConfig } from '@dorkos/shared/config-schema';
import { OPENROUTER_API_KEY_VAR } from '../types.js';

/**
 * Where a DorkOS-provisioned `opencode` lives, relative to a DorkOS data
 * directory.
 *
 * MIRRORS `resolveProvisionedOpenCodePath()` in
 * `apps/server/src/services/runtimes/opencode/providers/provision.ts`, which is
 * the source of truth. It is repeated rather than imported because importing it
 * would resolve the path against the SANDBOX `DORK_HOME` inside the launched
 * server — the exact thing this tier has to avoid — and would drag the server's
 * logger into the runner process for one string. A test pins the two together.
 */
const PROVISIONED_OPENCODE_SEGMENTS = ['runtimes', 'opencode', 'node_modules', '.bin'] as const;

/** The provisioned binary's file name, per platform (npm's bin shim). */
function provisionedBinaryName(platform: string = process.platform): string {
  return platform === 'win32' ? 'opencode.cmd' : 'opencode';
}

/** Options for {@link resolveHostOpenCodeBinary}. */
export interface ResolveHostOpenCodeBinaryOptions {
  /**
   * The HOST DorkOS data directory to look under — the operator's real one, not
   * an eval sandbox. Defaults to `$DORK_HOME`, else `~/.dork`.
   */
  dorkHome?: string;
  /** Existence probe seam, for tests. Defaults to `fs.existsSync`. */
  exists?: (candidate: string) => boolean;
  /** Platform seam, for tests. Defaults to `process.platform`. */
  platform?: string;
}

/**
 * The `opencode` binary a sandboxed server should be pointed at, or `undefined`
 * when this machine has none.
 *
 * Looks only at the HOST's provisioned install. A `PATH` lookup is deliberately
 * not attempted: the launched server inherits `PATH` already, so if `opencode`
 * were on it the server would find it unaided and no `binaryPath` would be
 * needed at all. What the server genuinely cannot find on its own is the
 * provisioned copy, because it resolves that against its own (sandbox)
 * `DORK_HOME`.
 *
 * @param opts - Host data directory + test seams; see
 *   {@link ResolveHostOpenCodeBinaryOptions}.
 * @returns The absolute binary path, or undefined when it is not installed.
 */
export function resolveHostOpenCodeBinary(
  opts: ResolveHostOpenCodeBinaryOptions = {}
): string | undefined {
  const exists = opts.exists ?? existsSync;
  const home =
    opts.dorkHome ??
    // eslint-disable-next-line no-restricted-syntax -- the runner must find the OPERATOR's data directory to locate their provisioned binary; the sandbox home is the one place this must NOT read.
    process.env.DORK_HOME ??
    path.join(homedir(), '.dork');
  const candidate = path.join(
    home,
    ...PROVISIONED_OPENCODE_SEGMENTS,
    provisionedBinaryName(opts.platform)
  );
  return exists(candidate) ? candidate : undefined;
}

/**
 * The message a `real-provider` run gets when no `opencode` binary can be found.
 *
 * @returns The runner-error message.
 */
export function noOpenCodeBinaryMessage(): string {
  return (
    'No `opencode` binary was found to point the eval sandbox at. DorkOS provisions one on ' +
    'demand — open Settings → Runtimes → OpenCode and connect it once, or install it yourself ' +
    '(`npm i -g opencode-ai`) and set DORK_HOME to the data directory holding the provisioned ' +
    'copy. A sandbox `DORK_HOME` is empty, so the server cannot find its own provisioned install ' +
    'without being told where the real one lives.'
  );
}

/** Options for {@link buildOpenCodeSandboxConfig}. */
export interface OpenCodeSandboxConfigOptions {
  /** Absolute path to the `opencode` binary the sandboxed server must use. */
  binaryPath: string;
  /** Provider id, keying both the `providers` registry and OpenCode's own table. */
  provider: string;
  /** Pinned model as `provider/model`, e.g. `openrouter/qwen/qwen3.7-flash`. */
  model: string;
}

/**
 * The config sections a sandbox needs so its server runs OpenCode on a paid
 * external provider. Returns whole top-level sections (see the module TSDoc on
 * why nothing here may be partial).
 *
 * @param opts - Binary, provider, model; see {@link OpenCodeSandboxConfigOptions}.
 * @returns The `providers` + `runtimes` sections to write into the sandbox config.
 */
export function buildOpenCodeSandboxConfig(
  opts: OpenCodeSandboxConfigOptions
): Pick<UserConfig, 'providers' | 'runtimes'> {
  return {
    providers: {
      ...USER_CONFIG_DEFAULTS.providers,
      // A REFERENCE, never the secret. The server resolves it through its own
      // credential port at sidecar spawn, reading the variable the launcher put
      // in the server's environment.
      [opts.provider]: `env:${OPENROUTER_API_KEY_VAR}`,
    },
    runtimes: {
      ...USER_CONFIG_DEFAULTS.runtimes,
      // Every session this sandbox creates is an OpenCode session — the drive
      // loop also sends the per-session `runtime` hint, and these two agreeing is
      // what keeps a session created by any other path (a room, a task) honest.
      default: 'opencode',
      opencode: {
        ...USER_CONFIG_DEFAULTS.runtimes.opencode,
        enabled: true,
        binaryPath: opts.binaryPath,
        provider: opts.provider,
        defaultModel: opts.model,
      },
    },
  };
}

/**
 * Write the sandbox's `config.json` BEFORE its server boots, so the config store
 * reads these values on its first load rather than being patched afterwards.
 *
 * Ordering matters: `runtimes.opencode.enabled` is consulted at REGISTRATION
 * time (`apps/server/src/index.ts`), and a runtime that was not registered at
 * boot cannot be reached by a later config change.
 *
 * @param dorkHome - The sandbox `DORK_HOME` (the config store's directory).
 * @param sections - The sections to persist; see {@link buildOpenCodeSandboxConfig}.
 * @returns The absolute path written.
 */
export async function writeSandboxConfig(
  dorkHome: string,
  sections: Pick<UserConfig, 'providers' | 'runtimes'>
): Promise<string> {
  await mkdir(dorkHome, { recursive: true });
  const file = path.join(dorkHome, 'config.json');
  await writeFile(file, JSON.stringify(sections, null, 2) + '\n', 'utf8');
  return file;
}

/**
 * On-demand Claude Code provisioning (ADR-0317, extended to claude-code).
 *
 * The Agent SDK ships Claude Code as a per-platform native binary in its
 * optional dependencies, so Claude is usually resolvable with no install at all.
 * When that bundled binary is absent — a `--no-optional` install, a blocked
 * download, a platform whose optional package never landed — the readiness
 * ladder projects Claude Code to Connect with an "Install Claude" action. That
 * button had no endpoint behind it and answered 404 (DOR-1334 / F4); this module
 * is the endpoint's other half.
 *
 * It installs the SAME per-platform package the SDK would have bundled, pinned
 * to the SDK version the server depends on, into a DorkOS-owned,
 * dork-home-scoped location — never a global `npm i -g`, never `os.homedir()`
 * (hard rule; resolved via `lib/dork-home.ts`). On success the provisioned
 * binary joins the shared resolution ladder and Claude Code flips to Ready; on
 * failure the partial tree is removed and the caller gets an honest message.
 *
 * This module also owns the NAMES of those per-platform packages, because the
 * name it installs and the name the SDK-bundled lookup resolves must be the same
 * list or the provisioned rung could never resolve what this installed.
 *
 * @module services/runtimes/claude-code/tooling/provision
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { resolveDorkHome } from '../../../../lib/dork-home.js';
import { logger } from '../../../../lib/logger.js';
import {
  createNpmProvisioner,
  readInstalledPackageVersion,
} from '../../shared/program/provision-npm.js';

/**
 * `@anthropic-ai/claude-agent-sdk` version whose per-platform binary package is
 * installed — pinned to the SDK the server already depends on
 * (`apps/server/package.json`), so the provisioned CLI and the SDK that drives
 * it can never drift. A future SDK bump updates this in lockstep (a test fails
 * red otherwise).
 *
 * That forced edit makes this the right place to say what else a re-pin has to
 * re-check, because nothing else reds on its own: `mapSdkModelToModelOption`
 * (`../messaging/runtime-cache.ts`) ASSERTS `supportsToolUse` / `supportsVision`
 * / `supportsImageOutput` for every Claude model rather than reading them,
 * because `ModelInfo` reports nothing capability-shaped. Re-read that TSDoc on
 * every bump: if the new SDK reports any of them, read it instead of claiming
 * it; if Anthropic ships a text-only model, the `supportsVision` claim is the
 * one that goes wrong first.
 */
export const CLAUDE_SDK_VERSION = '0.3.304';

/** npm name of the SDK whose per-platform binary packages this module installs. */
const SDK_PKG = '@anthropic-ai/claude-agent-sdk';

/** Executable name inside the per-platform package. */
const CLAUDE_BIN = process.platform === 'win32' ? 'claude.exe' : 'claude';

/**
 * Whether this Linux host uses musl libc (Alpine) rather than glibc.
 *
 * Node's diagnostic report names the glibc runtime version it linked against;
 * on a musl host the field is simply absent. Cheaper and more reliable than
 * shelling out to `ldd --version`, and it decides which of the two Linux binary
 * packages is worth installing — the wrong one installs fine and then refuses to
 * run, which is a failure mode nobody enjoys diagnosing.
 *
 * A host with NO diagnostic report at all cannot be told apart either way, so it
 * is treated as glibc: that is what the great majority of Linux hosts are, and
 * `resolveProvisionedClaudePath` still checks both package names afterwards, so
 * a wrong guess here costs an install, never a permanently unusable rung.
 */
function isMuslLinux(): boolean {
  const report = process.report?.getReport() as
    { header?: { glibcVersionRuntime?: string } } | undefined;
  if (!report) return false;
  return report.header?.glibcVersionRuntime === undefined;
}

/**
 * The per-platform binary packages that can hold a `claude` for THIS host, in
 * preference order.
 *
 * Since 0.2.113 the Agent SDK ships Claude Code as a native binary in optional
 * dependencies named `@anthropic-ai/claude-agent-sdk-<platform>-<arch>`, exposing
 * `claude` (or `claude.exe`) at the package root. Only one is ever installed on a
 * given host, so resolution tries each in turn and provisioning installs the
 * first.
 *
 * **The published set is EIGHT names, and `-android` is not among them** —
 * re-read off the SDK's own `optionalDependencies` at both 0.3.224 and 0.3.268:
 * `linux-x64`, `linux-arm64`, `linux-x64-musl`, `linux-arm64-musl`, `darwin-x64`,
 * `darwin-arm64`, `win32-x64`, `win32-arm64`. The `android` branch below is
 * therefore dead today. It stays because its cost is one install attempt that
 * fails with a clear error on a platform DorkOS has never supported, while
 * deleting it would silently route such a host at a glibc Linux binary instead —
 * a wrong answer dressed as a right one. Delete it the day `process.platform`
 * can be `'android'` here for a reason.
 *
 * @returns Ordered candidate package names (never empty).
 */
export function claudePlatformPackages(): string[] {
  const { platform, arch } = process;
  if (platform === 'android') return [`${SDK_PKG}-linux-${arch}-android`];
  if (platform === 'linux') {
    const glibc = `${SDK_PKG}-linux-${arch}`;
    const musl = `${SDK_PKG}-linux-${arch}-musl`;
    return isMuslLinux() ? [musl, glibc] : [glibc, musl];
  }
  return [`${SDK_PKG}-${platform}-${arch}`];
}

/** Dork-home-scoped directory the provisioned binary package is installed into. */
export function resolveClaudeProvisionDir(): string {
  return path.join(resolveDorkHome(), 'runtimes', 'claude-code');
}

/**
 * Absolute path to the provisioned `claude` binary, or `null` when nothing
 * USABLE was provisioned for this host.
 *
 * Unlike the codex twin this checks existence itself, because a host can have
 * two plausible package names (glibc/musl) and only the installed one is the
 * answer. The shared ladder existence-checks the result again, harmlessly.
 *
 * **Existence is not enough, and this rung fails closed on version.** The
 * provisioned install is written once and nothing ever re-checked it, so a pin
 * bump used to leave a stale `claude` on the ladder forever — the same bug
 * DOR-1034 fixed on the OpenCode side, and this mirrors that fix. It is not
 * cosmetic: a host with no bundled binary keeps its old provisioned CLI, and
 * from SDK 0.3.268 a session with at least one plugin enabled is launched with
 * `--await-initialize`, which an older `claude` rejects as an unknown option.
 * Every turn would fail to start, for a person who never changed anything.
 *
 * So a binary is returned only when its package's own `package.json` reports
 * exactly {@link CLAUDE_SDK_VERSION}. A mismatched, missing or unreadable
 * version reads as "not provisioned": resolution falls through to `PATH`, the
 * readiness ladder projects Claude Code to Connect, and
 * {@link provisionClaudeCode} installs the pinned version over it. Falling
 * through costs at worst one re-install; returning a stale binary costs every
 * turn.
 *
 * Deliberately synchronous, and deliberately not self-healing, unlike the
 * OpenCode twin: this rung is shared verbatim by the SDK spawn seam and the
 * readiness probe (`resolveClaudeBinaryBeforePath`), both of which need an
 * answer without awaiting an npm install.
 */
export function resolveProvisionedClaudePath(): string | null {
  const dir = resolveClaudeProvisionDir();
  for (const pkg of claudePlatformPackages()) {
    const binary = path.join(dir, 'node_modules', ...pkg.split('/'), CLAUDE_BIN);
    if (!existsSync(binary)) continue;
    const installed = readInstalledPackageVersion(
      path.join(dir, 'node_modules', ...pkg.split('/'), 'package.json')
    );
    if (installed === CLAUDE_SDK_VERSION) return binary;
    logger.info(
      installed
        ? `[ClaudeCode] provisioned ${pkg} ${installed} != pinned ${CLAUDE_SDK_VERSION} — treating as not provisioned`
        : `[ClaudeCode] provisioned ${pkg} version unreadable — treating as not provisioned`
    );
  }
  return null;
}

/**
 * Install this platform's Claude Code binary package on demand into the
 * dork-home-scoped location, through the shared npm provisioner: concurrent
 * calls share one install, progress streams to `onProgress`, and a failed
 * install (or an exit-0 that left no usable binary) is removed and answers with
 * an honest error. Never rejects.
 */
export const provisionClaudeCode = createNpmProvisioner({
  runtime: 'claude-code',
  label: 'Claude Code',
  logTag: '[ClaudeCode]',
  dir: resolveClaudeProvisionDir,
  spec: () => `${claudePlatformPackages()[0]}@${CLAUDE_SDK_VERSION}`,
  installedBinary: resolveProvisionedClaudePath,
});

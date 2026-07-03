import type { DependencyCheck } from '@dorkos/shared/agent-runtime';
import { resolveBundledClaudeBinary } from '../sdk/sdk-utils.js';
import { findBinaryOnPath, runBinaryProbe } from '../../shared/run-probe.js';

/** Hard bound on each Claude CLI probe (the PATH locate and the `--version` call). */
const PROBE_TIMEOUT_MS = 5_000;

/** Return the platform-appropriate install command for the Claude Code CLI. */
function getInstallHint(): string {
  if (process.platform === 'win32') {
    return 'irm https://claude.ai/install.ps1 | iex';
  }
  // macOS, Linux, WSL
  return 'curl -fsSL https://claude.ai/install.sh | bash';
}

/**
 * Check whether a usable Claude Code binary is available to power agent sessions.
 *
 * Reports `satisfied` when the SDK's bundled native binary (shipped with DorkOS
 * since SDK 0.2.113) or a `claude` on PATH resolves and answers `--version`.
 * Reports `missing` with an install hint only when neither resolves, so a failed
 * optional-dependency install (which would otherwise break sessions silently)
 * surfaces clearly.
 *
 * Fully asynchronous and time-bounded (via the shared `run-probe` helpers): the
 * bundled-binary lookup is a synchronous `require.resolve` (no process spawn),
 * while the PATH locate and the `--version` call are both bounded, so a hung
 * binary or a stalled `PATH` mount degrades to `missing` fast instead of blocking
 * the Node event loop. This gives Claude (the default, always-registered runtime)
 * the same non-blocking guarantee the Codex and OpenCode adapters have, absorbing
 * the DOR-180 "make checkDependencies probes async" follow-up.
 */
export async function checkClaudeDependency(): Promise<DependencyCheck> {
  const name = 'Claude Code CLI';
  const description = 'The Claude Code CLI powers agent sessions in DorkOS.';
  const binary =
    resolveBundledClaudeBinary() ?? (await findBinaryOnPath('claude', PROBE_TIMEOUT_MS));

  if (binary) {
    try {
      const version = await runBinaryProbe(binary, ['--version'], PROBE_TIMEOUT_MS);
      return { name, description, status: 'satisfied', version };
    } catch {
      // Binary resolved but failed to launch (or the probe timed out) — fall through to "missing".
    }
  }

  return {
    name,
    description,
    status: 'missing',
    installHint: getInstallHint(),
    infoUrl: 'https://docs.anthropic.com/en/docs/claude-code',
  };
}

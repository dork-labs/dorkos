/**
 * The `--version` check every runtime makes on its program (Claude Code, Codex,
 * OpenCode), one shape for all three: satisfied with the version it reported,
 * or missing with that runtime's install hint.
 *
 * Kept apart from `run-probe.ts`, which it calls through its public exports, so
 * a test that fakes the probe fakes it for this check too.
 *
 * @module services/runtimes/shared/program/cli-binary-check
 */
import type { DependencyCheck } from '@dorkos/shared/agent-runtime';
import type { EnvironmentRuntime } from '../runtime-environment.js';
import { logProbeFailure, runBinaryProbe } from '../run-probe.js';

/** What one runtime's CLI check says about its program, for {@link checkCliBinary}. */
export interface CliBinaryCheck {
  /** Check name; the readiness derivation matches it with `/\bCLI\b/i`. */
  name: string;
  /** One sentence on what the program does in DorkOS. */
  description: string;
  /** The install command shown when the program is missing. */
  installHint: string;
  /** Where to read about the program. */
  infoUrl: string;
  /** Runtime whose credential-free version-probe environment the probe runs in. */
  runtime: EnvironmentRuntime;
  /** Hard bound on the `--version` probe. */
  timeoutMs: number;
  /** Extra fields for a satisfied check, from the version the binary reported. */
  versionFields?: (binary: string, version: string) => Partial<DependencyCheck>;
}

/**
 * Check that a runtime's program resolves and answers `--version`.
 *
 * A binary that resolved but would not run, or did not answer in time, reads as
 * `missing` with the install hint — and says so once in the log, because a
 * resolvable binary that will not run is exactly the case a person cannot
 * diagnose from the requirements payload alone (DOR-1334 / F3).
 *
 * @param binary - The resolved binary, or `null` when none resolved.
 * @param check - The runtime's check name, copy and probe settings.
 */
export async function checkCliBinary(
  binary: string | null,
  check: CliBinaryCheck
): Promise<DependencyCheck> {
  const { name, description } = check;
  if (binary) {
    try {
      const version = await runBinaryProbe(binary, ['--version'], check.timeoutMs, {
        runtime: check.runtime,
        purpose: 'version-probe',
      });
      return {
        name,
        description,
        status: 'satisfied',
        version,
        ...check.versionFields?.(binary, version),
      };
    } catch (err) {
      logProbeFailure(name, binary, err);
    }
  }
  return {
    name,
    description,
    status: 'missing',
    installHint: check.installHint,
    infoUrl: check.infoUrl,
  };
}

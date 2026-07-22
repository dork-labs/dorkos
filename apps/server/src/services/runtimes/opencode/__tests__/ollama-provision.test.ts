import { describe, it, expect, vi } from 'vitest';
import type { RuntimeProvisionProgress } from '@dorkos/shared/transport';
import type { OllamaStatus } from '@dorkos/shared/runtime-connect';
import {
  detectOllamaInstallMethod,
  provisionOllama,
  OLLAMA_WINGET_ID,
  type OllamaProvisionDeps,
} from '../ollama-provision.js';

/** A recording `runCommand` seam: logs every `[command, ...args]` and returns per-command outcomes. */
function makeRunCommand(outcomes: Record<string, { ok: boolean; detail?: string }> = {}) {
  const calls: string[][] = [];
  const runCommand = vi.fn(async (command: string, args: string[]) => {
    calls.push([command, ...args]);
    return outcomes[command] ?? { ok: true };
  });
  return { runCommand, calls };
}

const RUNNING: OllamaStatus = { running: true, models: [] };
const NOT_RUNNING: OllamaStatus = { running: false, models: [] };

describe('detectOllamaInstallMethod', () => {
  it('darwin with brew on PATH → brew', async () => {
    const method = await detectOllamaInstallMethod({
      platform: 'darwin',
      commandExists: async (cmd) => cmd === 'brew',
    });
    expect(method).toBe('brew');
  });

  it('darwin without brew on PATH → manual', async () => {
    const method = await detectOllamaInstallMethod({
      platform: 'darwin',
      commandExists: async () => false,
    });
    expect(method).toBe('manual');
  });

  it('win32 with winget on PATH → winget', async () => {
    const method = await detectOllamaInstallMethod({
      platform: 'win32',
      commandExists: async (cmd) => cmd === 'winget',
    });
    expect(method).toBe('winget');
  });

  it('win32 without winget on PATH → manual', async () => {
    const method = await detectOllamaInstallMethod({
      platform: 'win32',
      commandExists: async () => false,
    });
    expect(method).toBe('manual');
  });

  it('linux (or any other platform) → manual', async () => {
    const method = await detectOllamaInstallMethod({
      platform: 'linux',
      commandExists: async () => true,
    });
    expect(method).toBe('manual');
  });
});

describe('provisionOllama', () => {
  it('brew happy path: installs, starts the service, and reports running', async () => {
    const { runCommand, calls } = makeRunCommand();
    const progress: RuntimeProvisionProgress[] = [];
    const deps: OllamaProvisionDeps = {
      platform: 'darwin',
      commandExists: async (cmd) => cmd === 'brew',
      runCommand,
      detectOllamaFn: async () => RUNNING,
    };

    const result = await provisionOllama((p) => progress.push(p), deps);

    expect(result.ok).toBe(true);
    expect(result.installMethod).toBe('brew');
    expect(result.status).toEqual(RUNNING);
    // Never sudo, never a shell — brew install then a best-effort service start.
    expect(calls).toEqual([
      ['brew', 'install', 'ollama'],
      ['brew', 'services', 'start', 'ollama'],
    ]);
    expect(progress.map((p) => p.stage)).toContain('starting');
    expect(progress.map((p) => p.stage)).toContain('done');
  });

  it('brew: a failed service start is NOT an install failure (still ok, running reflects the probe)', async () => {
    const { runCommand } = makeRunCommand({
      // install succeeds; the service start fails — must not fail the install.
      brew: { ok: true },
    });
    // Distinguish the two brew calls: install ok, services start fails.
    runCommand.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'brew' && args[0] === 'services')
        return { ok: false, detail: 'launchctl error' };
      return { ok: true };
    });
    const deps: OllamaProvisionDeps = {
      platform: 'darwin',
      commandExists: async (cmd) => cmd === 'brew',
      runCommand,
      detectOllamaFn: async () => NOT_RUNNING,
    };

    const result = await provisionOllama(undefined, deps);

    expect(result.ok).toBe(true);
    expect(result.installMethod).toBe('brew');
    expect(result.status).toEqual(NOT_RUNNING);
  });

  it('winget path: installs non-interactively with the verified package id', async () => {
    const { runCommand, calls } = makeRunCommand();
    const deps: OllamaProvisionDeps = {
      platform: 'win32',
      commandExists: async (cmd) => cmd === 'winget',
      runCommand,
      detectOllamaFn: async () => RUNNING,
    };

    const result = await provisionOllama(undefined, deps);

    expect(result.ok).toBe(true);
    expect(result.installMethod).toBe('winget');
    expect(calls).toEqual([
      [
        'winget',
        'install',
        '--id',
        OLLAMA_WINGET_ID,
        '--accept-package-agreements',
        '--accept-source-agreements',
        '--silent',
      ],
    ]);
    // No service-start step on Windows.
    expect(calls.some((c) => c.includes('services'))).toBe(false);
  });

  it('condenses a failed install into an honest, non-raw error and cleans up nothing to run', async () => {
    const { runCommand } = makeRunCommand({ brew: { ok: false, detail: 'network unreachable' } });
    const deps: OllamaProvisionDeps = {
      platform: 'darwin',
      commandExists: async (cmd) => cmd === 'brew',
      runCommand,
      detectOllamaFn: async () => RUNNING,
    };

    const result = await provisionOllama(undefined, deps);

    expect(result.ok).toBe(false);
    expect(result.installMethod).toBe('brew');
    expect(result.error).toContain('Could not install Ollama');
    expect(result.error).toContain('network unreachable');
    // A failed install carries no optimistic status.
    expect(result.status).toBeUndefined();
  });

  it('manual platform: rejects without touching the system', async () => {
    const { runCommand, calls } = makeRunCommand();
    const deps: OllamaProvisionDeps = {
      platform: 'linux',
      commandExists: async () => true,
      runCommand,
    };

    const result = await provisionOllama(undefined, deps);

    expect(result.ok).toBe(false);
    expect(result.installMethod).toBe('manual');
    expect(result.error).toMatch(/one-click install is not available/i);
    expect(calls).toEqual([]);
  });
});

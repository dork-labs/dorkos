/**
 * Default terminal, clipboard, and Fly boundaries for Community owner handoff.
 *
 * @module commands/community-deploy/runtime/default-owner
 */
import { access, constants } from 'node:fs/promises';
import { platform } from 'node:os';
import { delimiter, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { deployFlySecrets, stageFlySecrets, verifyExistingFlyDeployment } from '../fly-mutate.js';
import { readFlyRuntimeInventory } from '../fly-read.js';
import { readFlySecretInventory } from '../tigris-session.js';
import { runProviderCommand } from '../provider-process.js';
import { verifyCommunityHealth } from '../health.js';
import type { CommunityOwnerDependencies } from '../owner.js';
import type { CommunityServiceOptions } from './default-services.js';
import type { LaunchJournal } from '../journal.js';
import type { LaunchPlan } from '../plan.js';

const COMMUNITY_IMAGE_REPOSITORY = 'ghcr.io/dork-labs/dorkos-community';

async function ask(question: string, signal?: AbortSignal): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('An interactive terminal is required');
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    return await prompt.question(question, { signal });
  } finally {
    prompt.close();
  }
}

type HandoffPlatform = 'darwin' | 'linux' | 'win32';

function handoffCommands(system: NodeJS.Platform): {
  clipboard: { executable: string; args: string[] };
  browser: { executable: string; args(origin: string): string[] };
} {
  if (system === 'darwin') {
    return {
      clipboard: { executable: 'pbcopy', args: [] },
      browser: { executable: 'open', args: (origin) => [origin] },
    };
  }
  if (system === 'win32') {
    return {
      clipboard: { executable: 'clip.exe', args: [] },
      browser: { executable: 'cmd.exe', args: (origin) => ['/c', 'start', '', origin] },
    };
  }
  return {
    clipboard: { executable: 'wl-copy', args: [] },
    browser: { executable: 'xdg-open', args: (origin) => [origin] },
  };
}

async function executableOnPath(executable: string, path: string): Promise<boolean> {
  for (const directory of path.split(delimiter).filter(Boolean)) {
    try {
      await access(join(directory, executable), constants.X_OK);
      return true;
    } catch {
      // Continue through the explicit PATH without invoking a shell.
    }
  }
  return false;
}

/** Prove the non-printing owner-secret handoff is locally available before provider writes. */
export async function assertOwnerHandoffPrerequisites(
  path: string,
  system: NodeJS.Platform = platform()
): Promise<void> {
  if (!(['darwin', 'linux', 'win32'] as const).includes(system as HandoffPlatform)) {
    throw new Error(
      'Owner handoff is unsupported on this platform. See https://github.com/dork-labs/dorkos/blob/main/apps/community/FLY.md'
    );
  }
  const commands = handoffCommands(system);
  const missing = (
    await Promise.all(
      [commands.clipboard.executable, commands.browser.executable].map(async (executable) => ({
        executable,
        found: await executableOnPath(executable, path),
      }))
    )
  ).filter(({ found }) => !found);
  if (missing.length > 0) {
    throw new Error(
      `Owner handoff needs ${missing.map(({ executable }) => executable).join(' and ')} before setup can create resources. See https://github.com/dork-labs/dorkos/blob/main/apps/community/FLY.md`
    );
  }
}

async function clipboard(
  value: string,
  env: Readonly<Record<string, string>>,
  system: NodeJS.Platform
): Promise<void> {
  const command = handoffCommands(system).clipboard;
  await runProviderCommand({
    ...command,
    env,
    timeoutMs: 5_000,
    stdin: value,
    parse: () => undefined,
  });
}

async function openOrigin(
  origin: string,
  env: Readonly<Record<string, string>>,
  system: NodeJS.Platform
): Promise<void> {
  const boundary = handoffCommands(system).browser;
  const command = { executable: boundary.executable, args: boundary.args(origin) };
  await runProviderCommand({
    ...command,
    env,
    timeoutMs: 10_000,
    parse: () => undefined,
  });
}

async function ownerExists(origin: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(new URL('/api/v1/community', origin), {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 200) return true;
    if (response.status === 404) return false;
    throw new Error('Community owner status is unavailable');
  } finally {
    clearTimeout(timer);
  }
}

/** Build the interactive owner handoff over the exact deployed Fly app. */
export function createDefaultCommunityOwnerDependencies(input: {
  options: CommunityServiceOptions;
  plan: LaunchPlan;
  env: Readonly<Record<string, string>>;
  persist(journal: LaunchJournal, expectedRevision: number): Promise<void>;
  now(): string;
  signal?: AbortSignal;
  platform?: NodeJS.Platform;
}): CommunityOwnerDependencies {
  return {
    persist: input.persist,
    now: input.now,
    stageBootstrap: async (secret) => {
      await stageFlySecrets(input.options.fly, input.plan.fly.appName, {
        COMMUNITY_BOOTSTRAP_SECRET: secret,
      });
    },
    deploySecrets: async () => {
      await deployFlySecrets(input.options.fly, input.plan.fly.appName);
    },
    readSecrets: () => readFlySecretInventory(input.options.fly, input.plan.fly.appName),
    verifyRuntimeAndHealth: async () => {
      verifyExistingFlyDeployment(
        await readFlyRuntimeInventory(input.options.fly, input.plan.fly.appName),
        COMMUNITY_IMAGE_REPOSITORY,
        input.plan.imageDigest
      );
      await verifyCommunityHealth(`https://${input.plan.fly.appName}.fly.dev`, {
        timeoutMs: 120_000,
        signal: input.signal,
      });
    },
    handoffSecret: async (origin, secret) => {
      if (
        (await ask(
          `Open ${origin} and copy the one-time setup secret? Type copy: `,
          input.signal
        )) !== 'copy'
      ) {
        throw new Error('Setup-secret handoff was cancelled');
      }
      const system = input.platform ?? platform();
      await openOrigin(origin, input.env, system);
      await clipboard(secret, input.env, system);
      stdout.write(
        'The setup secret is on your clipboard. Clipboard managers may retain it after DorkOS clears the current clipboard.\n'
      );
      const timer = setTimeout(
        () => void clipboard('', input.env, system).catch(() => undefined),
        30_000
      );
      timer.unref();
    },
    ownerExists,
    waitForOwnerClaim: async (origin) => {
      await ask(`Finish owner setup at ${origin}, then press Enter to verify it. `, input.signal);
      return ownerExists(origin);
    },
    confirmAcceptance: async (origin) =>
      (await ask(
        `Post one message and upload then download one private attachment at ${origin}. Type complete when both work: `,
        input.signal
      )) === 'complete',
  };
}

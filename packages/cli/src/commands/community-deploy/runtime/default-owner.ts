/**
 * Default terminal, clipboard, and Fly boundaries for Community owner handoff.
 *
 * @module commands/community-deploy/runtime/default-owner
 */
import { platform } from 'node:os';
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

async function ask(question: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('An interactive terminal is required');
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    return await prompt.question(question);
  } finally {
    prompt.close();
  }
}

async function clipboard(value: string, path: string): Promise<void> {
  const command =
    platform() === 'darwin'
      ? { executable: 'pbcopy', args: [] as string[] }
      : platform() === 'win32'
        ? { executable: 'clip.exe', args: [] as string[] }
        : { executable: 'wl-copy', args: [] as string[] };
  await runProviderCommand({
    ...command,
    env: { PATH: path },
    timeoutMs: 5_000,
    stdin: value,
    parse: () => undefined,
  });
}

async function openOrigin(origin: string, path: string): Promise<void> {
  const command =
    platform() === 'darwin'
      ? { executable: 'open', args: [origin] }
      : platform() === 'win32'
        ? { executable: 'cmd.exe', args: ['/c', 'start', '', origin] }
        : { executable: 'xdg-open', args: [origin] };
  await runProviderCommand({
    ...command,
    env: { PATH: path },
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
  path: string;
  persist(journal: LaunchJournal, expectedRevision: number): Promise<void>;
  now(): string;
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
      });
    },
    handoffSecret: async (origin, secret) => {
      if (
        (await ask(`Open ${origin} and copy the one-time setup secret? Type copy: `)) !== 'copy'
      ) {
        throw new Error('Setup-secret handoff was cancelled');
      }
      await openOrigin(origin, input.path);
      await clipboard(secret, input.path);
      stdout.write(
        'The setup secret is on your clipboard. Clipboard managers may retain it after DorkOS clears the current clipboard.\n'
      );
      const timer = setTimeout(() => void clipboard('', input.path).catch(() => undefined), 30_000);
      timer.unref();
    },
    ownerExists,
    waitForOwnerClaim: async (origin) => {
      await ask(`Finish owner setup at ${origin}, then press Enter to verify it. `);
      return ownerExists(origin);
    },
    confirmAcceptance: async (origin) =>
      (await ask(
        `Post one message and upload then download one private attachment at ${origin}. Type complete when both work: `
      )) === 'complete',
  };
}

/**
 * Machine-readable local CLI version checks for Community deployment.
 *
 * @module commands/community-deploy/runtime/versions
 */
import { z } from 'zod';
import { runProviderCommand } from '../provider-process.js';
import type { FlySessionReadOptions } from '../tigris-session.js';
import type { NeonReadOptions } from '../neon-read.js';

const VersionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
const FlyVersionSchema = z.object({ Name: z.literal('fly'), Version: VersionSchema }).passthrough();

/** Stable local-version refusal. */
export class CommunityCliVersionError extends Error {
  /** CLI whose installed version is below the signed release minimum. */
  readonly cli: 'fly' | 'neonctl';

  /** Create a version error without local paths or command output. */
  constructor(cli: CommunityCliVersionError['cli']) {
    super(`${cli} does not meet this Community release's minimum version`);
    this.name = 'CommunityCliVersionError';
    this.cli = cli;
  }
}

function compare(left: string, right: string): number {
  const tuple = (value: string) =>
    VersionSchema.parse(value).split('-', 1)[0]!.split('.').map(Number);
  const a = tuple(left);
  const b = tuple(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index]! !== b[index]!) return a[index]! - b[index]!;
  }
  return 0;
}

/** Read both installed versions and enforce the signed manifest minimums. */
export async function assertCommunityCliVersions(
  fly: FlySessionReadOptions,
  neon: NeonReadOptions,
  minimums: { fly: string; neon: string }
): Promise<void> {
  const [flyVersion, neonVersion] = await Promise.all([
    runProviderCommand({
      ...fly,
      args: ['version', '--json'],
      parse: (stdout) => FlyVersionSchema.parse(JSON.parse(stdout)).Version,
    }),
    runProviderCommand({
      ...neon,
      args: ['--version'],
      parse: (stdout) => VersionSchema.parse(stdout.trim()),
    }),
  ]);
  if (compare(flyVersion.value, minimums.fly) < 0) throw new CommunityCliVersionError('fly');
  if (compare(neonVersion.value, minimums.neon) < 0) {
    throw new CommunityCliVersionError('neonctl');
  }
}

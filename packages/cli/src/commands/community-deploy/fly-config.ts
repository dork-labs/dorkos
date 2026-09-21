/**
 * Temporary non-secret Fly configuration for immutable Community deployment.
 *
 * @module commands/community-deploy/fly-config
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LaunchPlan } from './plan.js';

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** Render the complete one-Machine Fly runtime configuration without credentials. */
export function renderCommunityFlyConfig(plan: LaunchPlan): string {
  const values = [plan.fly.appName, plan.fly.region, plan.fly.machineSize, plan.tigris.bucketName];
  if (values.some((value) => /[\0\r\n]/u.test(value))) {
    throw new Error('Community Fly configuration contains an invalid value');
  }
  const [cpuKind = 'shared', cpuCount = '1x'] = plan.fly.machineSize.split('-cpu-');
  const cpus = Number.parseInt(cpuCount, 10);
  if (!Number.isSafeInteger(cpus) || cpus < 1 || cpus > 8) {
    throw new Error('Community Fly Machine size is unsupported');
  }
  return `app = ${tomlString(plan.fly.appName)}
primary_region = ${tomlString(plan.fly.region)}
kill_signal = "SIGTERM"
kill_timeout = "30s"

[deploy]
  strategy = "rolling"

[env]
  COMMUNITY_PORT = "6481"
  COMMUNITY_PUBLIC_URL = ${tomlString(`https://${plan.fly.appName}.fly.dev`)}
  COMMUNITY_STORAGE_DRIVER = "s3"
  COMMUNITY_S3_BUCKET = ${tomlString(plan.tigris.bucketName)}
  COMMUNITY_S3_REGION = "auto"
  COMMUNITY_S3_ENDPOINT = "https://t3.storage.dev"

[http_service]
  internal_port = 6481
  force_https = true
  auto_stop_machines = "off"
  auto_start_machines = true

  [http_service.http_options]
    idle_timeout = 600

  [[http_service.checks]]
    interval = "30s"
    timeout = "5s"
    grace_period = "30s"
    method = "GET"
    path = "/health"

[[vm]]
  cpu_kind = ${tomlString(cpuKind)}
  cpus = ${cpus}
  memory = "1gb"
`;
}

/** Write a private temporary config for one bounded deploy call, then remove it. */
export async function withCommunityFlyConfig<T>(
  plan: LaunchPlan,
  consumer: (path: string) => Promise<T>
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'dorkos-community-fly-'));
  const path = join(directory, 'fly.toml');
  try {
    await writeFile(path, renderCommunityFlyConfig(plan), { mode: 0o600, flag: 'wx' });
    return await consumer(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

#!/usr/bin/env tsx
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createCommunityReleaseManifest } from '../packages/shared/src/community-release-manifest.js';

const { values } = parseArgs({
  options: {
    version: { type: 'string' },
    digest: { type: 'string' },
    index: { type: 'string' },
    output: { type: 'string' },
    migrations: { type: 'string' },
    'workflow-ref': { type: 'string' },
    'minimum-flyctl': { type: 'string' },
    'minimum-neon-cli': { type: 'string' },
  },
});

for (const name of [
  'version',
  'digest',
  'index',
  'output',
  'migrations',
  'workflow-ref',
  'minimum-flyctl',
  'minimum-neon-cli',
] as const) {
  if (!values[name]) throw new Error(`Missing --${name}`);
}

const migrationHash = createHash('sha256');
for (const filename of (await readdir(values.migrations!))
  .filter((entry) => entry.endsWith('.sql'))
  .sort()) {
  migrationHash.update(filename);
  migrationHash.update('\0');
  migrationHash.update(await readFile(join(values.migrations!, filename)));
  migrationHash.update('\0');
}
const migrationCompatibilityId = `sha256:${migrationHash.digest('hex')}`;

const index = JSON.parse(await readFile(values.index!, 'utf8')) as {
  manifests?: Array<{
    platform?: { os?: string; architecture?: string };
    annotations?: Record<string, string>;
  }>;
};
const platforms = (index.manifests ?? []).flatMap(({ platform, annotations }) => {
  const os = platform?.os ?? '';
  const architecture = platform?.architecture ?? '';
  if (os === 'unknown' && architecture === 'unknown') {
    if (annotations?.['vnd.docker.reference.type'] !== 'attestation-manifest') {
      throw new Error('OCI index contains an unexplained unknown platform');
    }
    return [];
  }
  return [{ os, architecture }];
});
const manifest = createCommunityReleaseManifest({
  dorkosVersion: values.version!,
  digest: values.digest!,
  platforms,
  migrationCompatibilityId,
  workflowRef: values['workflow-ref']!,
  minimumFlyctlVersion: values['minimum-flyctl']!,
  minimumNeonCliVersion: values['minimum-neon-cli']!,
});
await writeFile(values.output!, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });

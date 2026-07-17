/**
 * Tests for the `.dork/install-metadata.json` sidecar (read/write helpers).
 *
 * Covers the DOR-147 provenance fields (`sourceRepo`, `sourceRef`,
 * `commitSha`) round-tripping through `writeInstallMetadata` +
 * `readInstallMetadata`, and confirms that sidecars written before those
 * fields existed — and sidecars with malformed provenance values — still
 * read back cleanly with the new fields `undefined`.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  INSTALL_METADATA_PATH,
  readInstallMetadata,
  writeInstallMetadata,
  type InstallMetadata,
} from '../installed-metadata.js';

describe('install-metadata sidecar', () => {
  let installRoot: string;

  beforeEach(async () => {
    installRoot = await mkdtemp(path.join(tmpdir(), 'dorkos-install-metadata-'));
  });

  afterEach(async () => {
    await rm(installRoot, { recursive: true, force: true });
  });

  it('round-trips the DOR-147 provenance fields through write + read', async () => {
    const metadata: InstallMetadata = {
      name: 'code-reviewer',
      version: '1.2.3',
      type: 'plugin',
      installedFrom: 'dorkos-community',
      installedAt: '2026-07-16T00:00:00.000Z',
      sourceRepo: 'dork-labs/marketplace',
      sourceRef: 'main',
      commitSha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    };

    await writeInstallMetadata(installRoot, metadata);
    const read = await readInstallMetadata(installRoot);

    expect(read).toEqual(metadata);
  });

  it('omits provenance fields entirely for a local-directory install (never fabricates)', async () => {
    const metadata: InstallMetadata = {
      name: 'local-plugin',
      version: '0.1.0',
      type: 'plugin',
      installedAt: '2026-07-16T00:00:00.000Z',
    };

    await writeInstallMetadata(installRoot, metadata);
    const read = await readInstallMetadata(installRoot);

    expect(read?.sourceRepo).toBeUndefined();
    expect(read?.sourceRef).toBeUndefined();
    expect(read?.commitSha).toBeUndefined();

    // The raw JSON must not contain the keys at all — JSON.stringify drops
    // `undefined` values, so a byte-for-byte inspection confirms there is
    // no `"sourceRepo": null`-style placeholder on disk.
    const raw = await import('node:fs/promises').then((fs) =>
      fs.readFile(path.join(installRoot, INSTALL_METADATA_PATH), 'utf-8')
    );
    expect(raw).not.toContain('sourceRepo');
    expect(raw).not.toContain('sourceRef');
    expect(raw).not.toContain('commitSha');
  });

  it('tolerates a legacy sidecar written before DOR-147 (no provenance keys at all)', async () => {
    const legacyMetadataPath = path.join(installRoot, INSTALL_METADATA_PATH);
    await mkdir(path.dirname(legacyMetadataPath), { recursive: true });
    await writeFile(
      legacyMetadataPath,
      JSON.stringify(
        {
          name: 'old-plugin',
          version: '1.0.0',
          type: 'plugin',
          installedFrom: 'community',
          installedAt: '2025-01-01T00:00:00.000Z',
        },
        null,
        2
      ),
      'utf-8'
    );

    const read = await readInstallMetadata(installRoot);

    expect(read).not.toBeNull();
    expect(read?.name).toBe('old-plugin');
    expect(read?.installedFrom).toBe('community');
    expect(read?.sourceRepo).toBeUndefined();
    expect(read?.sourceRef).toBeUndefined();
    expect(read?.commitSha).toBeUndefined();
  });

  it('ignores non-string provenance values rather than throwing', async () => {
    const malformedMetadataPath = path.join(installRoot, INSTALL_METADATA_PATH);
    await mkdir(path.dirname(malformedMetadataPath), { recursive: true });
    await writeFile(
      malformedMetadataPath,
      JSON.stringify({
        name: 'weird-plugin',
        version: '1.0.0',
        type: 'plugin',
        installedAt: '2025-01-01T00:00:00.000Z',
        sourceRepo: 12345,
        sourceRef: null,
        commitSha: { not: 'a string' },
      }),
      'utf-8'
    );

    const read = await readInstallMetadata(installRoot);

    expect(read).not.toBeNull();
    expect(read?.sourceRepo).toBeUndefined();
    expect(read?.sourceRef).toBeUndefined();
    expect(read?.commitSha).toBeUndefined();
  });

  it('returns null when the sidecar is missing entirely (pre-sidecar-format installs)', async () => {
    const read = await readInstallMetadata(installRoot);
    expect(read).toBeNull();
  });
});

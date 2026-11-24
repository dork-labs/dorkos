/**
 * @vitest-environment node
 *
 * The routes a person reads before installing: a package's detail (with its
 * README) and its permission preview.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { InvalidPackageError } from '../../../services/marketplace/installer/errors.js';
import {
  InvalidPackageNameError,
  PathEscapeError,
} from '../../../services/marketplace/lib/package-paths.js';
import { UnsupportedSourceUrlError } from '../../../services/marketplace/sources/source-url-policy.js';
import {
  packageContentHash,
  ShipsRuntimeStateError,
} from '../../../services/marketplace/lib/content-hash.js';
import {
  RUNS_NOTHING,
  buildEmptyPermissionPreview,
  buildSamplePluginManifest,
  useMarketplaceRoutes,
} from './marketplace.fixtures.js';

const h = useMarketplaceRoutes();

/** Stage a package folder holding `files`, and have the installer preview it. */
function staged(files: Record<string, string> = {}): string {
  const pkgDir = mkdtempSync(join(h.dorkHome, 'staged-'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(pkgDir, name), content);
  h.installer.preview.mockResolvedValue({
    manifest: buildSamplePluginManifest(),
    preview: buildEmptyPermissionPreview(),
    packagePath: pkgDir,
  });
  return pkgDir;
}

const detail = () => h.get('/packages/sample-plugin');

describe('GET /packages/:name', () => {
  it('returns manifest, packagePath and the content hash an approval binds', async () => {
    const pkgDir = staged({ 'run.sh': 'echo hi' });

    const res = await h.get('/packages/sample-plugin?marketplace=dorkos-community');

    expect(res.status).toBe(200);
    expect(res.body.manifest.name).toBe('sample-plugin');
    expect(res.body.packagePath).toBe(pkgDir);
    // The detail sheet sends this back as `approvedContentHash` (DOR-2306).
    expect(res.body.contentHash).toBe(await packageContentHash(pkgDir));
    expect(h.installer.preview.mock.calls[0][0]).toEqual({
      name: 'sample-plugin',
      marketplace: 'dorkos-community',
    });
  });

  it('includes the README markdown when the staged package ships one (case-insensitive)', async () => {
    const body = '# Linear Ops\n\nCreate and update Linear issues from chat.';
    staged({ 'readme.md': body });

    const res = await detail();

    expect(res.status).toBe(200);
    expect(res.body.readme).toBe(body);
  });

  it('omits the README field when the staged package has none', async () => {
    staged();
    const res = await detail();
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('readme');
  });

  it('truncates an oversized README to the 200 KB byte cap', async () => {
    staged({ 'README.md': 'a'.repeat(250 * 1024) });
    const res = await detail();
    expect(Buffer.byteLength(res.body.readme, 'utf8')).toBe(200 * 1024);
  });

  it('does not split a multibyte character at the truncation boundary', async () => {
    // 'é' is 2 UTF-8 bytes; the leading ASCII byte puts the 200 KB cap exactly
    // between an é's lead and continuation byte.
    staged({ 'README.md': 'a' + 'é'.repeat(150 * 1024) });

    const readme: string = (await detail()).body.readme;

    expect(readme).not.toContain('�');
    expect(readme.endsWith('é')).toBe(true);
    expect(Buffer.byteLength(readme, 'utf8')).toBe(200 * 1024 - 1);
  });

  it('treats a symlinked README as absent instead of following it', async () => {
    // Clones preserve symlinks: a package could commit README.md as a link to
    // a sensitive file outside the clone and read it out at detail-view time.
    const pkgDir = staged();
    const secretPath = join(h.dorkHome, 'outside-secret.txt');
    writeFileSync(secretPath, 'provider-token: hunter2');
    symlinkSync(secretPath, join(pkgDir, 'README.md'));

    const res = await detail();

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('readme');
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
  });

  it('returns 400 when installer.preview throws InvalidPackageError', async () => {
    h.installer.preview.mockRejectedValue(new InvalidPackageError(['bad manifest']));
    const res = await h.get('/packages/broken');
    expect(res.status).toBe(400);
    expect(res.body.errors).toEqual(['bad manifest']);
  });

  it('returns 400 when the installer refuses the marketplace address (DOR-1710)', async () => {
    // A preview runs before any consent, so this is the ungated way in for an
    // address that reached `marketplaces.json` some other way.
    h.installer.preview.mockRejectedValue(
      new UnsupportedSourceUrlError("ext::sh -c 'id > /tmp/pwned'")
    );

    const res = await detail();

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/isn't one DorkOS can fetch a marketplace from/);
    // The hostile address is never echoed back to the caller.
    expect(JSON.stringify(res.body)).not.toContain('ext::');
  });
});

describe('POST /packages/:name/preview', () => {
  const preview = (body: object = {}) => h.post('/packages/sample-plugin/preview', body);

  it('returns the preview, and what an install is held to', async () => {
    const pkgDir = staged({ 'run.sh': 'echo hi' });

    const res = await preview({ marketplace: 'dorkos-community' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('preview');
    expect(res.body).toHaveProperty('manifest');
    expect(res.body.packagePath).toBe(pkgDir);
    // In the canonical form the caller sends back.
    expect(res.body.disclosed).toEqual(RUNS_NOTHING);
    expect(res.body.contentHash).toBe(await packageContentHash(pkgDir));
    expect(h.installer.preview.mock.calls[0][0]).toEqual({
      name: 'sample-plugin',
      marketplace: 'dorkos-community',
    });
  });

  it('returns 400 when the body is invalid', async () => {
    const res = await preview({ force: 'not-a-boolean' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_request');
  });

  it('refuses a package that ships DorkOS runtime state with a 400 naming the path (DOR-2306)', async () => {
    h.installer.preview.mockRejectedValue(new ShipsRuntimeStateError('.dork/secrets.json'));
    const res = await preview();
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('.dork/secrets.json');
  });

  it('refuses an escaped path without telling the caller where the cache lives', async () => {
    // The containment message names the cache root, which spells the
    // operator's username.
    h.installer.preview.mockRejectedValue(
      new PathEscapeError('/Users/realperson/.dork/cache/marketplace/packages', 'evil')
    );

    const res = await preview();

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('realperson');
    expect(JSON.stringify(res.body)).not.toContain('.dork');
  });

  it('names the rejected package name, which the caller supplied itself', async () => {
    h.installer.preview.mockRejectedValue(new InvalidPackageNameError('Bad Name', 'must be kebab'));
    const res = await preview();
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Bad Name');
  });

  it('returns 403 and never previews when projectPath is outside the boundary', async () => {
    // Preview is not tier-gated, and it reads: an unbounded preview would
    // answer "does this directory exist, and what is in it" for any path.
    const res = await preview({ projectPath: '/etc/evil' });

    expect(res.status).toBe(403);
    expect(h.installer.preview).not.toHaveBeenCalled();
  });
});

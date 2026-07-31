/**
 * Project-slug parity with the Claude Agent SDK (DOR-782).
 *
 * A session's transcript lives at `{claudeRoot}/projects/{slug}/`, where the
 * SDK computes `slug` from the working directory. DorkOS has to compute the
 * SAME string or it reads an empty directory and silently cold-starts a session
 * that already exists. These pin each clause of the SDK's algorithm, read from
 * the shipped bundle at 0.3.177 (`sdk.mjs`: `So`/`My`/`a6`, `Di = 200`):
 *
 *   slug(cwd) = replaceNonAlnum(NFC(realpath(resolve(cwd))))
 *   ...truncated to 200 chars + '-' + base36(|hash|) past that,
 *   where hash is `h = (h << 5) - h + charCodeAt(i) | 0` seeded at 0 over the
 *   CANONICAL PATH, not over the replaced string.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, symlink, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { projectSlug, slugForCanonicalPath, canonicalizeCwd } from '../project-slug.js';

describe('slugForCanonicalPath', () => {
  it('replaces every non-alphanumeric character with a dash', () => {
    expect(slugForCanonicalPath('/Users/foo/my-vault')).toBe('-Users-foo-my-vault');
    expect(slugForCanonicalPath('/Users/foo/Obsidian Repo')).toBe('-Users-foo-Obsidian-Repo');
    expect(slugForCanonicalPath('/Users/foo/.Trash/project')).toBe('-Users-foo--Trash-project');
    expect(slugForCanonicalPath('/Users/foo/my project (v2)')).toBe('-Users-foo-my-project--v2-');
  });

  it('leaves a 200-character slug untruncated (the boundary is inclusive)', () => {
    const exactly200 = `/${'a'.repeat(199)}`;
    const slug = slugForCanonicalPath(exactly200);
    expect(slug).toHaveLength(200);
    expect(slug).not.toContain('--');
  });

  it('truncates past 200 and appends the base36 hash of the ORIGINAL path', () => {
    // Byte-identical fixture, recovered by brute-forcing the three characters
    // truncation ate: this exact path is the one the CLI named
    // `…-6a3df6eb6-4meh5z` on disk (a real directory under
    // ~/Library/Caches/claude-cli-nodejs, which the CLI names with this same
    // function). It pins WHICH string is hashed, not merely that a hash is
    // appended — hashing the REPLACED string gives `igdoys` and the TRUNCATED
    // replaced string gives `c2cipb`, both of which would point nowhere.
    const original =
      '/private/tmp/claude-501/-Users-doriancollier-Keep-dork-os-dorkos/8f471865-b48d-40bd-ae62-4c177a6ff269/scratchpad/rv669/apps/e2e/.temp/fixtures/run-3e0bd670/room-agent-9f272b2e-4a04-4ea4-9e21-6a3df6eb6f5b';

    const slug = slugForCanonicalPath(original);
    expect(slug).toHaveLength(207);
    expect(slug).toBe(
      '-private-tmp-claude-501--Users-doriancollier-Keep-dork-os-dorkos-8f471865-b48d-40bd-ae62-4c177a6ff269-scratchpad-rv669-apps-e2e--temp-fixtures-run-3e0bd670-room-agent-9f272b2e-4a04-4ea4-9e21-6a3df6eb6-4meh5z'
    );
  });

  it('replaces a precomposed accent whole, leaving no base letter behind', () => {
    // Why the normalization form changes the ANSWER, not just the bytes: NFC's
    // single `é` is one non-alphanumeric character, so the slug keeps `caf`.
    // NFD is `e` + a combining accent, so the base letter survives the character
    // class and the slug keeps `cafe`. Two different directories.
    expect(slugForCanonicalPath('/Users/f/café'.normalize('NFC'))).toBe('-Users-f-caf-');
    expect(slugForCanonicalPath('/Users/f/café'.normalize('NFD'))).toBe('-Users-f-cafe-');
  });
});

describe('canonicalizeCwd', () => {
  let root: string;
  let realDir: string;
  let linkDir: string;

  beforeAll(async () => {
    // realpath() the tmp root itself: macOS /tmp is a symlink to /private/tmp,
    // which is precisely the divergence under test — the fixture must not
    // accidentally encode it.
    root = await mkdtemp(path.join(tmpdir(), 'slug-'));
    realDir = path.join(root, 'real-project');
    linkDir = path.join(root, 'linked-project');
    await mkdir(realDir, { recursive: true });
    await symlink(realDir, linkDir, 'dir');
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('resolves a symlinked working directory to its real path', () => {
    // The failure this closes: an agent run from a symlinked checkout wrote its
    // transcript under the REAL path's slug, while DorkOS looked under the
    // link's — an empty directory, so the session silently cold-started.
    expect(canonicalizeCwd(linkDir)).toBe(canonicalizeCwd(realDir));
    expect(projectSlug(linkDir)).toBe(projectSlug(realDir));
    expect(canonicalizeCwd(linkDir)).not.toBe(linkDir);
  });

  it('falls back to the resolved path when the directory is gone', () => {
    // A deleted (or not-yet-created) cwd must still produce the slug the SDK
    // would produce, not throw: the SDK swallows the realpath failure the same way.
    const missing = path.join(root, 'never-existed');
    expect(canonicalizeCwd(missing)).toBe(path.resolve(missing));
    expect(projectSlug(missing)).toBe(slugForCanonicalPath(path.resolve(missing)));
  });

  it('resolves a relative path against the process cwd', () => {
    expect(canonicalizeCwd('.')).toBe(canonicalizeCwd(process.cwd()));
  });

  it('folds decomposed Unicode to NFC on macOS ONLY, matching the SDK gate', () => {
    // The SDK gates this on `process.platform === "darwin"` because HFS+/APFS
    // hand back decomposed names. Normalizing everywhere would rewrite a path
    // the SDK leaves alone, so parity means mirroring the gate, not the intent.
    const decomposed = path.join(root, 'cafe\u0301');
    const canonical = canonicalizeCwd(decomposed);
    if (process.platform === 'darwin') {
      expect(canonical).toBe(path.resolve(decomposed).normalize('NFC'));
      expect(canonical.normalize('NFD')).not.toBe(canonical);
    } else {
      expect(canonical).toBe(path.resolve(decomposed));
    }
  });
});

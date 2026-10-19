/**
 * The space server's code runs against two installs of its packages (server-merge step 7): the
 * DorkOS server's, in its unit tests and local builds, and the space package's, in the image.
 * They must be the same versions, or the image ships a version no test ran.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { SPACE_ROOT } from './space-paths.js';

const fromServer = createRequire(new URL('../../../../package.json', import.meta.url));
const fromImage = createRequire(new URL('package.json', SPACE_ROOT));
const imagePackages = Object.keys(
  (
    JSON.parse(readFileSync(new URL('package.json', SPACE_ROOT), 'utf8')) as {
      dependencies: Record<string, string>;
    }
  ).dependencies
);

/**
 * The installed version of a package, as one install resolves it, or null when it has none.
 * Found from the package's entry, since not every package lets `package.json` be resolved.
 */
function versionIn(require: NodeJS.Require, name: string): string | null {
  let entry: string;
  try {
    entry = require.resolve(name);
  } catch {
    return null;
  }
  for (let dir = dirname(entry); dir !== dirname(dir); dir = dirname(dir)) {
    const manifest = join(dir, 'package.json');
    if (!existsSync(manifest)) continue;
    const json = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string; version: string };
    if (json.name === name) return json.version;
  }
  return null;
}

describe("the space server's packages", () => {
  it('resolve to the same versions for the tests and for the image', () => {
    // Purpose: fails if a bump in one package.json (a Dependabot PR to apps/community alone,
    // say) leaves the image running a version the server's tests never ran.
    const shared = imagePackages.filter((name) => versionIn(fromServer, name) !== null);
    expect(shared.length).toBeGreaterThan(8);
    const drift = shared
      .map((name) => ({
        name,
        server: versionIn(fromServer, name),
        image: versionIn(fromImage, name),
      }))
      .filter(({ server, image }) => server !== image);
    expect(drift).toEqual([]);
  });

  it('are all installed for the tests', () => {
    // Purpose: fails if the space server imports a package the DorkOS server package does not
    // install, so its unit tests would resolve something else or nothing.
    for (const name of ['pg', '@aws-sdk/client-s3', 'nodemailer', 'fflate', 'drizzle-orm', 'hono'])
      expect(versionIn(fromServer, name), name).not.toBeNull();
  });
});

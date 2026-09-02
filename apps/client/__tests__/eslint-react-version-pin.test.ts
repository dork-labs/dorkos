import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ESLint } from 'eslint';
import { describe, it, expect } from 'vitest';

/**
 * Guards the `settings.react.version` pins that keep ESLint 10 working (DOR-169).
 *
 * eslint-plugin-react's `'detect'` resolves the React version through
 * `context.getFilename()`, which ESLint 10 removed, so `detect` crashes the whole
 * lint run before a single file is reported. Both React-linting configs therefore
 * pin the version by hand — `packages/eslint-config/react.js` for the client, and
 * `apps/site/eslint.config.mjs` for the site, which gets the plugin via
 * `eslint-config-next` instead.
 *
 * A hand-pinned version rots silently, and in the worst direction: the pin stays
 * green forever while the plugin quietly applies an older React's rule set. So the
 * pin is checked against the React each app actually depends on.
 *
 * This asks ESLint for its RESOLVED config rather than reading the config files as
 * text. A regex over the source would pass while the setting was overridden by a
 * later config object, moved to a block that does not match the files being
 * linted, or dropped in favour of the plugin's `detect` default — all of which are
 * exactly the failures worth catching, and none of which change the source line a
 * regex would find.
 */
const REPO_ROOT = resolve(__dirname, '../../..');

/** One app whose flat config must carry a React version pin. */
interface PinnedApp {
  /** Label used in test names. */
  name: string;
  /** Directory ESLint runs from, i.e. the one holding the flat config. */
  cwd: string;
  /** A real linted file in that app, so the resolved config is the live one. */
  sampleFile: string;
  /** Where the `react` dependency version is declared. */
  packageJson: string;
}

const APPS: PinnedApp[] = [
  {
    name: 'apps/client',
    cwd: resolve(REPO_ROOT, 'apps/client'),
    sampleFile: resolve(REPO_ROOT, 'apps/client/src/main.tsx'),
    packageJson: resolve(REPO_ROOT, 'apps/client/package.json'),
  },
  {
    name: 'apps/site',
    cwd: resolve(REPO_ROOT, 'apps/site'),
    sampleFile: resolve(REPO_ROOT, 'apps/site/src/lib/rate-limit/fixed-window.ts'),
    packageJson: resolve(REPO_ROOT, 'apps/site/package.json'),
  },
];

/** `^19.2.8` / `19.2.8` / `~19.2.8` -> `19.2`. */
function majorMinor(range: string): string {
  const match = /(\d+)\.(\d+)/.exec(range);
  if (!match) throw new Error(`Cannot read a major.minor out of React range "${range}"`);
  return `${match[1]}.${match[2]}`;
}

/** The `react` version an app depends on, as `major.minor`. */
function declaredReactVersion(packageJsonPath: string): string {
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const range = pkg.dependencies?.react ?? pkg.devDependencies?.react;
  if (!range) throw new Error(`No react dependency declared in ${packageJsonPath}`);
  return majorMinor(range);
}

/** The `settings.react.version` ESLint actually resolves for a file. */
async function resolvedReactSetting(app: PinnedApp): Promise<unknown> {
  const eslint = new ESLint({ cwd: app.cwd });
  const config = (await eslint.calculateConfigForFile(app.sampleFile)) as {
    settings?: { react?: { version?: unknown } };
  };
  return config.settings?.react?.version;
}

describe('eslint react version pin', () => {
  for (const app of APPS) {
    it(`${app.name} pins an explicit React version, never 'detect'`, async () => {
      const version = await resolvedReactSetting(app);

      // `detect` is the specific value that crashes ESLint 10, and `undefined`
      // means the plugin falls back to detect on its own — both are the bug.
      expect(version).toBeDefined();
      expect(version).not.toBe('detect');
      expect(typeof version).toBe('string');
    });

    it(`${app.name} pins the React major.minor it actually depends on`, async () => {
      const pinned = await resolvedReactSetting(app);
      const declared = declaredReactVersion(app.packageJson);

      // The drift check. Bump React's minor without touching the eslint config
      // and this is what goes red, instead of the rule set silently staying put.
      expect(pinned).toBe(declared);
    });
  }

  it('keeps both apps on the same pin, since one shared plugin reads it', async () => {
    const [client, site] = await Promise.all(APPS.map(resolvedReactSetting));

    expect(client).toBe(site);
  });
});

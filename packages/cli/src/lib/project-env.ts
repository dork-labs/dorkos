/**
 * The optional `.env` file in the folder DorkOS starts in.
 *
 * The project `.env` file can't change how DorkOS or its agents run: set what
 * they need in the environment DorkOS starts in. Only the settings
 * `PROJECT_ENV_ALLOWED` names (`@dorkos/shared/project-environment`) are read
 * from it, and only when the real environment left them unset. They are held
 * in memory and handed to the server; no project value enters `process.env`,
 * so no child process DorkOS starts ever sees one. A name DorkOS itself reads
 * is named once, without its value, so a person who meant to set it knows.
 *
 * @module lib/project-env
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'dotenv';
import {
  SYSTEM_NAMES_DORKOS_READS,
  handProjectSettings,
  isDorkosOwnedEnvName,
  isProjectSettingName,
  type ProjectSettingName,
  type ProjectSettings,
} from '@dorkos/shared/project-environment';

/**
 * Read a project's `.env`, keep its allowed settings, and hand them to the
 * server this process is about to import. Reads `realEnv`, never writes it.
 *
 * @param dir - The folder DorkOS starts in; its `.env` is read, and a missing one gives nothing.
 * @param warn - Told once, by name only, about names DorkOS reads that the file can't set.
 * @param realEnv - The environment DorkOS started in; a setting it already has wins.
 * @returns The allowed settings the file gave, frozen.
 */
export function loadProjectEnv(
  dir: string,
  warn: (message: string) => void,
  // eslint-disable-next-line no-restricted-syntax -- read only: a setting the real environment already has wins
  realEnv: Readonly<Record<string, string | undefined>> = process.env
): ProjectSettings {
  const envPath = path.join(dir, '.env');
  const settings: Partial<Record<ProjectSettingName, string>> = {};
  const ignored: string[] = [];
  let authSecretDigest: string | undefined;
  if (fs.existsSync(envPath)) {
    for (const [key, value] of Object.entries(parse(fs.readFileSync(envPath)))) {
      if (isProjectSettingName(key)) {
        if (realEnv[key] === undefined) settings[key] = value;
      } else if (isDorkosOwnedEnvName(key) || SYSTEM_NAMES_DORKOS_READS.has(key)) {
        ignored.push(key);
        // Before this release a session secret here signed sign-ins. The server
        // gets its digest, never the value, to retire a stored copy of it.
        if (key === 'BETTER_AUTH_SECRET' && value.trim() && !realEnv[key]?.trim())
          authSecretDigest = createHash('sha256').update(value.trim()).digest('hex');
      }
    }
  }
  if (ignored.length > 0) {
    warn(
      `[DorkOS] Ignored ${ignored.join(', ')} in the project .env: the project .env file ` +
        "can't change how DorkOS or its agents run. Set what they need in the environment " +
        'DorkOS starts in.'
    );
  }
  const frozen = Object.freeze(settings);
  handProjectSettings({ settings: frozen, ...(authSecretDigest ? { authSecretDigest } : {}) });
  return frozen;
}

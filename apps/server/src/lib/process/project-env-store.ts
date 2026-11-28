/**
 * The project `.env` file's allowed settings, as the CLI handed them over in
 * memory. Never in `process.env`, behind no route and no tool, never logged.
 * Empty when DorkOS was not started by the CLI (the desktop app, `pnpm dev`).
 *
 * Read when first asked after the CLI left it, not at load: the CLI imports
 * server modules (its config store) before it reads the project `.env`, and
 * in a single module graph this module loads then.
 *
 * @module lib/process/project-env-store
 */
import {
  readProjectSettings,
  type ProjectHandoff,
  type ProjectSettingName,
} from '@dorkos/shared/project-environment';

let taken: ProjectHandoff | undefined;

function handoff(): ProjectHandoff | undefined {
  taken ??= readProjectSettings();
  return taken;
}

/**
 * One allowed setting from the project `.env`, for the server's own reading.
 *
 * @param name - `LOG_LEVEL` or `DO_NOT_TRACK`.
 * @returns The value, or `undefined` when the file did not set it.
 */
export function projectSetting(name: ProjectSettingName): string | undefined {
  return handoff()?.settings[name];
}

/**
 * The SHA-256 (hex) of the session secret the project `.env` gave when the
 * real environment had none, so sign-ins were signed with it before this
 * release; `undefined` otherwise. Never the value. Read by
 * `services/core/auth/secret.ts`.
 */
export function projectAuthSecretDigest(): string | undefined {
  return handoff()?.authSecretDigest;
}

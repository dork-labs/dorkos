/**
 * The project `.env` file's allowed settings, as the CLI handed them over in
 * memory. Never in `process.env`, behind no route and no tool, never logged.
 * Empty when DorkOS was not started by the CLI (the desktop app, `pnpm dev`).
 *
 * @module lib/process/project-env-store
 */
import { takeProjectSettings, type ProjectSettingName } from '@dorkos/shared/project-environment';

/** Taken once, when this module first loads. */
const settings = takeProjectSettings();

/**
 * One allowed setting from the project `.env`, for the server's own reading.
 *
 * @param name - `LOG_LEVEL` or `DO_NOT_TRACK`.
 * @returns The value, or `undefined` when the file did not set it.
 */
export function projectSetting(name: ProjectSettingName): string | undefined {
  return settings[name];
}

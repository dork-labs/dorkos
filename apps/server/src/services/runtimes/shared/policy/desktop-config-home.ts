/** Resolve Electron's Linux app-data root without accepting a relative XDG path. */
import path from 'node:path';

/**
 * The desktop app's data root when Linux has moved it out of the home folder: an absolute
 * `$XDG_CONFIG_HOME`, which Electron reads the same way (DOR-4139). `undefined` everywhere
 * else, where the data sits under `~/.config` and the home-folder rules already cover it.
 *
 * @param env - The environment to read `XDG_CONFIG_HOME` from.
 * @param platform - The platform the server runs on.
 * @returns The moved config root, or `undefined` when it is not moved.
 */
export function movedDesktopConfigHome(
  // eslint-disable-next-line no-restricted-syntax -- XDG_CONFIG_HOME is another program's setting, not a DorkOS env var
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  const configured = env.XDG_CONFIG_HOME;
  return platform === 'linux' && configured && path.isAbsolute(configured) ? configured : undefined;
}

/**
 * Where the desktop app keeps its data on this machine: the moved Linux root when there is
 * one (see {@link movedDesktopConfigHome}), else `~/.config`.
 *
 * @param home - The person's home folder.
 * @param env - The environment to read `XDG_CONFIG_HOME` from.
 * @param platform - The platform the server runs on.
 * @returns The desktop config root.
 */
export function desktopConfigHome(
  home: string,
  // eslint-disable-next-line no-restricted-syntax -- XDG_CONFIG_HOME is another program's setting, not a DorkOS env var
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  return movedDesktopConfigHome(env, platform) ?? path.join(home, '.config');
}

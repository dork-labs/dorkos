import { existsSync, readdirSync } from 'fs';
import path from 'path';

/**
 * The helper binary Electron's utility processes run on, inside a `.app`.
 *
 * @param appPath - The packaged `.app` bundle.
 * @throws If the bundle has no helper app.
 */
export function helperBinary(appPath: string): string {
  const name = path.basename(appPath, '.app');
  const frameworks = path.join(appPath, 'Contents', 'Frameworks');
  const exact = path.join(frameworks, `${name} Helper.app`, 'Contents', 'MacOS', `${name} Helper`);
  if (existsSync(exact)) return exact;
  const found = readdirSync(frameworks).find((entry) => /^.+ Helper\.app$/.test(entry));
  if (!found) throw new Error(`No helper app under ${frameworks}.`);
  return path.join(frameworks, found, 'Contents', 'MacOS', found.replace(/\.app$/, ''));
}

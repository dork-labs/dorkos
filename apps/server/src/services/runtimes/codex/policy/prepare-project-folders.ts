/** Prepare only folder-shaped mount parents owned by this project or active agent. */
import fs from 'node:fs';
import path from 'node:path';
import type { CodexFilePolicy } from './protected-profile.js';

/** Existing entries are never replaced; linked paths refuse without following them. */
export function prepareProjectFolders({ roots }: CodexFilePolicy): void {
  const person = fs.realpathSync(roots.home);
  for (const parent of new Set([roots.cwd, ...roots.agentFolders])) {
    // Match M1: the exact parent must already be canonical before any mutation.
    if (
      parent === path.parse(parent).root ||
      path.normalize(parent) !== parent ||
      fs.realpathSync(parent) !== parent
    )
      throw new Error('Codex needs a folder without links. Choose another folder, then retry.');
    if (parent === person) continue;
    for (const name of ['.claude', '.dork']) {
      const target = path.join(parent, name);
      try {
        if (fs.lstatSync(target).isSymbolicLink())
          throw new Error(
            'Codex cannot protect a linked folder. Choose another folder, then retry.'
          );
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (fs.realpathSync(parent) !== parent)
        throw new Error('Codex needs a folder without links. Choose another folder, then retry.');
      try {
        fs.mkdirSync(target); // Exact path, non-recursive; never follows an existing leaf link.
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      // A concurrent replacement may not turn the next render into a linked launch.
      if (fs.realpathSync(parent) !== parent || fs.lstatSync(target).isSymbolicLink())
        throw new Error('Codex cannot protect a linked folder. Choose another folder, then retry.');
    }
  }
}

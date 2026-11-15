import fs from 'node:fs';
import path from 'node:path';
import { env } from '../../../../env.js';
import { realAccountDorkHome } from '../../../../lib/dork-home.js';
import { currentReplayHome, REPLAY_HOME_MARKER } from '../../../../lib/replay/isolation.js';

/** Pinned identity of a marked demo home; checked at boot and every recorded turn. */
export class ReplayHome {
  private readonly identity: string;
  readonly root: string;

  constructor(dorkHome: string) {
    if (!env.DORKOS_TEST_RUNTIME) throw new Error('Recorded demo needs the test runtime.');
    this.root = fs.realpathSync(dorkHome);
    const production = realAccountDorkHome();
    let realProduction = path.resolve(production);
    try {
      realProduction = fs.realpathSync(production);
    } catch {
      /* It may not exist yet. */
    }
    const relative = path.relative(realProduction, this.root);
    if (
      relative === '' ||
      (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
    ) {
      throw new Error('Recorded demo cannot use the real DorkOS folder.');
    }
    this.identity = this.readIdentity();
    this.assertCurrent();
  }

  /** Refuse missing/replaced/linked markers and a home changed since construction. */
  assertCurrent(): void {
    if (
      !env.DORKOS_TEST_RUNTIME ||
      fs.realpathSync(currentReplayHome()) !== this.root ||
      this.readIdentity() !== this.identity
    ) {
      throw new Error('Recorded demo folder changed. Restart the demo.');
    }
  }

  /** Read a regular file inside the demo home, with a hard allocation bound. */
  readRecording(relativePath: string, maxBytes: number): string {
    this.assertCurrent();
    if (path.isAbsolute(relativePath))
      throw new Error('Recording needs a path inside the demo folder.');
    const file = fs.realpathSync(path.resolve(this.root, relativePath));
    const relative = path.relative(this.root, file);
    if (
      relative === '' ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error('Recording must stay inside the demo folder.');
    }
    const fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
    );
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > maxBytes)
        throw new Error('Recording is too large or not a file.');
      const openedPath = fs.realpathSync(file);
      const openedRelative = path.relative(this.root, openedPath);
      if (
        openedRelative === '..' ||
        openedRelative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(openedRelative)
      ) {
        throw new Error('Recording must stay inside the demo folder.');
      }
      const current = fs.statSync(openedPath);
      if (current.dev !== stat.dev || current.ino !== stat.ino)
        throw new Error('Recording changed. Restart the demo.');
      // A bounded read also covers a file growing after fstat.
      const bytes = Buffer.alloc(maxBytes + 1);
      const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
      if (count > maxBytes) throw new Error('Recording is too large.');
      this.assertCurrent();
      return bytes.toString('utf8', 0, count);
    } finally {
      fs.closeSync(fd);
    }
  }

  private readIdentity(): string {
    const home = fs.statSync(this.root);
    const marker = fs.lstatSync(path.join(this.root, REPLAY_HOME_MARKER));
    if (!marker.isFile() || marker.isSymbolicLink())
      throw new Error('Recorded demo marker is missing or linked.');
    return `${home.dev}:${home.ino}:${marker.dev}:${marker.ino}`;
  }
}

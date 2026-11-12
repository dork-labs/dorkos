/** Synthetic filesystem for the CI-only real-binary protection probe. */
import fs from 'node:fs';
import path from 'node:path';

/** Read host metadata after failed launches as well as successful turns. */
export function probeParentKinds(homes: readonly string[]) {
  return [...new Set(homes)].flatMap((home) =>
    ['.claude', '.dork', '.config', '.docker'].map((name) => {
      const file = path.join(home, name);
      try {
        const stat = fs.lstatSync(file);
        return {
          file,
          kind: stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'file',
        };
      } catch (error) {
        return {
          file,
          kind: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : String(error),
        };
      }
    })
  );
}

/** A printed command in history is not proof that a shell returned its marker. */
export function shellControlReturned(body: string, marker: string): boolean {
  const request = JSON.parse(body) as {
    input?: { type?: string; output?: unknown }[];
  };
  return (
    request.input?.some(
      (item) =>
        item.type === 'function_call_output' &&
        typeof item.output === 'string' &&
        item.output.includes(marker)
    ) ?? false
  );
}

export function protectedProbe(
  root: string,
  project: string,
  size = { homeFiles: 10_000, cwdFiles: 0 },
  selfGrantProbe = false,
  otherHome?: string
) {
  const home = path.join(root, 'home');
  const sibling = path.join(home, 'sibling-project');
  const plugins = path.join(sibling, '.dork', 'plugins', 'existing');
  const large = path.join(home, 'large-tree');
  // Distinct leaf names keep these canaries distinct on case-insensitive disks too.
  const desktopFiles = [
    path.join(
      home,
      'Library',
      'Application Support',
      'DorkOS',
      'Local Storage',
      'leveldb',
      '000003-space.log'
    ),
    path.join(
      home,
      'library',
      'application support',
      'dorkos',
      'local storage',
      'leveldb',
      '000004-lowercase.log'
    ),
  ];
  const secrets = [
    path.join(project, '.credentials-cwd'),
    path.join(home, '.claude.json'),
    path.join(root, 'data', 'config.json'),
    path.join(sibling, '.credentials-sibling'),
    ...desktopFiles,
  ];
  const lateSecret = path.join(sibling, '.credentials-midturn');
  const plugin = path.join(plugins, 'plugin.js');
  const latePlugin = path.join(plugins, 'late.js');
  const gitDirectory = path.join(project, '.git');
  const madeGitDirectory = !fs.existsSync(gitDirectory);
  const gitWrite = path.join(gitDirectory, 'dor3595-write-control');
  fs.mkdirSync(gitDirectory, { recursive: true });
  const canaries = secrets.map((_, index) => `CANARY-dor3595-${index}`);
  const lateCanary = 'CANARY-dor3595-midturn';
  for (const [index, file] of secrets.entries()) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, canaries[index]!);
  }
  fs.mkdirSync(plugins, { recursive: true });
  fs.writeFileSync(plugin, 'original-plugin');
  const cwdLarge = path.join(project, 'probe-large-tree');
  const modules = path.join(project, 'node_modules', 'probe-large-tree');
  const populate = (base: string, count: number) => {
    for (let index = 0; index < count; index++) {
      const folder = path.join(base, String(Math.floor(index / 100)));
      if (index % 100 === 0) fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, `${index}.txt`), '');
    }
  };
  populate(large, size.homeFiles);
  populate(cwdLarge, size.cwdFiles / 10);
  populate(modules, (size.cwdFiles * 9) / 10);
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const selfGrantTargets = [
    'settings.json',
    'settings.local.json',
    'skills',
    'commands',
    'agents',
  ].map((name) => path.join(project, '.claude', name));
  const grantHomes = [
    ...new Set([home, ...(selfGrantProbe ? [project] : []), ...(otherHome ? [otherHome] : [])]),
  ];
  const grantTargets = grantHomes.flatMap((base) =>
    ['settings.json', 'skills'].map((name) => path.join(base, '.claude', name))
  );
  const attemptMarkers = grantHomes.map((_, index) => `PUBLIC-self-grant-attempt-${index}`);
  return {
    desktopCases: desktopFiles.map((file) => ({ file, canary: canaries[secrets.indexOf(file)]! })),
    grantTargets,
    attemptMarkers,
    canaries: [...canaries, lateCanary],
    lateCanary,
    plugin,
    latePlugin,
    gitWrite,
    selfGrantTargets,
    command: [
      `printf changed-by-full-probe > ${quote(gitWrite)}`,
      ...grantHomes.flatMap((base, index) => [
        `printf '${attemptMarkers[index]}\n'`,
        // Attempt the absent parent too: ENOENT alone is not a refusal proof.
        `mkdir -p ${quote(path.join(base, '.claude'))}`,
        `printf changed > ${quote(path.join(base, '.claude', 'settings.json'))}`,
        `mkdir -p ${quote(path.join(base, '.claude', 'skills'))}`,
      ]),
      ...(selfGrantProbe
        ? selfGrantTargets.map((file, index) =>
            index < 2 ? `printf changed > ${quote(file)}` : `mkdir -p ${quote(file)}`
          )
        : []),
      ...[...secrets, lateSecret].map((file) => `cat ${quote(file)}`),
      ...[plugin, latePlugin].map((file) => `echo changed > ${quote(file)}`),
      'cat readable.txt',
      `cat ${quote(path.join(root, 'data', 'agents', 'probe', '.agents', 'skills', 'probe', 'SKILL.md'))}`,
    ].join('; '),
    resetLate() {
      fs.writeFileSync(gitWrite, 'original-git-control');
      fs.rmSync(lateSecret, { force: true });
      fs.rmSync(latePlugin, { force: true });
    },
    createLate() {
      fs.writeFileSync(lateSecret, lateCanary);
      fs.writeFileSync(latePlugin, 'original-late-plugin');
    },
    cleanup() {
      for (const file of secrets) fs.rmSync(file, { force: true });
      fs.rmSync(sibling, { recursive: true, force: true });
      fs.rmSync(large, { recursive: true, force: true });
      fs.rmSync(cwdLarge, { recursive: true, force: true });
      fs.rmSync(modules, { recursive: true, force: true });
      fs.rmSync(gitWrite, { force: true });
      if (madeGitDirectory) fs.rmSync(gitDirectory, { recursive: true, force: true });
    },
  };
}

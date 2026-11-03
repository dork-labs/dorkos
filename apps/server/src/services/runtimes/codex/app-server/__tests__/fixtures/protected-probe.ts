/** Synthetic filesystem for the CI-only real-binary protection probe. */
import fs from 'node:fs';
import path from 'node:path';

export function protectedProbe(root: string, project: string) {
  const home = path.join(root, 'home');
  const sibling = path.join(home, 'sibling-project');
  const plugins = path.join(sibling, '.dork', 'plugins', 'existing');
  const large = path.join(home, 'large-tree');
  const secrets = [
    path.join(project, '.credentials-cwd'),
    path.join(home, '.claude.json'),
    path.join(root, 'data', 'config.json'),
    path.join(sibling, '.credentials-sibling'),
  ];
  const lateSecret = path.join(sibling, '.credentials-midturn');
  const plugin = path.join(plugins, 'plugin.js');
  const latePlugin = path.join(plugins, 'late.js');
  const canaries = secrets.map((_, index) => `CANARY-dor3595-${index}`);
  const lateCanary = 'CANARY-dor3595-midturn';
  for (const [index, file] of secrets.entries()) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, canaries[index]!);
  }
  fs.mkdirSync(plugins, { recursive: true });
  fs.writeFileSync(plugin, 'original-plugin');
  // Measure thread start with 10,000 ordinary files below the home prefix.
  for (let dir = 0; dir < 100; dir++) {
    const folder = path.join(large, String(dir));
    fs.mkdirSync(folder, { recursive: true });
    for (let file = 0; file < 100; file++) fs.writeFileSync(path.join(folder, `${file}.txt`), '');
  }
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return {
    canaries: [...canaries, lateCanary],
    lateCanary,
    plugin,
    latePlugin,
    command: [
      ...[...secrets, lateSecret].map((file) => `cat ${quote(file)}`),
      ...[plugin, latePlugin].map((file) => `echo changed > ${quote(file)}`),
      'cat readable.txt',
      'cat ../data/agents/probe/.agents/skills/probe/SKILL.md',
    ].join('; '),
    resetLate() {
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
    },
  };
}

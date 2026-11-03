#!/usr/bin/env node
/** Check real exec traces; PATH resolution alone cannot prove AppArmor coverage. */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const directory = process.argv[2];
assert(directory, 'Supply the Codex exec trace directory');
const executions = [];
for (const file of readdirSync(directory)) {
  for (const line of readFileSync(path.join(directory, file), 'utf8').split('\n')) {
    const call = line.match(/execve\("([^"]+)", (\[.*)/);
    const at = line.match(/execveat\([^,]+, "([^"]*)", (\[.*)/);
    const args = call?.[2] ?? at?.[2] ?? '';
    const executable = call?.[1] ?? at?.[1] ?? '';
    if (path.basename(executable) !== 'bwrap' && !/^\["(?:[^"]*\/)?bwrap"/.test(args)) continue;
    assert.equal(
      executable,
      '/usr/bin/bwrap',
      'Codex executed a bubblewrap path outside the loaded distro profile'
    );
    assert.match(line, /= 0$/, 'bubblewrap exec did not succeed');
    // Codex's startup-warning probe also unshares networking. The real sandbox
    // drops capabilities; requiring that flag prevents a warning-only witness.
    executions.push({
      executable,
      isolated: args.includes('"--unshare-net"') && args.includes('"--cap-drop"'),
    });
  }
}
assert(
  executions.some((call) => call.isolated),
  'No real Codex namespace execution of the preflighted bubblewrap was traced'
);
console.info('Codex executed bubblewrap:', {
  executable: '/usr/bin/bwrap',
  executions: executions.length,
  namespaceExecutions: executions.filter((call) => call.isolated).length,
});

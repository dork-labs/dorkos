/**
 * The shell guard's own process (DOR-3300). It reads text an agent chose, so it runs apart from the
 * server: the server's timer can end a stall, and a crash takes only this process.
 *
 * It starts with Node's permission model on, able to read and nothing else, and refuses to say it
 * is ready unless that holds and it can answer about a plain command. Commands arrive over the
 * channel, never as arguments, so they don't show in a process list. It holds no state between
 * commands, and ends when the server goes.
 *
 * @module services/runtimes/claude-code/shell-guard/guard-child
 */
import path from 'node:path';
import { checkShellCommand } from './shell-check.js';
import type { GuardAnswer, GuardReady, GuardRequest } from './guard-protocol.js';

/** Whether this process can change nothing: no writes, no programs, no workers, no addons. */
function holdsNoPower(): boolean {
  const { permission } = process;
  if (!permission) return false;
  const root = path.parse(process.cwd()).root;
  return (
    !permission.has('fs.write', root) &&
    !permission.has('child') &&
    !permission.has('worker') &&
    !permission.has('addon') &&
    !permission.has('wasi')
  );
}

/** Whether the check answers about a plain command, on the folders it was started with. */
async function answersPlainly(): Promise<boolean> {
  const root = path.parse(process.cwd()).root;
  const { write, reaches } = await checkShellCommand(
    'true',
    { cwd: root, dorkHome: root, home: root, accounts: [], env: {}, agentHomes: () => [] },
    true
  );
  return write === 'none' && !reaches;
}

/** Start answering, or end if this process isn't what the server was promised. */
async function main(): Promise<void> {
  process.on('disconnect', () => process.exit(0));
  if (!process.send || !holdsNoPower() || !(await answersPlainly())) process.exit(1);
  process.on('message', (request: GuardRequest) => {
    const { id, command, roots, reads } = request;
    const { agentHomes, ...folders } = roots;
    void checkShellCommand(command, { ...folders, agentHomes: () => agentHomes }, reads).then(
      (answer) => process.send?.({ type: 'answer', id, answer } satisfies GuardAnswer)
    );
  });
  process.send({ type: 'ready' } satisfies GuardReady);
}

void main();

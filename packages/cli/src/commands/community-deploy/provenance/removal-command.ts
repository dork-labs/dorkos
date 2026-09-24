/**
 * `dorkos community deploy --remove-uncertain <run-id> [--confirm <token>]`.
 *
 * Wires the removal state machine to the run's journal, the probe for the one service the intent
 * names, the terminal, and its own cancel handler.
 *
 * @module commands/community-deploy/provenance/removal-command
 */
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { readLaunchJournal, writeLaunchJournal, type LaunchJournal } from '../journal.js';
import type { CommunityServiceOptions } from '../runtime/default-services.js';
import { createDefaultRemovalProbes } from '../runtime/default-removal.js';
import {
  formatRemovalOffer,
  formatRemovalOutcome,
  removalPrompt,
  type RemovalOutputContext,
} from './removal-output.js';
import {
  runUncertainRemoval,
  type RemovalAnswer,
  type RemovalProvider,
  type UncertainRemovalDependencies,
  type UncertainResourceProbe,
} from './uncertain-removal.js';

/** Everything the removal command needs from the dispatcher. */
export interface RemoveUncertainCommandInput {
  runId: string;
  journalPath: string;
  /** `--confirm` value, when given. */
  confirmToken?: string;
  /** Builds service options bound to this command's own cancellation signal. */
  serviceOptions(signal: AbortSignal): CommunityServiceOptions;
  input: Readable & { isTTY?: boolean };
  output: Writable & { isTTY?: boolean };
  /** Exact `--resume` command for a journal, or `null` without saved choices. */
  resumeCommand(journal: LaunchJournal): string | null;
  /** The existing recovery report for a journal. */
  recovery(journal: LaunchJournal): string;
  /** Test seam: the probe for one service. */
  probeFor?(provider: RemovalProvider): UncertainResourceProbe;
  /** Test seam: the process whose signals cancel the removal. */
  signals?: Pick<NodeJS.Process, 'once' | 'removeListener'>;
}

/**
 * Ask for the token on an interactive terminal. Enter, end of input and Control-C all keep the
 * resource.
 */
function askForToken(
  input: RemoveUncertainCommandInput['input'],
  output: RemoveUncertainCommandInput['output'],
  question: string,
  signal: AbortSignal
): Promise<RemovalAnswer> {
  return new Promise((resolve) => {
    const prompt = createInterface({ input, output, terminal: true });
    let settled = false;
    const settle = (answer: RemovalAnswer) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      prompt.close();
      resolve(answer);
    };
    const onAbort = () => settle({ kind: 'declined' });
    signal.addEventListener('abort', onAbort, { once: true });
    prompt.on('SIGINT', () => settle({ kind: 'declined' }));
    prompt.on('close', () => settle({ kind: 'declined' }));
    prompt.question(question, (answer) => {
      const typed = answer.trim();
      settle(typed.length === 0 ? { kind: 'declined' } : { kind: 'token', token: typed });
    });
  });
}

/**
 * Run the removal command and return its exit code.
 *
 * @param input - Run id, journal path, streams and dispatcher-built text.
 */
export async function runRemoveUncertainCommand(
  input: RemoveUncertainCommandInput
): Promise<number> {
  const journal = await readLaunchJournal(input.journalPath);
  if (!journal) throw new Error('The selected Community launch journal was not found');
  const context: RemovalOutputContext = {
    runId: input.runId,
    journal,
    resumeCommand: input.resumeCommand(journal),
    recovery: input.recovery(journal),
  };
  // Removal mode has its own cancel handler: it aborts the running service process, and the
  // state machine records an uncertain outcome only once its claim on the run has landed.
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort();
  const signals = input.signals ?? process;
  signals.once('SIGINT', cancel);
  signals.once('SIGTERM', cancel);
  const interactive = input.input.isTTY === true && input.output.isTTY === true;
  const dependencies: UncertainRemovalDependencies = {
    readJournal: () => readLaunchJournal(input.journalPath),
    persist: (next, expectedRevision) =>
      writeLaunchJournal(input.journalPath, next, expectedRevision),
    probeFor:
      input.probeFor ?? createDefaultRemovalProbes(input.serviceOptions(cancellation.signal)),
    confirm: async (target, notFromRun) => {
      input.output.write(formatRemovalOffer(target, notFromRun, context));
      // `--confirm` is one more condition on a verdict computed from scratch, never a bypass.
      if (input.confirmToken !== undefined) return { kind: 'token', token: input.confirmToken };
      if (!interactive) return { kind: 'check-only' };
      return askForToken(
        input.input,
        input.output,
        removalPrompt(target.provider),
        cancellation.signal
      );
    },
    now: () => new Date().toISOString(),
    sleep: (ms) =>
      new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        cancellation.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true }
        );
      }),
    signal: cancellation.signal,
  };
  try {
    const outcome = await runUncertainRemoval(dependencies);
    const result = formatRemovalOutcome(outcome, context);
    input.output.write(result.text);
    return result.exitCode;
  } finally {
    signals.removeListener('SIGINT', cancel);
    signals.removeListener('SIGTERM', cancel);
  }
}

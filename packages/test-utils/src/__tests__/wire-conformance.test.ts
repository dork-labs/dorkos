/**
 * The suite's own bookkeeping (spec `space-computer-contract` §12): a case
 * passes only when every runner really ran it, and the socket pair's drop
 * loses what was in flight.
 */
import { describe, expect, it } from 'vitest';
import { Wire } from '../relay-socket-pair.js';
import { runWireCase, type WireCase, type WireEnds, type WireRunner } from '../wire-conformance.js';

/** A runner whose ends do nothing, counting what it was asked to start. */
function stubRunner(name: string) {
  const counts = { started: 0, dropped: 0 };
  const runner: WireRunner = {
    name,
    start: async () => {
      counts.started += 1;
      return {
        drop: () => {
          counts.dropped += 1;
        },
      } as unknown as WireEnds;
    },
    startUnchecked: async () => {
      counts.started += 1;
      return {} as never;
    },
  };
  return { runner, counts };
}

/**
 * The error `runWireCase` ends with, or `null`. Awaited before any `expect`,
 * because `runWireCase` counts the assertions made while a case runs.
 */
async function failure(wireCase: WireCase, runners: WireRunner[]): Promise<Error | null> {
  return runWireCase(wireCase, runners).then(
    () => null,
    (error: Error) => error
  );
}

/** A case that starts its ends once and asserts once, except where told. */
function startsAndAsserts(skip?: string, assert = true): WireCase {
  return {
    name: 'a case',
    run: async (runner) => {
      if (runner.name === skip) return;
      await runner.start({ computer: [], home: [] });
      if (assert) expect(runner.name).toBeTypeOf('string');
    },
  };
}

describe('runWireCase', () => {
  it('fails a case that runs over the wire but skips in process', async () => {
    const error = await failure(startsAndAsserts('in process'), [
      stubRunner('in process').runner,
      stubRunner('over the wire').runner,
    ]);
    expect(error?.message).toBe('in process: a case: the run never started its ends');
  });

  it('fails a case that runs in process but skips over the wire', async () => {
    const error = await failure(startsAndAsserts('over the wire'), [
      stubRunner('in process').runner,
      stubRunner('over the wire').runner,
    ]);
    expect(error?.message).toBe('over the wire: a case: the run never started its ends');
  });

  it('fails a case that starts its ends but asserts nothing', async () => {
    const error = await failure(startsAndAsserts(undefined, false), [
      stubRunner('in process').runner,
      stubRunner('over the wire').runner,
    ]);
    expect(error?.message).toBe('in process: a case: the run asserted nothing');
  });

  it('names the runner a case failed under, and keeps the cause', async () => {
    const broken: WireCase = {
      name: 'a broken case',
      run: async (runner) => {
        await runner.start({ computer: [], home: [] });
        if (runner.name === 'over the wire') throw new Error('it broke');
        expect(runner.name).toBe('in process');
      },
    };
    const error = await failure(broken, [
      stubRunner('in process').runner,
      stubRunner('over the wire').runner,
    ]);
    expect(error?.message).toBe('over the wire: it broke');
    expect((error?.cause as Error).message).toBe('it broke');
  });

  it('passes a case both runners ran, and drops every connection it opened', async () => {
    const inProcess = stubRunner('in process');
    const overWire = stubRunner('over the wire');
    const twice: WireCase = {
      name: 'runs both ways',
      run: async (runner) => {
        await runner.start({ computer: [], home: [] });
        await runner.start({ computer: [], home: [] });
        expect(runner.name).toBeTypeOf('string');
      },
    };
    const error = await failure(twice, [inProcess.runner, overWire.runner]);
    expect(error).toBeNull();
    expect(inProcess.counts).toEqual({ started: 2, dropped: 2 });
    expect(overWire.counts).toEqual({ started: 2, dropped: 2 });
  });
});

describe('the socket pair', () => {
  it('drops what was in flight, and both ends hear the close at once', () => {
    const wire = new Wire();
    const heard: string[] = [];
    wire.hub.on('message', (data) => heard.push(String(data)));
    wire.computer.on('close', () => heard.push('computer closed'));
    wire.hub.on('close', () => heard.push('hub closed'));
    wire.computer.send('lost');
    wire.drop();
    wire.pump();
    wire.computer.send('after');
    wire.pump();
    expect(heard).toEqual(['computer closed', 'hub closed']);
  });

  it('delivers nothing to an end that has closed', () => {
    const wire = new Wire();
    const heard: string[] = [];
    wire.hub.on('message', (data) => heard.push(String(data)));
    wire.computer.send('in flight');
    wire.hub.close();
    wire.pump();
    expect(heard).toEqual([]);
  });
});

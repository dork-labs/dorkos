/**
 * The suite's own bookkeeping (spec `space-computer-contract` §12): a case
 * passes only when every runner really ran it, and the socket pair's drop
 * loses what was in flight.
 */
import { describe, expect, it } from 'vitest';
import { Wire } from '../relay-socket-pair.js';
import { runWireCase, type WireEnds, type WireRunner } from '../wire-conformance.js';

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

describe('runWireCase', () => {
  it('fails a case that runs over the wire but skips in process', async () => {
    const inProcess = stubRunner('in process');
    const overWire = stubRunner('over the wire');
    const skips = {
      name: 'skips one way',
      run: async (runner: WireRunner) => {
        if (runner.name === 'in process') return;
        await runner.start({ computer: [], home: [] });
      },
    };
    await expect(runWireCase(skips, [inProcess.runner, overWire.runner])).rejects.toThrow(
      'the in process run never started its ends'
    );
  });

  it('fails a case that runs in process but skips over the wire', async () => {
    const skips = {
      name: 'skips the other way',
      run: async (runner: WireRunner) => {
        if (runner.name === 'over the wire') return;
        await runner.start({ computer: [], home: [] });
      },
    };
    await expect(
      runWireCase(skips, [stubRunner('in process').runner, stubRunner('over the wire').runner])
    ).rejects.toThrow('the over the wire run never started its ends');
  });

  it('passes a case both runners ran, and drops every connection it opened', async () => {
    const inProcess = stubRunner('in process');
    const overWire = stubRunner('over the wire');
    const both = {
      name: 'runs both ways',
      run: async (runner: WireRunner) => {
        await runner.start({ computer: [], home: [] });
        await runner.start({ computer: [], home: [] });
      },
    };
    await runWireCase(both, [inProcess.runner, overWire.runner]);
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
});

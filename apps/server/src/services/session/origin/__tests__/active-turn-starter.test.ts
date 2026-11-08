import { afterEach, describe, expect, it } from 'vitest';
import { activeTurnStarterOf, beginTurnStarter, trackTurnStarter } from '../active-turn-starter.js';
import { linkSessionId, resetSessionKeys } from '../../resolution/session-key-registry.js';

afterEach(resetSessionKeys);

describe('one send’s display starter', () => {
  it('follows the canonical id learned mid-turn', () => {
    const done = beginTurnStarter('sample-request', 'telegram');
    try {
      linkSessionId('sample-request', 'sample-canonical');
      expect(activeTurnStarterOf('sample-canonical')).toBe('a Telegram message');
    } finally {
      done();
    }
    expect(activeTurnStarterOf('sample-canonical')).toBeUndefined();
  });

  it('never picks a starter from overlapping sends or lets a stale settle clear a successor', () => {
    const first = beginTurnStarter('sample', 'telegram');
    const second = beginTurnStarter('sample', undefined);
    try {
      expect(activeTurnStarterOf('sample')).toBe('something DorkOS couldn’t identify');
      first();
      expect(activeTurnStarterOf('sample')).toBe('something DorkOS couldn’t identify');
      first();
      expect(activeTurnStarterOf('sample')).toBe('something DorkOS couldn’t identify');
    } finally {
      first();
      second();
    }
  });

  it.each(['complete', 'throw', 'return'])(
    'clears on %s so the next ordinary turn cannot inherit a bridge',
    async (ending) => {
      async function* events() {
        expect(activeTurnStarterOf('sample')).toBe('a Slack message');
        yield 1;
        if (ending === 'throw') throw new Error('sample stop');
        yield 2;
      }
      const stream = trackTurnStarter('sample', 'slack', events());
      expect(activeTurnStarterOf('sample')).toBeUndefined();
      await stream.next();
      if (ending === 'return') await stream.return(undefined);
      else if (ending === 'throw') await expect(stream.next()).rejects.toThrow('sample stop');
      else {
        await stream.next();
        await stream.next();
      }
      expect(activeTurnStarterOf('sample')).toBeUndefined();
    }
  );
});

it.each(['__proto__', 'constructor', 'toString'])('rejects inherited label key %s', (starter) => {
  const done = beginTurnStarter('sample', starter as never);
  try {
    expect(activeTurnStarterOf('sample')).toBe('something DorkOS couldn’t identify');
  } finally {
    done();
  }
});

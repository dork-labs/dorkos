import { afterEach, describe, expect, it } from 'vitest';
import {
  holdTurnOriginFor,
  isOutsiderOrigin,
  messageDispatched,
  messageTurnStarted,
  noteTurnOrigin,
  resetOutsiderTurns,
  setLaunchOriginReader,
  turnStartedByOutsider,
} from '../outsider-turns.js';

afterEach(() => resetOutsiderTurns());

describe('outsider turns', () => {
  it('reads a room turn by its author and the stranger origins as strangers', () => {
    expect(isOutsiderOrigin({ kind: 'room', externalAuthor: true })).toBe(true);
    expect(isOutsiderOrigin({ kind: 'room', externalAuthor: false })).toBe(false);
    expect(isOutsiderOrigin({ kind: 'relay-binding' })).toBe(true);
    expect(isOutsiderOrigin({ kind: 'outside-sender' })).toBe(true);
    expect(isOutsiderOrigin({ kind: 'connector-event' })).toBe(true);
    expect(isOutsiderOrigin({ kind: 'interactive' })).toBe(false);
    expect(isOutsiderOrigin({ kind: 'heartbeat' })).toBe(false);
  });

  it('follows the latest turn in a chat', () => {
    noteTurnOrigin('chat', { kind: 'room', externalAuthor: true });
    expect(turnStartedByOutsider('chat')).toBe(true);
    noteTurnOrigin('chat', { kind: 'interactive' });
    expect(turnStartedByOutsider('chat')).toBe(false);
  });

  it('falls back to what started the chat when this process saw no turn of it', () => {
    setLaunchOriginReader((id) => (id === 'bridged' ? 'relay-binding' : 'interactive'));
    expect(turnStartedByOutsider('bridged')).toBe(true);
    expect(turnStartedByOutsider('mine')).toBe(false);
  });

  it('reads nothing as a stranger when the store cannot be read', () => {
    setLaunchOriginReader(() => {
      throw new Error('no database');
    });
    expect(turnStartedByOutsider('chat')).toBe(false);
  });
});

describe("a message's held origin", () => {
  it('takes effect when its own turn starts, not when it was bound', () => {
    noteTurnOrigin('chat', { kind: 'relay-binding' });
    holdTurnOriginFor('m-person', () => noteTurnOrigin('chat', { kind: 'interactive' }));
    messageDispatched('chat', 'm-person', { accepted: true, applied: 'queue' });
    expect(turnStartedByOutsider('chat')).toBe(true);
    messageTurnStarted('chat', 'm-person');
    expect(turnStartedByOutsider('chat')).toBe(false);
  });

  it("makes the running turn a stranger's when a stranger steers into it, never the reverse", () => {
    noteTurnOrigin('chat', { kind: 'interactive' });
    holdTurnOriginFor('m-steer', () => noteTurnOrigin('chat', { kind: 'outside-sender' }));
    messageDispatched('chat', 'm-steer', { accepted: true, applied: 'steer' });
    expect(turnStartedByOutsider('chat')).toBe(true);

    holdTurnOriginFor('m-local', () => noteTurnOrigin('chat', { kind: 'interactive' }));
    messageDispatched('chat', 'm-local', { accepted: true, applied: 'steer' });
    expect(turnStartedByOutsider('chat')).toBe(true);
  });

  it('is forgotten when the message is refused', () => {
    noteTurnOrigin('chat', { kind: 'relay-binding' });
    holdTurnOriginFor('m-refused', () => noteTurnOrigin('chat', { kind: 'interactive' }));
    messageDispatched('chat', 'm-refused', { accepted: false });
    messageTurnStarted('chat', 'm-refused');
    expect(turnStartedByOutsider('chat')).toBe(true);
  });
});

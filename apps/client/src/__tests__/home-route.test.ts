/**
 * `/`'s search contract — the addresses the home tab has to keep answering
 * after it became the #team room (team-room-home spec D3.2/D3.5).
 *
 * Two of these params predate the room and one arrived with it, and all three
 * are addresses somebody may already be holding: a Recent-Activity row's deep
 * link is pasted into chat, and a thread opened on Home is refreshed or shared.
 */
import { describe, it, expect } from 'vitest';
import { homeSearchSchema } from '../router';

describe('the home route search schema', () => {
  it('keeps the attention deep links working', () => {
    // Exactly what `notificationLink` (in `entities/notifications`) navigates
    // to for a failed run and an unreachable agent, and what a pasted link
    // carries. The pinned triage header opens the sheet off these two.
    expect(homeSearchSchema.parse({ detail: 'failed-run', itemId: 'run-9' })).toMatchObject({
      detail: 'failed-run',
      itemId: 'run-9',
    });
    expect(
      homeSearchSchema.parse({ detail: 'dead-letter', itemId: 'relay::timeout' })
    ).toMatchObject({ detail: 'dead-letter' });
    expect(homeSearchSchema.parse({ detail: 'offline-agent', itemId: 'offline' })).toMatchObject({
      detail: 'offline-agent',
    });
  });

  it('addresses a thread the way /channels does — the same spelling, the same meaning', () => {
    expect(homeSearchSchema.parse({ thread: 'entry-7' }).thread).toBe('entry-7');
  });

  it('shows the room rather than an error page when the sheet name is stale', () => {
    // This is the address the app OPENS on. A bookmark naming a sheet that no
    // longer exists must land on the room with nothing over it.
    expect(homeSearchSchema.parse({ detail: 'no-such-sheet' }).detail).toBeUndefined();
  });

  it('has no room id to point somewhere else', () => {
    // Home is #team, found by its well-known key. An `id` in the URL would be a
    // way to make Home show a different conversation.
    expect(homeSearchSchema.parse({ id: 'some-other-room' })).not.toHaveProperty('id');
  });
});

import type { StreamEvent } from '@lifeos/shared/types';

/**
 * Creates an AsyncGenerator that yields StreamEvent objects.
 * Used to mock agentManager.sendMessage().
 */
export async function* mockStreamGenerator(
  events: StreamEvent[]
): AsyncGenerator<StreamEvent> {
  for (const event of events) {
    yield event;
  }
}

/**
 * Parses raw SSE text (as sent over the wire) into structured events.
 * Used to assert on supertest response bodies.
 */
export function parseSSEResponse(text: string): Array<{ type: string; data: unknown }> {
  const events: Array<{ type: string; data: unknown }> = [];
  const lines = text.split('\n');
  let currentType = '';

  for (const line of lines) {
    if (line.startsWith('event: ')) {
      currentType = line.slice(7).trim();
    } else if (line.startsWith('data: ') && currentType) {
      events.push({
        type: currentType,
        data: JSON.parse(line.slice(6)),
      });
      currentType = '';
    }
  }

  return events;
}

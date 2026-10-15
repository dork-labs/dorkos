import type { APIRequestContext } from '@playwright/test';

/**
 * Read existing Room diagnostics once after an original assertion fails.
 * Each GET has its own 1000ms bound; this is not a whole-capture wall-clock guarantee.
 * Empty or unavailable DATA is not proof of absent work or authority.
 * @param request - The test's existing authenticated request context.
 * @param roomIds - The one or two rooms already created or read by the test.
 * @param frontier - A fixed label naming the original failed assertion.
 */
export async function captureRoomFailureData(
  request: APIRequestContext,
  roomIds: readonly string[],
  frontier: string
): Promise<void> {
  const ids = [...new Set(roomIds)].slice(0, 2);
  const paths = [
    '/api/debug/dispatches?limit=256',
    '/api/debug/refusals?limit=256',
    ...ids.flatMap((id) => [`/api/debug/rooms/${id}/bindings`, `/api/rooms/${id}`]),
  ];
  const reads = await Promise.all(
    paths.map(async (path) => {
      try {
        const response = await request.get(path, { timeout: 1_000 });
        const data = await response.json();
        // Debug routes expose ids, counts and coarse enums. Reduce room reads
        // to the working count so entry text and prompts are never copied.
        const selected = ids.some((id) => path === `/api/rooms/${id}`)
          ? { workingAgents: data.workingAgents }
          : data;
        return { path, status: response.status(), data: JSON.stringify(selected).slice(0, 8_192) };
      } catch {
        return { path, unavailable: true };
      }
    })
  );
  console.error(
    'ORIGINAL_ROOM_FAILURE_FRONTIER ' +
      JSON.stringify({
        frontier,
        roomIds: ids,
        reads,
        meaning: 'FAILURE_ONLY_DATA_ABSENCE_UNKNOWN',
      })
  );
}

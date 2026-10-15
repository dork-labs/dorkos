import { type Page } from '@playwright/test';
import { SessionSnapshotSchema } from '@dorkos/shared/session-stream';

/** Observe actual held producer output through the authenticated live session snapshot. */
export async function originalHeldTurnHasText(
  page: Page,
  sessionId: string,
  cwd: string,
  text: string
): Promise<boolean> {
  const snapshot = await page.evaluate(
    async ({ sessionId, cwd }) => {
      const controller = new AbortController();
      const deadline = setTimeout(
        () => controller.abort(new Error('Original live snapshot did not arrive within 5 seconds')),
        5000
      );
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let failed = false,
        first: unknown,
        snapshot: unknown;
      try {
        const response = await fetch(
          '/api/sessions/' + sessionId + '/events?cwd=' + encodeURIComponent(cwd),
          {
            credentials: 'same-origin',
            headers: { Accept: 'text/event-stream' },
            signal: controller.signal,
          }
        );
        if (
          !response.ok ||
          !response.body ||
          !response.headers.get('content-type')?.startsWith('text/event-stream')
        )
          throw new Error('Original live session snapshot unavailable');
        reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8', { fatal: true });
        let bytes = 0,
          pending = '';
        for (;;) {
          if (!pending.includes('\n\n')) {
            const part = await reader.read();
            if (part.done) throw new Error('Original live snapshot ended before hydration');
            bytes += part.value.byteLength;
            if (bytes > 1048576) throw new Error('Original live snapshot fixture bound exceeded');
            pending += decoder.decode(part.value, { stream: true });
          }
          const end = pending.indexOf('\n\n');
          if (end < 0) continue;
          const lines = pending.slice(0, end).split('\n');
          pending = pending.slice(end + 2);
          // Heartbeats are comments, not producer evidence or hydration frames.
          if (lines.every((line) => !line || line.startsWith(':'))) continue;
          if (!lines.includes('event: snapshot'))
            throw new Error('Original cold snapshot frame missing');
          snapshot = JSON.parse(
            lines
              .filter((line) => line.startsWith('data: '))
              .map((line) => line.slice(6))
              .join('\n')
          );
          break;
        }
      } catch (cause) {
        failed = true;
        first = cause;
      }
      const drain = async (run: () => unknown) => {
        try {
          await run();
        } catch (cause) {
          if (!failed) {
            failed = true;
            first = cause;
          }
        }
      };
      await drain(() => clearTimeout(deadline));
      // Cancel the readable body before abort can error a successfully read stream.
      await drain(() => reader?.cancel());
      await drain(() => controller.abort());
      await drain(() => reader?.releaseLock());
      if (failed) throw first;
      return snapshot;
    },
    { sessionId, cwd }
  );
  const current = SessionSnapshotSchema.parse(snapshot);
  return (
    current.inProgressTurn?.some((event) => event.type === 'text_delta' && event.text === text) ??
    false
  );
}

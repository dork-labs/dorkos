/** The wire bounds apply separately to each ordered binary lane. */
export const MAX_FRAME_BYTES = 64 * 1024;
export const MAX_LANE_CREDIT = 256 * 1024;

/**
 * A reader returns credit by consuming a frame. One pending write owns a copy
 * of at most one frame outside admitted credit. End drains it before EOF.
 * Failure drops the pending write. Abandon also drops admitted unread bytes.
 */
export function createByteLane() {
  let terminal;
  let bytes = 0;
  let reading = false;
  let writing = false;
  let ending = false;
  let wakeReader;
  let wakeWriter;
  const queue = [];

  const settle = (fact, discard) => {
    if (terminal) return false;
    terminal = fact;
    if (discard) {
      queue.length = 0;
      bytes = 0;
    }
    wakeReader?.();
    wakeWriter?.();
    return true;
  };

  const writer = {
    async write(frame) {
      if (!(frame instanceof Uint8Array) || !frame.byteLength || frame.byteLength > MAX_FRAME_BYTES)
        throw new RangeError('Invalid custody frame length');
      if (terminal || ending) throw new Error('Custody lane is closed');
      if (writing) throw new Error('Concurrent custody lane writes are unsupported');
      const submitted = Uint8Array.from(frame);
      writing = true;
      try {
        while (!terminal && bytes + submitted.byteLength > MAX_LANE_CREDIT)
          await new Promise((resolve) => {
            wakeWriter = resolve;
          });
        if (terminal) throw new Error('Custody lane is closed');
        queue.push(submitted);
        bytes += submitted.byteLength;
        wakeReader?.();
      } finally {
        writing = false;
        wakeWriter = undefined;
        if (ending) settle({ kind: 'eof' }, false);
      }
    },
    end() {
      if (terminal || ending) return false;
      ending = true;
      if (!writing) settle({ kind: 'eof' }, false);
      return true;
    },
    fail: (error) => settle({ kind: 'error', error }, false),
  };

  const reader = {
    async read() {
      if (reading) throw new Error('Concurrent custody lane reads are unsupported');
      reading = true;
      try {
        while (!terminal && !queue.length)
          await new Promise((resolve) => {
            wakeReader = resolve;
          });
        const frame = queue.shift();
        if (!frame) return terminal;
        bytes -= frame.byteLength;
        wakeWriter?.();
        return { kind: 'bytes', frame };
      } finally {
        reading = false;
        wakeReader = undefined;
      }
    },
  };

  return {
    reader,
    writer,
    abandon(error) {
      // Retire buffered bytes even when orderly EOF already arrived, while keeping
      // that producer fact separate from the consumer's abandoned stream.
      if (queue.length && terminal) {
        terminal = { kind: 'error', error };
        queue.length = 0;
        bytes = 0;
        return;
      }
      settle({ kind: 'error', error }, true);
    },
    get creditUsed() {
      return bytes;
    },
  };
}

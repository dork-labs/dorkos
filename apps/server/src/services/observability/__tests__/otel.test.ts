import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  initObservability,
  shutdownObservability,
  resolveObservabilityMode,
  isTracingEnabled,
  getTraceFilePath,
  startSpan,
  withSpan,
  tracedGenerator,
} from '../index.js';
import { SPAN, ATTR } from '../attributes.js';

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-otel-'));
}

/** All lines of the active trace file as parsed span objects. */
function readSpans(file: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

afterEach(async () => {
  await shutdownObservability();
});

describe('resolveObservabilityMode — activation decision', () => {
  it('is fully off with no env and no debug flag (identical to today)', () => {
    expect(resolveObservabilityMode({}, false)).toEqual({
      file: false,
      otlp: false,
      disabled: false,
    });
  });

  it('turns file mode on for the debug flag alone', () => {
    expect(resolveObservabilityMode({}, true)).toEqual({
      file: true,
      otlp: false,
      disabled: false,
    });
  });

  it('turns OTLP mode on when an endpoint is set, without the debug flag', () => {
    expect(
      resolveObservabilityMode({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' }, false)
    ).toEqual({ file: false, otlp: true, disabled: false });
  });

  it('turns both modes on independently when debug + endpoint are set', () => {
    expect(
      resolveObservabilityMode({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' }, true)
    ).toEqual({ file: true, otlp: true, disabled: false });
  });

  it('treats a blank/whitespace endpoint as unset', () => {
    expect(resolveObservabilityMode({ OTEL_EXPORTER_OTLP_ENDPOINT: '   ' }, false)).toEqual({
      file: false,
      otlp: false,
      disabled: false,
    });
  });

  describe('OTEL_SDK_DISABLED wins over everything', () => {
    it('overrides the debug flag', () => {
      expect(resolveObservabilityMode({ OTEL_SDK_DISABLED: 'true' }, true)).toEqual({
        file: false,
        otlp: false,
        disabled: true,
      });
    });

    it('overrides an OTLP endpoint', () => {
      expect(
        resolveObservabilityMode(
          { OTEL_SDK_DISABLED: 'true', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' },
          false
        )
      ).toEqual({ file: false, otlp: false, disabled: true });
    });

    it.each(['true', 'TRUE', ' True ', '1', 'yes', 'YES', 'on'])(
      'accepts truthy form %j',
      (value) => {
        expect(resolveObservabilityMode({ OTEL_SDK_DISABLED: value }, true).disabled).toBe(true);
      }
    );

    it.each(['false', 'FALSE', '0', 'no', 'off', '', '  '])(
      'ignores non-truthy form %j',
      (value) => {
        expect(resolveObservabilityMode({ OTEL_SDK_DISABLED: value }, true).disabled).toBe(false);
      }
    );
  });
});

describe('observability — off by default (zero output)', () => {
  it('does not enable tracing, create a file, or emit spans when debug is false', async () => {
    const home = tmpHome();
    const result = await initObservability({ debug: false, dorkHome: home, version: '9.9.9' });

    expect(result).toBeUndefined();
    expect(isTracingEnabled()).toBe(false);
    expect(getTraceFilePath()).toBeUndefined();

    // Exercise every seam helper — nothing should be recorded.
    const span = startSpan(SPAN.SESSION_TURN, { [ATTR.SESSION_ID]: 's1' });
    span.setAttr(ATTR.EVENT_COUNT, 3);
    span.end();

    const out = await withSpan(SPAN.TASK_RUN, { [ATTR.TASK_TRIGGER]: 'manual' }, async () => 'ok');
    expect(out).toBe('ok');

    async function* gen() {
      yield 1;
      yield 2;
    }
    const collected: number[] = [];
    for await (const n of tracedGenerator(SPAN.RUNTIME_SEND_MESSAGE, {}, gen())) {
      collected.push(n);
    }
    expect(collected).toEqual([1, 2]);

    // The traces directory is never even created on the off-path.
    expect(fs.existsSync(path.join(home, 'traces'))).toBe(false);
  });
});

describe('observability — debug tracing on', () => {
  it('writes sanitized spans to a local file and records allowlisted attributes', async () => {
    const home = tmpHome();
    const file = await initObservability({ debug: true, dorkHome: home, version: '1.2.3' });
    expect(file).toBeDefined();
    expect(isTracingEnabled()).toBe(true);
    expect(file!.startsWith(path.join(home, 'traces'))).toBe(true);

    await withSpan(SPAN.TASK_RUN, { [ATTR.TASK_TRIGGER]: 'scheduled' }, async (span) => {
      span.setAttr(ATTR.TASK_DISPATCH, 'direct');
    });

    await shutdownObservability();

    const spans = readSpans(file!);
    const taskSpan = spans.find((s) => s.name === SPAN.TASK_RUN);
    expect(taskSpan).toBeDefined();
    expect(taskSpan!.attributes).toMatchObject({
      [ATTR.TASK_TRIGGER]: 'scheduled',
      [ATTR.TASK_DISPATCH]: 'direct',
    });
    expect(typeof taskSpan!.durationMs).toBe('number');
  });

  it('marks a throwing span as error and still ends it', async () => {
    const home = tmpHome();
    const file = await initObservability({ debug: true, dorkHome: home, version: '1.0.0' });

    await expect(
      withSpan(SPAN.SESSION_TURN, { [ATTR.SESSION_ID]: 'boom' }, async () => {
        throw new Error('kaboom /Users/dorian/secret');
      })
    ).rejects.toThrow('kaboom');

    await shutdownObservability();

    const spans = readSpans(file!);
    const turn = spans.find((s) => s.name === SPAN.SESSION_TURN);
    expect(turn!.status).toBe('error');
    // The thrown error message (which contains a path) must NOT reach the file.
    expect(fs.readFileSync(file!, 'utf-8')).not.toContain('/Users/dorian/secret');
  });

  it('never leaks PII passed through a traced generator (only the event count is recorded)', async () => {
    const home = tmpHome();
    const file = await initObservability({ debug: true, dorkHome: home, version: '1.0.0' });

    // A generator whose ITEMS carry secrets — items pass through untouched and
    // are never turned into attributes.
    async function* secretStream() {
      yield { type: 'text', data: 'my password is hunter2' };
      yield { type: 'text', data: '/home/dorian/.aws/credentials' };
      yield { type: 'text', data: 'sk-ant-0xdeadbeef' };
    }
    const seen: unknown[] = [];
    for await (const ev of tracedGenerator(
      SPAN.RUNTIME_SEND_MESSAGE,
      { [ATTR.RUNTIME]: 'claude-code', [ATTR.SESSION_ID]: 'sess-1' },
      secretStream()
    )) {
      seen.push(ev);
    }
    expect(seen).toHaveLength(3); // pass-through is intact

    await shutdownObservability();

    const raw = fs.readFileSync(file!, 'utf-8');
    for (const secret of ['hunter2', 'credentials', 'sk-ant', 'password']) {
      expect(raw).not.toContain(secret);
    }
    const runtimeSpan = readSpans(file!).find((s) => s.name === SPAN.RUNTIME_SEND_MESSAGE);
    expect(runtimeSpan!.attributes).toMatchObject({
      [ATTR.RUNTIME]: 'claude-code',
      [ATTR.SESSION_ID]: 'sess-1',
      [ATTR.EVENT_COUNT]: 3,
    });
  });
});

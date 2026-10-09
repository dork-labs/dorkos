// @vitest-environment jsdom
import { expect, it, vi, onTestFinished } from 'vitest';
import { CanvasSelectionCopy } from '../lib/canvas-selection-copy';
const binding = {
  browserId: 'copy_browser_reference_000001',
  browserGeneration: 1,
  tabId: 'copy_tab_reference_00000001',
  navigationGeneration: 0,
  viewportVersion: 0,
  epoch: 0,
  inputGeneration: 0,
};
const selected = {
  requestId: 'copy_request_reference_000001',
  binding,
  outcome: 'selected' as const,
  text: 'ordinary',
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (value: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(
  options: {
    held?: boolean;
    writeFailure?: unknown;
    throwWrite?: boolean;
    unsupported?: boolean;
  } = {}
) {
  const payloads: Record<string, Promise<Blob>>[] = [];
  const text: string[] = [];
  const released = deferred<typeof selected>();
  let current = true;
  class Item implements ClipboardItem {
    readonly types = ['text/plain'];
    readonly presentationStyle = 'unspecified' as const;
    private readonly data: Record<string, Promise<Blob>>;
    constructor(
      input: Record<string, string | Blob | PromiseLike<string | Blob>>,
      _options?: ClipboardItemOptions
    ) {
      this.data = Object.fromEntries(
        Object.entries(input).map(([key, value]) => [
          key,
          Promise.resolve(value).then((item) =>
            typeof item === 'string' ? new Blob([item], { type: key }) : item
          ),
        ])
      );
      for (const promise of Object.values(this.data)) void promise.catch(() => undefined);
      payloads.push(this.data);
    }
    getType(type: string): Promise<Blob> {
      return this.data[type];
    }
    static supports(type: string) {
      return type === 'text/plain';
    }
  }
  const write = vi.fn(async (items: ClipboardItem[]) => {
    if (options.throwWrite) throw options.writeFailure;
    const blob = await items[0].getType('text/plain');
    text.push(
      await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(blob);
      })
    );
  });
  const read = vi.fn(async () => (options.held ? released.promise : selected)),
    status = vi.fn();
  const owner = new CanvasSelectionCopy({
    item: options.unsupported ? undefined : Item,
    write: options.unsupported ? undefined : write,
    read,
    current: () => current,
    status,
  });
  onTestFinished(async () => {
    released.resolve(selected);
    await owner.close();
  });
  return {
    owner,
    write,
    read,
    status,
    text,
    payloads,
    released,
    revoke: () => {
      current = false;
    },
    event: { isTrusted: true, preventDefault: vi.fn() },
  };
}
// Trusted flags and clipboard ports here are controlled scheduling inputs, never real OS-write proof.
it('starts original clipboard write synchronously inside the gesture, before authenticated read', async () => {
  const f = fixture();
  expect(f.owner.copy(f.event)).toBe(true);
  expect(f.write).toHaveBeenCalledTimes(1);
  expect(f.read).not.toHaveBeenCalled();
  await f.payloads[0]['text/plain'];
  await Promise.resolve();
  await f.owner.close();
  expect(f.text).toEqual(['ordinary']);
});
it('never enters clipboard/read from an untrusted event', async () => {
  const f = fixture();
  expect(f.owner.copy({ ...f.event, isTrusted: false })).toBe(false);
  expect(f.write).not.toHaveBeenCalled();
  expect(f.read).not.toHaveBeenCalled();
});
it('refuses unsupported clipboard rather than using a read/writeText fallback', () => {
  const f = fixture({ unsupported: true });
  expect(f.owner.copy(f.event)).toBe(true);
  expect(f.read).not.toHaveBeenCalled();
  expect(f.status).toHaveBeenCalledWith('Copying is unavailable in this browser.');
});
it('held authenticated selection cannot deliver text after original authority revocation', async () => {
  const f = fixture({ held: true });
  f.owner.copy(f.event);
  const payload = f.payloads[0]['text/plain'];
  void payload.catch(() => undefined);
  await Promise.resolve();
  f.revoke();
  f.released.resolve(selected);
  await expect(payload).rejects.toThrow('changed');
  await f.owner.close();
  expect(f.text).toEqual([]);
});
it('close waits the held original selection and rejects its pending clipboard payload', async () => {
  const f = fixture({ held: true });
  f.owner.copy(f.event);
  await Promise.resolve();
  let returned = false;
  const closing = f.owner.close().then(() => {
    returned = true;
  });
  await Promise.resolve();
  expect(returned).toBe(false);
  f.released.resolve(selected);
  await closing;
  expect(f.text).toEqual([]);
});
it.each([false, undefined])(
  'first original clipboard refusal remains falsy and cannot deliver text: %s',
  async (value) => {
    const f = fixture({ held: true, throwWrite: true, writeFailure: value });
    f.owner.copy(f.event);
    const payload = f.payloads[0]['text/plain'];
    void payload.catch(() => undefined);
    await Promise.resolve();
    f.released.resolve(selected);
    await expect(payload).rejects.toBe(value);
    await f.owner.close();
    expect(f.text).toEqual([]);
  }
);
it('refuses secret selection without a plaintext clipboard payload', async () => {
  const f = fixture();
  f.read.mockResolvedValue({
    requestId: selected.requestId,
    binding,
    outcome: 'refused',
    reason: 'secret',
  } as unknown as typeof selected);
  f.owner.copy(f.event);
  const payload = f.payloads[0]['text/plain'];
  void payload.catch(() => undefined);
  await expect(payload).rejects.toThrow('secret');
  await f.owner.close();
  expect(f.text).toEqual([]);
});
it('a failing status sink cannot strand original close', async () => {
  const f = fixture();
  f.status.mockImplementation(() => {
    throw undefined;
  });
  f.owner.copy(f.event);
  await f.payloads[0]['text/plain'];
  await f.owner.close();
  expect(f.text).toEqual(['ordinary']);
});

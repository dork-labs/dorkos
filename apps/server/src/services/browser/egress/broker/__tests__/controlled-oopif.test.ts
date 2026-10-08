import { expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { originalOOPIFDocument, readOriginalOOPIFResult } from './controlled-oopif.fixture.js';
const nonce = 'fa71cdd8-4c56-41ec-8c62-9f540884fc88';
it.each([true, false])(
  'served iframe script issues its own request and reports actual settlement %s',
  async (allowed) => {
    const destination = `https://owned.example/${allowed ? 'oopif-request/' + nonce : 'forbidden/' + nonce + '/oopif'}`;
    const document = originalOOPIFDocument(nonce, destination);
    const source = document.split('<script>')[1]!.split('</script>')[0]!;
    const fetch = vi.fn(() =>
      allowed ? Promise.resolve({}) : Promise.reject(new Error('original refusal'))
    );
    const postMessage = vi.fn();
    await runInNewContext(source, { fetch, parent: { postMessage } });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(destination, {
      mode: 'no-cors',
      credentials: 'omit',
      cache: 'no-store',
    });
    expect(postMessage).toHaveBeenCalledOnce();
    expect(readOriginalOOPIFResult(postMessage.mock.calls[0]![0], nonce, allowed).outcome).toBe(
      allowed ? 'resolved' : 'rejected'
    );
  }
);
it.each([
  'http://owned.example/oopif-request/' + nonce,
  'https://owned.example/unrelated',
  'https://owned.example/oopif-request/' + nonce + '?secret=x',
])('refuses nonissued document request %s', (destination) => {
  expect(() => originalOOPIFDocument(nonce, destination)).toThrow(
    'ORIGINAL_OOPIF_DESTINATION_REQUIRED'
  );
});
it('wrong nonce, outcome and invented fields cannot qualify a frame message', () => {
  const result = { nonce, kind: 'original-sandbox-oopif', outcome: 'resolved' };
  expect(() => readOriginalOOPIFResult(result, nonce, false)).toThrow();
  expect(() =>
    readOriginalOOPIFResult(
      { ...result, nonce: 'ba71cdd8-4c56-41ec-8c62-9f540884fc88' },
      nonce,
      true
    )
  ).toThrow();
  expect(() => readOriginalOOPIFResult({ ...result, originalTarget: true }, nonce, true)).toThrow();
});

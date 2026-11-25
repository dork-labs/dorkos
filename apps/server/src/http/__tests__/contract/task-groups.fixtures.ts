/**
 * Stand-ins the task and runtime groups' contract cases use
 * (`task-groups.contract.test.ts`).
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in for Ollama's pull endpoint: two progress lines, then the error
 * Ollama gives for a model it cannot find.
 */
export async function startOllamaStub(): Promise<{ url: string; close: () => Promise<void> }> {
  const stub: Server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/api/pull') {
      res.writeHead(404).end();
      return;
    }
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.write('{"status":"pulling manifest"}\n');
    res.write('{"status":"downloading","completed":1,"total":2}\n');
    res.end('{"error":"pull model manifest: file does not exist"}\n');
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(stub.address() as AddressInfo).port}`,
    close: () => new Promise((resolve) => stub.close(() => resolve())),
  };
}

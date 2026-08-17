/**
 * The shim has to RUN, in every compile mode the server is started in.
 *
 * `DEVTOOLS_AGENT_SCRIPT` is a function turned into source with
 * `Function.prototype.toString()`, so whatever the compiler did to that function
 * ships to the browser verbatim. Under `tsx` (how `pnpm dev` runs the server)
 * esbuild's `keepNames` wraps every nested function declaration in a call to its
 * own `__name` helper — a helper that lives at module scope, never makes it into
 * the string, and does not exist in a browser. The shim threw `ReferenceError:
 * __name is not defined` on entry, its own `try/catch` swallowed it, and every
 * dev session ran with no console capture, no network capture and no
 * screenshots. Nothing said a word.
 *
 * String assertions on the source cannot see that class of bug: the source looks
 * perfect. Only running it does. So these tests load the emitted script into a
 * real document, inside a real iframe, and wait for the shim's `hello` to reach
 * the parent — once for the script as this test file's own compiler emits it,
 * and once for the script as `tsx` emits it. The second leg is the one that goes
 * red when a compiler helper leaks back in.
 */
import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { JSDOM } from 'jsdom';
import { DEVTOOLS_AGENT_SCRIPT, DEVTOOLS_SHIM_COMPILER_HELPERS } from '../devtools-shim.js';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Emit the shim exactly as `pnpm dev` would: load the module through `tsx` and
 * print the string it produced. Spawning the real tool (rather than
 * re-implementing its transform) is the point — the bug was in what the tool
 * does, so the tool has to be the one that answers.
 */
async function emitUnderTsx(): Promise<string> {
  const serverRoot = path.resolve(here, '../../../..');
  const tsxBin = path.join(serverRoot, 'node_modules/.bin/tsx');
  const printer = path.join(here, 'fixtures/print-devtools-shim.ts');
  const { stdout } = await execFileAsync(tsxBin, [printer], {
    cwd: serverRoot,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

/**
 * Run `script` inside an iframe of a real document and collect what it posts to
 * the parent.
 *
 * The iframe matters: the shim's first act is to check that it has a parent
 * distinct from itself, and does nothing at all in a top-level window. A test
 * that injected into the top document would pass while proving nothing.
 *
 * @param script - The emitted shim source.
 * @param timeoutMs - How long to wait for the handshake before giving up.
 * @returns The messages the shim posted, and whether it marked itself installed.
 */
async function runInPage(
  script: string,
  timeoutMs = 2_000
): Promise<{ messages: unknown[]; installed: boolean }> {
  const dom = new JSDOM('<!doctype html><html><body><iframe></iframe></body></html>', {
    runScripts: 'dangerously',
  });
  const { window } = dom;
  const messages: unknown[] = [];
  window.addEventListener('message', (ev: MessageEvent) => messages.push(ev.data));

  const frameEl = window.document.querySelector('iframe') as HTMLIFrameElement;
  const frame = frameEl.contentWindow as Window & { __dorkosDevtoolsInstalled?: boolean };
  const el = frame.document.createElement('script');
  el.textContent = script;
  frame.document.head.appendChild(el);

  const deadline = Date.now() + timeoutMs;
  while (messages.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const installed = frame.__dorkosDevtoolsInstalled === true;
  dom.window.close();
  return { messages, installed };
}

describe('DEVTOOLS_AGENT_SCRIPT runs in a real page', () => {
  it('installs and says hello, as this test file compiles it', async () => {
    const { messages, installed } = await runInPage(DEVTOOLS_AGENT_SCRIPT);
    expect(installed).toBe(true);
    expect(messages).toContainEqual({ __dorkosDevtools: 'hello' });
  });

  it('installs and says hello, as `tsx` compiles it (how `pnpm dev` runs)', async () => {
    const script = await emitUnderTsx();
    const { messages, installed } = await runInPage(script);
    expect(installed).toBe(true);
    expect(messages).toContainEqual({ __dorkosDevtools: 'hello' });
  }, 30_000);

  it('needs no compiler helper the emitted script does not define', async () => {
    const script = await emitUnderTsx();
    // Everything the shim names for itself starts `__dork`; `__PURE__` is an
    // esbuild annotation living inside a `/* */` comment, not a reference. What
    // is left is a helper the compiler expects from module scope, and module
    // scope is precisely what a stringified function leaves behind.
    const referenced = new Set(
      (script.match(/__[A-Za-z0-9_$]+/g) ?? []).filter(
        (name) => !name.startsWith('__dork') && name !== '__PURE__'
      )
    );
    expect([...referenced].sort()).toEqual([...DEVTOOLS_SHIM_COMPILER_HELPERS].sort());
  }, 30_000);
});

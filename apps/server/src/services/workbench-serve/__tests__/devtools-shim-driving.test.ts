/**
 * The driving half of the shim, executed rather than read.
 *
 * `devtools-shim.ts` and `devtools-driving.ts` are functions turned into source
 * with `Function.prototype.toString()` and injected into somebody else's page.
 * Reading that source and reasoning about it yields confident wrong conclusions
 * — the `__name` incident is the repo's standing example, where the source
 * looked perfect and every dev session ran with no shim at all. So every case
 * here loads the EMITTED script into a real document inside a real iframe, posts
 * it a real `act-request` with the parent as the message source, and reads the
 * `act-result` that comes back out.
 *
 * What jsdom cannot do, and what covers it: there is no layout engine, so every
 * `getBoundingClientRect()` is zero and `checkVisibility` does not exist. The
 * visibility fallback is written for exactly that and is asserted here on the
 * styles that hide things (`display:none`, `hidden`, `aria-hidden`); the real
 * `checkVisibility` path and anything that depends on pixels are covered by
 * `apps/e2e/tests/workbench/browser-driving.spec.ts` in a real browser.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { DEVTOOLS_AGENT_SCRIPT } from '../devtools-shim.js';

/** One message the shim posted to its parent. */
type ShimMessage = Record<string, unknown>;

/** A page with the shim installed, and the wires to drive it. */
interface DrivenPage {
  /** Deliver one `act-request` to the shim, as the parent window. */
  send: (message: Record<string, unknown>) => void;
  /** Every message the shim has posted to the parent so far. */
  messages: ShimMessage[];
  /** The framed document, for building fixtures and reading the aftermath. */
  document: Document;
  /** The framed window, for reaching its globals. */
  frame: Window & typeof globalThis;
  /** Wait until a predicate holds or the deadline passes. */
  until: (predicate: () => boolean, timeoutMs?: number) => Promise<void>;
  /** Wait for the `act-result` carrying one request id. */
  result: (requestId: string, timeoutMs?: number) => Promise<ShimMessage>;
  /** Tear the document down. */
  close: () => void;
}

/**
 * Install the emitted shim in an iframe of a real document and hand back the
 * wires to drive it.
 *
 * The iframe is not a detail: the shim's first act is to check that it has a
 * parent distinct from itself and to do nothing at all in a top-level window, so
 * a test that injected into the top document would pass while proving nothing.
 *
 * `postMessage` cannot be used to deliver the request — jsdom leaves
 * `event.source` null, and the shim's only guard is that the source IS the
 * parent — so the request is dispatched as a real `MessageEvent` carrying the
 * parent as its source. That is the same object the browser would hand it.
 *
 * A `<script>` assigned through `innerHTML` never runs — the HTML spec says so,
 * and jsdom obeys it — so page scripts are passed separately and appended as
 * real elements. Every one of the six commands was red on a fixture that put its
 * script in the markup, and green on nothing.
 *
 * @param html - The page body to drive.
 * @param script - Page JavaScript to run before the shim installs.
 */
function installShim(html: string, script?: string): DrivenPage {
  const dom = new JSDOM('<!doctype html><html><body><iframe></iframe></body></html>', {
    runScripts: 'dangerously',
    url: 'https://preview.dorkos.test/checkout',
  });
  const { window } = dom;
  const messages: ShimMessage[] = [];
  window.addEventListener('message', (ev: MessageEvent) => messages.push(ev.data as ShimMessage));

  const frameEl = window.document.querySelector('iframe') as HTMLIFrameElement;
  const frame = frameEl.contentWindow as unknown as Window & typeof globalThis;
  frame.document.title = 'Checkout — Acme';
  frame.document.body.innerHTML = html;
  if (script) {
    const pageScript = frame.document.createElement('script');
    pageScript.textContent = script;
    frame.document.body.appendChild(pageScript);
  }
  const el = frame.document.createElement('script');
  el.textContent = DEVTOOLS_AGENT_SCRIPT;
  frame.document.head.appendChild(el);

  const until = async (predicate: () => boolean, timeoutMs = 3_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };

  return {
    messages,
    document: frame.document,
    frame,
    until,
    send: (message) => {
      const MessageEventCtor = (frame as unknown as { MessageEvent: typeof MessageEvent })
        .MessageEvent;
      frame.dispatchEvent(
        new MessageEventCtor('message', { data: message, source: window as never, origin: 'null' })
      );
    },
    result: async (requestId, timeoutMs = 3_000) => {
      const find = (): ShimMessage | undefined =>
        messages.find(
          (message) => message.__dorkosDevtools === 'act-result' && message.requestId === requestId
        );
      await until(() => find() !== undefined, timeoutMs);
      const found = find();
      expect(found, `no act-result arrived for ${requestId}`).toBeDefined();
      return found!;
    },
    close: () => dom.window.close(),
  };
}

/** Drive one command through a fresh page and hand back its single result. */
async function drive(
  html: string,
  command: Record<string, unknown>,
  requestId = 'r1',
  script?: string
): Promise<{ result: ShimMessage; page: DrivenPage }> {
  const page = installShim(html, script);
  page.send({ __dorkosDevtools: 'act-request', requestId, documentId: 'doc-1', command });
  const result = await page.result(requestId);
  return { result, page };
}

const CHECKOUT = `
  <header><a href="/">Acme</a><nav><a href="/products">Products</a></nav></header>
  <main>
    <h1>Checkout</h1>
    <form aria-label="Payment">
      <label for="card">Card number</label><input id="card" />
      <button type="button" id="pay">Pay $42.00</button>
      <button type="button" disabled>Refund</button>
    </form>
    <div id="out"></div>
  </main>
  <div role="status">Your card was declined.</div>
`;

describe('the shim drives the page it was injected into', () => {
  it('clicks a button by role and accessible name, and says what it clicked', async () => {
    const { result, page } = await drive(
      CHECKOUT,
      { action: 'click', target: { role: 'button', name: 'Pay $42.00' } },
      'r1',
      `document.getElementById('pay').addEventListener('click', function(){
        document.getElementById('out').textContent = 'Paid';
      });`
    );
    expect(result.ok).toBe(true);
    expect(result.matched).toBe(1);
    expect(result.did).toBe('Clicked button "Pay $42.00".');
    expect(result.documentId).toBe('doc-1');
    expect((result.page as { title: string; url: string }).title).toBe('Checkout — Acme');
    expect(page.document.getElementById('out')?.textContent).toBe('Paid');
    page.close();
  });

  it('clicks by visible text, picking the element the text is actually on', async () => {
    const { result, page } = await drive(CHECKOUT, {
      action: 'click',
      target: { text: 'Products' },
    });
    expect(result.ok).toBe(true);
    // The deepest match, never <main> or <body>, both of which "contain" it.
    expect(result.did).toBe('Clicked link "Products".');
    page.close();
  });

  it('clicks by CSS selector when nothing else names the thing', async () => {
    const { result, page } = await drive(CHECKOUT, {
      action: 'click',
      target: { selector: '#pay' },
    });
    expect(result.ok).toBe(true);
    expect(result.did).toContain('Pay $42.00');
    page.close();
  });

  it('refuses rather than guessing when several things match and no nth was given', async () => {
    const { result, page } = await drive(
      `<button>Delete</button><button>Delete</button><button>Delete</button>`,
      { action: 'click', target: { role: 'button', name: 'Delete' } }
    );
    expect(result.ok).toBe(false);
    expect(result.matched).toBe(3);
    expect(result.error).toBe(
      '3 things matched a button named "Delete". Pass nth to pick one, or name it more exactly.'
    );
    page.close();
  });

  it('acts on the nth match when one is named', async () => {
    const { result, page } = await drive(
      `<button onclick="this.textContent='first'">Delete</button>
       <button onclick="this.textContent='second'">Delete</button>`,
      { action: 'click', target: { role: 'button', name: 'Delete', nth: 1 } }
    );
    expect(result.ok).toBe(true);
    expect(page.document.querySelectorAll('button')[1].textContent).toBe('second');
    page.close();
  });

  it('names the tool that would show what is there when nothing matched', async () => {
    const { result, page } = await drive(CHECKOUT, {
      action: 'click',
      target: { role: 'button', name: 'Ship it' },
    });
    expect(result.ok).toBe(false);
    expect(result.matched).toBe(0);
    expect(result.error).toContain('browser_read_page');
    page.close();
  });

  it('says a disabled element would do nothing rather than reporting a click', async () => {
    const { result, page } = await drive(CHECKOUT, {
      action: 'click',
      target: { role: 'button', name: 'Refund' },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      'That matched a <button> that is disabled, so the click would do nothing.'
    );
    page.close();
  });

  it('skips what a person cannot see, without reading a rect jsdom has no engine for', async () => {
    const { result, page } = await drive(
      `<button style="display:none">Save</button><button>Save</button>`,
      { action: 'click', target: { role: 'button', name: 'Save' } }
    );
    // One visible match, so no refusal — the hidden one is not a rival.
    expect(result.ok).toBe(true);
    expect(result.matched).toBe(1);
    page.close();
  });

  it('types into a field and fires the events a framework listens for', async () => {
    const { result, page } = await drive(
      CHECKOUT,
      {
        action: 'type',
        target: { role: 'textbox', name: 'Card number' },
        text: '4242',
        clear: true,
      },
      'r1',
      `document.getElementById('card').addEventListener('input', function(e){
        document.getElementById('out').textContent = 'saw:' + e.target.value;
      });`
    );
    expect(result.ok).toBe(true);
    expect(result.did).toBe('Typed "4242" into textbox "Card number".');
    expect((page.document.getElementById('card') as HTMLInputElement).value).toBe('4242');
    expect(page.document.getElementById('out')?.textContent).toBe('saw:4242');
    page.close();
  });

  it('types into whatever has focus when no field is named', async () => {
    const page = installShim(CHECKOUT);
    (page.document.getElementById('card') as HTMLInputElement).focus();
    page.send({
      __dorkosDevtools: 'act-request',
      requestId: 'focus-1',
      documentId: 'doc-1',
      command: { action: 'type', text: 'hello' },
    });
    const result = await page.result('focus-1');
    expect(result.ok).toBe(true);
    expect((page.document.getElementById('card') as HTMLInputElement).value).toBe('hello');
    page.close();
  });

  it('refuses to type into something that is not a field', async () => {
    const { result, page } = await drive(CHECKOUT, {
      action: 'type',
      target: { role: 'heading', name: 'Checkout' },
      text: 'nope',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not something you can type into');
    page.close();
  });

  it('presses a key, chord and all, at whatever has focus', async () => {
    const page = installShim(
      CHECKOUT,
      `document.getElementById('card').addEventListener('keydown', function(e){
        document.getElementById('out').textContent = e.key + ':' + e.ctrlKey;
      });`
    );
    (page.document.getElementById('card') as HTMLInputElement).focus();
    page.send({
      __dorkosDevtools: 'act-request',
      requestId: 'press-1',
      documentId: 'doc-1',
      command: { action: 'press', key: 'Control+a' },
    });
    const result = await page.result('press-1');
    expect(result.ok).toBe(true);
    expect(result.did).toBe('Pressed Control+a.');
    expect(page.document.getElementById('out')?.textContent).toBe('a:true');
    page.close();
  });

  it('scrolls to an element and names it', async () => {
    const page = installShim(CHECKOUT);
    // jsdom has no layout, so it ships no `scrollIntoView`; the shim guards on
    // that rather than throwing, and a real browser is covered in `apps/e2e`.
    (page.document.getElementById('pay') as HTMLElement).scrollIntoView = () => {};
    page.send({
      __dorkosDevtools: 'act-request',
      requestId: 'scroll-1',
      documentId: 'doc-1',
      command: { action: 'scroll', target: { selector: '#pay' } },
    });
    const result = await page.result('scroll-1');
    expect(result.ok).toBe(true);
    expect(result.did).toBe('Scrolled to button "Pay $42.00".');
    page.close();
  });

  it('scrolls by an amount when no element is named', async () => {
    const { result, page } = await drive(CHECKOUT, { action: 'scroll', by: 400 });
    expect(result.ok).toBe(true);
    expect(result.did).toBe('Scrolled 400px down.');
    page.close();
  });

  it('waits for text to appear and reports how long it took', async () => {
    const page = installShim(
      CHECKOUT,
      `setTimeout(function(){
        document.getElementById('out').textContent = 'Order confirmed';
      }, 120);`
    );
    page.send({
      __dorkosDevtools: 'act-request',
      requestId: 'wait-1',
      documentId: 'doc-1',
      command: { action: 'wait_for', text: 'Order confirmed', timeoutMs: 3_000 },
    });
    const result = await page.result('wait-1');
    expect(result.ok).toBe(true);
    expect(result.did).toContain('Order confirmed');
    expect(result.waitedMs as number).toBeGreaterThanOrEqual(100);
    page.close();
  });

  it('answers a wait that never happens with a plain sentence, not a hang', async () => {
    const { result, page } = await drive(CHECKOUT, {
      action: 'wait_for',
      text: 'never going to be here',
      timeoutMs: 200,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      'Waited 200ms for the text: "never going to be here" and it never happened.'
    );
    page.close();
  });

  it('posts exactly one result per requestId, however many times it is asked', async () => {
    const page = installShim(CHECKOUT);
    const request = {
      __dorkosDevtools: 'act-request',
      requestId: 'once-1',
      documentId: 'doc-1',
      command: { action: 'read_page', maxChars: 4_000 },
    };
    page.send(request);
    await page.result('once-1');
    // A second ask under the SAME id is a second request as far as the shim is
    // concerned — what must never happen is one request answering twice, which
    // is what the settle path's one-shot guard is for. Asserted on the click
    // path, which is the one that can answer from two places.
    const clickPage = installShim(CHECKOUT);
    clickPage.send({
      __dorkosDevtools: 'act-request',
      requestId: 'once-2',
      documentId: 'doc-1',
      command: { action: 'click', target: { selector: '#pay' } },
    });
    await clickPage.result('once-2');
    clickPage.frame.dispatchEvent(new clickPage.frame.Event('pagehide'));
    await clickPage.until(() => false, 250);
    const answers = clickPage.messages.filter(
      (message) => message.__dorkosDevtools === 'act-result' && message.requestId === 'once-2'
    );
    expect(answers).toHaveLength(1);
    page.close();
    clickPage.close();
  });

  it('ignores a request that did not come from the parent window', async () => {
    const page = installShim(CHECKOUT);
    // Same message, posted by the frame to itself: source identity is the only
    // guard that means anything when every opaque frame reports origin "null".
    const MessageEventCtor = (page.frame as unknown as { MessageEvent: typeof MessageEvent })
      .MessageEvent;
    page.frame.dispatchEvent(
      new MessageEventCtor('message', {
        data: {
          __dorkosDevtools: 'act-request',
          requestId: 'spoof-1',
          command: { action: 'click', target: { selector: '#pay' } },
        },
        source: page.frame as never,
        origin: 'null',
      })
    );
    await page.until(() => false, 250);
    expect(
      page.messages.filter((message) => message.__dorkosDevtools === 'act-result')
    ).toHaveLength(0);
    page.close();
  });
});

describe('browser_read_page returns an outline of what is on the page', () => {
  it('prints role, name and state, indented by depth', async () => {
    const { result, page } = await drive(CHECKOUT, { action: 'read_page', maxChars: 8_000 });
    expect(result.ok).toBe(true);
    const outline = result.outline as string;
    expect(outline.split('\n')[0]).toBe('document "Checkout — Acme"');
    expect(outline).toContain('banner');
    // A landmark is named by what somebody CALLED it, never by everything
    // inside it: `<header>` and `<main>` carry no aria-label here, so they
    // print bare rather than repeating the page.
    expect(outline).toContain('\n  banner\n');
    expect(outline).toMatch(/\n {2}main\n/);
    expect(outline).toContain('link "Acme"');
    expect(outline).toContain('navigation');
    expect(outline).toContain('heading "Checkout" level=1');
    expect(outline).toContain('form "Payment"');
    expect(outline).toContain('textbox "Card number"');
    expect(outline).toContain('button "Pay $42.00"');
    expect(outline).toContain('button "Refund" [disabled]');
    expect(outline).toContain('status "Your card was declined." [live]');
    expect(result.truncated).toBe(false);
    page.close();
  });

  it('drops a node with no name, no landmark role and nothing under it', async () => {
    const { result, page } = await drive(`<span></span><p>   </p><button>Go</button>`, {
      action: 'read_page',
      maxChars: 8_000,
    });
    const lines = (result.outline as string).split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1].trim()).toBe('button "Go"');
    page.close();
  });

  it('never walks into a hidden subtree', async () => {
    const { result, page } = await drive(
      `<div hidden><button>Secret</button></div><button>Visible</button>`,
      { action: 'read_page', maxChars: 8_000 }
    );
    expect(result.outline).not.toContain('Secret');
    expect(result.outline).toContain('Visible');
    page.close();
  });

  it('truncates the deepest lines first and says that it did', async () => {
    const deep = Array.from(
      { length: 40 },
      (_, i) => `<section aria-label="Section ${i}"><button>Leaf ${i}</button></section>`
    ).join('');
    const { result, page } = await drive(deep, { action: 'read_page', maxChars: 400 });
    expect(result.truncated).toBe(true);
    const outline = result.outline as string;
    expect(outline.length).toBeLessThanOrEqual(400);
    // Structure survives, leaves are what is lost.
    expect(outline).toContain('region "Section 0"');
    expect(outline).not.toContain('Leaf 39');
    page.close();
  });

  it('reads one subtree when a selector names it', async () => {
    const { result, page } = await drive(CHECKOUT, {
      action: 'read_page',
      selector: 'form',
      maxChars: 8_000,
    });
    expect(result.outline).toContain('textbox "Card number"');
    expect(result.outline).not.toContain('link "Acme"');
    page.close();
  });

  it('says so when the selector matched nothing, rather than reading the whole page', async () => {
    const { result, page } = await drive(CHECKOUT, {
      action: 'read_page',
      selector: '#nope',
      maxChars: 8_000,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('#nope');
    page.close();
  });
});

describe('fetchIdle waits on the counter the shim keeps, in both branches', () => {
  /** A page whose `fetch` resolves or rejects on command. */
  const CONTROLLED_HTML = `<button id="go">Go</button>`;
  const CONTROLLED_SCRIPT = `
    window.__settle = null;
    window.__mode = 'resolve';
    window.fetch = function () {
      return new Promise(function (resolve, reject) {
        window.__settle = function () {
          if (window.__mode === 'resolve') {
            resolve({ status: 200, ok: true, headers: { get: function(){ return null; } } });
          } else {
            reject(new Error('boom'));
          }
        };
      });
    };`;

  it('does not return while a fetch is pending, and returns ~500ms after it settles', async () => {
    const page = installShim(CONTROLLED_HTML, CONTROLLED_SCRIPT);
    const frame = page.frame as unknown as {
      fetch: (url: string) => Promise<unknown>;
      __settle: () => void;
    };
    void frame.fetch('/thing').catch(() => {});
    page.send({
      __dorkosDevtools: 'act-request',
      requestId: 'idle-1',
      documentId: 'doc-1',
      command: { action: 'wait_for', fetchIdle: true, timeoutMs: 5_000 },
    });
    // 400ms in, with the request still open, nothing has answered.
    await page.until(() => false, 400);
    expect(page.messages.filter((message) => message.requestId === 'idle-1')).toHaveLength(0);

    frame.__settle();
    const result = await page.result('idle-1', 4_000);
    expect(result.ok).toBe(true);
    // The 500ms quiet window is the whole definition of the mode.
    expect(result.waitedMs as number).toBeGreaterThanOrEqual(500);
    page.close();
  });

  it('returns just as promptly after a fetch that REJECTED', async () => {
    // The decrement in the failure branch is the half that gets forgotten, and
    // forgetting it wedges every later wait for the life of the page. With the
    // decrement missing this case times out; the success case above still passes.
    const page = installShim(CONTROLLED_HTML, CONTROLLED_SCRIPT);
    const frame = page.frame as unknown as {
      fetch: (url: string) => Promise<unknown>;
      __settle: () => void;
      __mode: string;
    };
    frame.__mode = 'reject';
    void frame.fetch('/thing').catch(() => {});
    frame.__settle();
    page.send({
      __dorkosDevtools: 'act-request',
      requestId: 'idle-2',
      documentId: 'doc-1',
      command: { action: 'wait_for', fetchIdle: true, timeoutMs: 3_000 },
    });
    const result = await page.result('idle-2', 4_000);
    expect(result.ok).toBe(true);
    page.close();
  });

  it('gives the count back when an XHR fails, not only when it loads', async () => {
    const page = installShim(`<div>xhr</div>`);
    const frame = page.frame as unknown as { XMLHttpRequest: typeof XMLHttpRequest };
    const xhr = new frame.XMLHttpRequest();
    xhr.open('GET', 'https://nowhere.invalid/thing');
    xhr.send();
    // `loadend` fires for an error exactly as it does for a load, which is why
    // one listener is the whole settle path.
    await page.until(() => false, 300);
    page.send({
      __dorkosDevtools: 'act-request',
      requestId: 'idle-3',
      documentId: 'doc-1',
      command: { action: 'wait_for', fetchIdle: true, timeoutMs: 4_000 },
    });
    const result = await page.result('idle-3', 5_000);
    expect(result.ok).toBe(true);
    page.close();
  });
});

describe('the shim never reaches the API', () => {
  it('carries no `/api` reference in the emitted source, driving included', () => {
    // The frame has an opaque origin and no credential, and both halves of the
    // shim keep it that way by talking only to `window.parent`. A test that
    // tries: there is nothing here to try WITH.
    expect(DEVTOOLS_AGENT_SCRIPT).not.toContain('/api');
    expect(DEVTOOLS_AGENT_SCRIPT).not.toContain('XMLHttpRequest()');
    // `postMessage` to the parent is the only outbound call the source makes.
    expect(DEVTOOLS_AGENT_SCRIPT).toContain('parent.postMessage');
  });
});

import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import { installWindowPolicy } from '../chat/window-policy.js';

const documents: JSDOM[] = [];
afterEach(() => documents.splice(0).forEach((dom) => dom.window.close()));
function fixture(taken: boolean, active: boolean, compiled?: string) {
  const dom = new JSDOM(
    '<!doctype html><form target="_blank"><button formtarget="named-popup">Sign in</button></form>',
    { url: 'https://made-up.example/', runScripts: 'outside-only' }
  );
  documents.push(dom);
  const open = vi.fn(() => null);
  const submit = vi.fn();
  const requestSubmit = vi.fn();
  const report = vi.fn();
  Object.assign(dom.window, { open, report });
  dom.window.HTMLFormElement.prototype.submit = submit;
  dom.window.HTMLFormElement.prototype.requestSubmit = requestSubmit;
  Object.defineProperty(dom.window.navigator, 'userActivation', { value: { isActive: active } });
  const listen = vi.spyOn(dom.window.document, 'addEventListener');
  dom.window.eval(
    `(${compiled ?? installWindowPolicy.toString()})({control:'control',report:'report'})`
  );
  dom.window.eval(`window.control(${taken})`);
  const form = dom.window.document.querySelector('form')!;
  const button = dom.window.document.querySelector('button')!;
  return {
    window: dom.window,
    form,
    button,
    open,
    submit,
    requestSubmit,
    report,
    personInput() {
      // Stub the trusted browser-input edge. The deferred Chrome positive control uses a real click.
      const listener = listen.mock.calls.find(
        ([type]) => type === 'pointerup'
      )?.[1] as EventListener;
      listener({ isTrusted: true } as Event);
    },
  };
}

it.each([
  [false, true],
  [false, false],
  [true, false],
])('blocks window.open and direct form.submit with taken=%s activation=%s', (taken, active) => {
  const f = fixture(taken!, active!);
  expect(f.window.open('https://login.made-up.example/')).toBeNull();
  f.form.submit();
  expect(f.open).not.toHaveBeenCalled();
  expect(f.form.target).toBe('_self');
  expect(f.submit).toHaveBeenCalledOnce();
  expect(f.report).toHaveBeenCalledTimes(2);
});

it.each(['requestSubmit', 'submit-event', 'button-click'] as const)(
  'retargets submitter overrides before a popup can be created through %s',
  (path) => {
    const f = fixture(true, false);
    if (path === 'requestSubmit') f.form.requestSubmit(f.button);
    if (path === 'submit-event')
      f.form.dispatchEvent(
        new f.window.SubmitEvent('submit', { bubbles: true, submitter: f.button })
      );
    if (path === 'button-click') {
      f.button.addEventListener('click', (event) => event.preventDefault());
      f.button.dispatchEvent(new f.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    }
    expect(f.button.formTarget).toBe('_self');
    expect(f.report).toHaveBeenCalledOnce();
  }
);

it('honors base targets and named link targets without opening another browsing context', () => {
  const f = fixture(false, true);
  f.form.removeAttribute('target');
  f.window.document.head.innerHTML = '<base target="_blank">';
  f.form.submit();
  expect(f.form.target).toBe('_self');
  const link = f.window.document.createElement('a');
  link.href = '/sign-in';
  link.target = 'sign-in';
  f.window.document.body.append(link);
  link.addEventListener('click', (event) => event.preventDefault());
  link.dispatchEvent(new f.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  expect(link.target).toBe('_self');
});

it('allows an activated person to open a popup only in the taken state', () => {
  const f = fixture(true, true);
  f.personInput();
  f.window.open('https://login.made-up.example/');
  f.form.submit();
  f.form.requestSubmit(f.button);
  expect(f.open).toHaveBeenCalledOnce();
  expect(f.form.target).toBe('_blank');
  expect(f.button.formTarget).toBe('named-popup');
  expect(f.report).not.toHaveBeenCalled();
});

it('serializes all guard paths through the CLI keepNames build and installs idempotently', async () => {
  const { transformSync } = await import('esbuild');
  const { runInNewContext } = await import('node:vm');
  const host: { install?: typeof installWindowPolicy } = {};
  runInNewContext(
    transformSync(`globalThis.install = ${installWindowPolicy.toString()}`, {
      keepNames: true,
      target: 'es2022',
    }).code,
    host
  );
  const f = fixture(true, false, host.install!.toString());
  f.window.eval(`(${host.install!.toString()})({control:'control',report:'report'})`);
  f.form.requestSubmit(f.button);
  f.form.submit();
  f.window.open('/blocked');
  expect(f.report).toHaveBeenCalledTimes(3);
});

it('leaves a form target alone when a checkbox or reset button is clicked', () => {
  const f = fixture(false, false);
  for (const control of ['<input type="checkbox">', '<button type="reset">Reset</button>']) {
    f.form.insertAdjacentHTML('beforeend', control);
    f.form.lastElementChild!.dispatchEvent(
      new f.window.MouseEvent('click', { bubbles: true, cancelable: true })
    );
    expect(f.form.target).toBe('_blank');
  }
  expect(f.report).not.toHaveBeenCalled();
});

it('does not mistake pre-takeover activation or a synthetic click for person input', () => {
  const f = fixture(false, true);
  f.personInput();
  f.window.eval('window.control(true)');
  f.button.dispatchEvent(new f.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  f.window.open('/blocked');
  expect(f.open).not.toHaveBeenCalled();
});

it('clears person-input admission when a held tab returns and is taken again', () => {
  const f = fixture(true, true);
  f.personInput();
  f.window.open('/allowed');
  f.window.eval('window.control(false);window.control(true)');
  f.window.open('/blocked');
  expect(f.open).toHaveBeenCalledOnce();
});

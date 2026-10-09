import { BrowserLifecycleError } from '../lifecycle/errors.js';

/** Constructor-owned single request, never a public destination grant. */
export interface PrivateProxyAuthenticationWarmup {
  readonly url: string;
  confirm(): Promise<void>;
}

interface OriginalWarmupResponse {
  status(): number;
  url(): string;
  request(): { redirectedFrom(): unknown };
}
interface OriginalWarmupPage {
  goto(url: string, options: { waitUntil: 'load' }): Promise<OriginalWarmupResponse | null>;
  close(): Promise<void>;
}

/** Own one original private Page without adding it to the ordinary tab registry. */
export function ownPrivateProxyWarmupPage(
  page: OriginalWarmupPage,
  current: () => boolean,
  retain: <T>(enter: () => T | PromiseLike<T>) => Promise<T>
) {
  const goto = page.goto;
  const closePage = page.close;
  let closing: Promise<void> | undefined;
  let started = false;
  const check = () => {
    if (closing || !current()) throw new BrowserLifecycleError('ENGINE_STOPPED');
  };
  const close = () => {
    if (closing) return closing;
    let resolve!: () => void;
    let reject!: (value: unknown) => void;
    closing = new Promise<void>((done, failed) => {
      resolve = done;
      reject = failed;
    });
    void closing.catch(() => {});
    try {
      retain(() => Reflect.apply(closePage, page, []) as Promise<void>).then(resolve, reject);
    } catch (value) {
      reject(value);
    }
    return closing;
  };
  const run = async (capability: PrivateProxyAuthenticationWarmup) => {
    if (started) throw new BrowserLifecycleError('NETWORK_POLICY_UNSUPPORTED');
    started = true;
    let first: { value: unknown } | undefined;
    try {
      check();
      const url = capability.url;
      const confirm = capability.confirm;
      const response = await retain(() => {
        check();
        return Reflect.apply(goto, page, [
          url,
          { waitUntil: 'load' },
        ]) as Promise<OriginalWarmupResponse | null>;
      });
      check();
      if (
        !response ||
        response.status() !== 200 ||
        response.url() !== url ||
        response.request().redirectedFrom() !== null
      )
        throw new BrowserLifecycleError('NETWORK_POLICY_UNSUPPORTED');
      await retain(() => {
        check();
        return Reflect.apply(confirm, capability, []) as Promise<void>;
      });
      check();
    } catch (value) {
      first = { value };
    }
    try {
      await close();
    } catch (value) {
      first ??= { value };
    }
    if (first) throw first.value;
  };
  return Object.freeze({ page, run, close });
}

import { z } from 'zod';

const Nonce = z.string().uuid();
const Result = z
  .object({
    nonce: Nonce,
    kind: z.literal('original-sandbox-oopif'),
    outcome: z.enum(['resolved', 'rejected']),
  })
  .strict();

/** Serve an ordinary origin-restricted sandbox frame whose own script issues the original request. */
export function originalOOPIFDocument(nonce: string, destination: string): string {
  Nonce.parse(nonce);
  const url = new URL(destination);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(
      url.pathname === '/oopif-request/' + nonce ||
      url.pathname === '/forbidden/' + nonce + '/oopif'
    )
  )
    throw new Error('ORIGINAL_OOPIF_DESTINATION_REQUIRED');
  const data = JSON.stringify({ nonce, destination: url.href }).replaceAll('<', '\\u003c');
  return `<!doctype html><meta charset="utf-8"><script>
const original=${data};
fetch(original.destination,{mode:'no-cors',credentials:'omit',cache:'no-store'}).then(
()=>parent.postMessage({nonce:original.nonce,kind:'original-sandbox-oopif',outcome:'resolved'},'*'),
()=>parent.postMessage({nonce:original.nonce,kind:'original-sandbox-oopif',outcome:'rejected'},'*'));
</script>`;
}

/** Decode only the actual iframe message; origin/session/upstream proofs remain independent required oracles. */
export function readOriginalOOPIFResult(value: unknown, nonce: string, allowed: boolean) {
  Nonce.parse(nonce);
  const result = Result.parse(value);
  if (result.nonce !== nonce || result.outcome !== (allowed ? 'resolved' : 'rejected'))
    throw new Error('ORIGINAL_OOPIF_REQUEST_REFUSED');
  return Object.freeze(result);
}

/** Run through genuine DOM iframe navigation; keep the frame live until independent target/session proof is read. */
export function installOriginalSandboxFrame(options: { url: string; nonce: string }) {
  return new Promise<unknown>((resolve, reject) => {
    if (document.querySelector('[data-original-oopif]')) {
      reject(new Error('ORIGINAL_OOPIF_ALREADY_INSTALLED'));
      return;
    }
    const frame = document.createElement('iframe');
    frame.dataset.originalOopif = options.nonce;
    frame.sandbox.add('allow-scripts');
    const receive = (event: MessageEvent) => {
      if (
        event.source !== frame.contentWindow ||
        event.origin !== 'null' ||
        !event.data ||
        event.data.nonce !== options.nonce
      )
        return;
      window.removeEventListener('message', receive);
      frame.removeEventListener('error', refuse);
      resolve(event.data);
    };
    const refuse = () => {
      window.removeEventListener('message', receive);
      frame.removeEventListener('error', refuse);
      reject(new Error('ORIGINAL_OOPIF_DOCUMENT_REFUSED'));
    };
    window.addEventListener('message', receive);
    frame.addEventListener('error', refuse, { once: true });
    frame.src = options.url;
    document.body.append(frame);
  });
}

/** Remove only the issued exact DOM frame after its observed target/request oracles have completed. */
export function removeOriginalSandboxFrame(nonce: string) {
  const frames = [
    ...document.querySelectorAll<HTMLIFrameElement>('iframe[data-original-oopif]'),
  ].filter((frame) => frame.dataset.originalOopif === nonce);
  if (frames.length !== 1) throw new Error('ORIGINAL_OOPIF_DOCUMENT_REQUIRED');
  frames[0]!.remove();
}

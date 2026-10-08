/** Ordinary worker event producer; the browser's registration.update owns the update request. */
export function originalBackgroundWorkerScript(options: {
  nonce: string;
  allowedOrigin: string;
  deniedOrigin: string;
}) {
  const nonce = options.nonce;
  if (!/^[a-f0-9-]{36}$/.test(nonce)) throw new Error('BACKGROUND_NONCE_REFUSED');
  const origins = [options.allowedOrigin, options.deniedOrigin];
  for (const origin of origins) {
    const parsed = new URL(origin);
    if (
      parsed.protocol !== 'https:' ||
      parsed.origin !== origin ||
      parsed.username ||
      parsed.password
    )
      throw new Error('BACKGROUND_OWNED_ORIGIN_REQUIRED');
  }
  if (origins[0] === origins[1]) throw new Error('BACKGROUND_DISTINCT_ORIGINS_REQUIRED');
  const urls = Object.freeze({
    script: origins[0] + '/background-worker/' + nonce + '.js',
    gate: origins[0] + '/background-gate/' + nonce,
    allowed: origins[0] + '/background-positive/' + nonce,
    denied: origins[1] + '/forbidden/' + nonce + '/background',
    report: origins[0] + '/background-completed/' + nonce,
  });
  const source = `
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
let started = false;
self.addEventListener('message', event => {
  if (event.data !== ${JSON.stringify(nonce)} || started) return;
  started = true;
  event.waitUntil((async () => {
    const gate = await fetch(${JSON.stringify(urls.gate)}, { cache: 'no-store' });
    if (!gate.ok) throw new Error('BACKGROUND_GATE_REFUSED');
    await gate.text();
    const positive = await fetch(${JSON.stringify(urls.allowed)}, { cache: 'no-store' });
    if (!positive.ok) throw new Error('BACKGROUND_POSITIVE_REFUSED');
    await positive.text();
    let denied = false;
    try { await fetch(${JSON.stringify(urls.denied)}, { mode: 'no-cors', cache: 'no-store' }); }
    catch { denied = true; }
    
    await self.registration.update();
    const completed = await fetch(${JSON.stringify(urls.report)} + (denied ? '/denied' : '/accepted'), { cache: 'no-store' });
    if (!completed.ok) throw new Error('BACKGROUND_COMPLETION_REFUSED');
    await completed.text();
  })());
});
`;
  return Object.freeze({ urls, source });
}

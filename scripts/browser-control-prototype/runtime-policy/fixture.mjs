import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, X509Certificate } from 'node:crypto';

/** Create two private HTTPS origins with one fake SAN certificate and exact SPKI-only fixture trust. */
export async function startIdentityFixture(privateDir) {
  const key = join(privateDir, 'fixture-key.pem');
  const cert = join(privateDir, 'fixture-cert.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { stdio: 'ignore', timeout: 5000 }
  );
  const pem = await readFile(cert);
  const spki = new X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' });
  const spkiHash = createHash('sha256').update(spki).digest('base64');
  const requests = [];
  const servers = [];
  const close = async () => {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  };
  try {
    for (let index = 0; index < 2; index++) {
      const server = https.createServer(
        { key: await readFile(key), cert: pem },
        (request, response) => {
          requests.push({
            origin: index,
            path: request.url,
            at: Date.now(),
            headers: request.headers,
          });
          response.setHeader(
            'Accept-CH',
            'Sec-CH-UA-Full-Version-List, Sec-CH-UA-Arch, Sec-CH-UA-Bitness, Sec-CH-UA-Platform-Version, Sec-CH-UA-Model, Sec-CH-UA-WoW64, Sec-CH-UA-Form-Factors'
          );
          response.setHeader('Cache-Control', 'no-store');
          if (request.url.startsWith('/identity-worker-')) {
            const type = request.url.split('-').at(-1);
            response.setHeader('Content-Type', 'application/javascript');
            const identity = `async function readIdentity() { return { ua: navigator.userAgent, appVersion: navigator.appVersion, platform: navigator.platform, secure: self.isSecureContext, metadata: await navigator.userAgentData.getHighEntropyValues(['architecture','bitness','fullVersionList','model','platformVersion','uaFullVersion','wow64','formFactors']) }; }`;
            const work = `await fetch('/worker-fetch-${type}');`;
            const source =
              type === 'shared'
                ? `onconnect = async (event) => { ${work} event.ports[0].postMessage(await readIdentity()); };`
                : type === 'service'
                  ? `oninstall = () => self.skipWaiting(); onactivate = (event) => event.waitUntil(self.clients.claim()); onmessage = async (event) => { ${work} event.ports[0].postMessage(await readIdentity()); };`
                  : `(async () => { ${work} postMessage(await readIdentity()); })();`;
            response.end(identity + source);
            return;
          }
          response.setHeader('Content-Type', 'text/html');
          response.end(
            '<!doctype html><title>Owned identity fixture</title><p>Fictitious local identity probe</p>'
          );
        }
      );
      servers.push(server);
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
    }
    return {
      urls: servers.map((server) => `https://127.0.0.1:${server.address().port}`),
      requests,
      spkiHash,
      certSha256: createHash('sha256').update(pem).digest('hex'),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

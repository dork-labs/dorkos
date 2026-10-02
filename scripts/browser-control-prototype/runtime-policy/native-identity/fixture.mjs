import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { readFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, X509Certificate } from 'node:crypto';

const identitySource = `async function readIdentity() { return { ua: navigator.userAgent, appVersion: navigator.appVersion, platform: navigator.platform, secure: self.isSecureContext, metadata: await navigator.userAgentData.getHighEntropyValues(['architecture','bitness','fullVersionList','model','platformVersion','uaFullVersion','wow64','formFactors']) }; }`;
/** Serve two distinct fictitious sites; trust only their generated certificate key inside this runtime. */
export async function startNativeFixture(privateDir, { delegateHints = true } = {}) {
  const key = join(privateDir, 'native-key.pem');
  const cert = join(privateDir, 'native-cert.pem');
  const hosts = ['native-a.test', 'native-b.test'];
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
      '/CN=native-a.test',
      '-addext',
      'subjectAltName=DNS:native-a.test,DNS:native-b.test',
    ],
    { stdio: 'ignore', timeout: 5000 }
  );
  await chmod(key, 0o600);
  const pem = await readFile(cert);
  const spkiHash = createHash('sha256')
    .update(new X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' }))
    .digest('base64');
  const requests = [];
  const servers = [];
  let urls;
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
          if (request.headers.host?.split(':')[0] !== hosts[index]) {
            response.writeHead(403);
            response.end();
            return;
          }
          requests.push({
            site: index,
            path: request.url,
            at: Date.now(),
            headers: request.headers,
          });
          response.setHeader(
            'Accept-CH',
            'Sec-CH-UA-Full-Version-List, Sec-CH-UA-Arch, Sec-CH-UA-Bitness, Sec-CH-UA-Platform-Version, Sec-CH-UA-Model, Sec-CH-UA-WoW64, Sec-CH-UA-Form-Factors'
          );
          response.setHeader('Cache-Control', 'no-store');
          if (delegateHints)
            response.setHeader(
              'Permissions-Policy',
              [
                'arch',
                'bitness',
                'full-version-list',
                'platform-version',
                'model',
                'wow64',
                'form-factors',
              ]
                .map((name) => `ch-ua-${name}=(self "${urls[0]}" "${urls[1]}")`)
                .join(', ')
            );
          const path = new URL(request.url, urls[index]).pathname;
          if (path.startsWith('/worker-')) {
            const type = path.slice('/worker-'.length);
            const fetch = `await fetch('/fetch-${type}');`;
            const source =
              type === 'shared'
                ? `onconnect = async (event) => { ${fetch} event.ports[0].postMessage(await readIdentity()); };`
                : type === 'service'
                  ? `oninstall = () => self.skipWaiting(); onactivate = (event) => event.waitUntil(self.clients.claim()); onmessage = async (event) => { ${fetch} event.ports[0].postMessage(await readIdentity()); };`
                  : `(async () => { ${fetch} postMessage(await readIdentity()); })();`;
            response.setHeader('Content-Type', 'application/javascript');
            response.end(identitySource + source);
            return;
          }
          response.setHeader('Content-Type', 'text/html');
          response.end(
            `<!doctype html><title>Fictitious native identity</title><script>${identitySource}</script>${path === '/page' ? `<iframe src="${urls[1]}/frame"></iframe>` : ''}`
          );
        }
      );
      servers.push(server);
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
    }
    urls = servers.map((server, index) => `https://${hosts[index]}:${server.address().port}`);
    return {
      urls,
      hosts,
      requests,
      spkiHash,
      certSha256: createHash('sha256').update(pem).digest('hex'),
      hostMapping: hosts.map((host) => `MAP ${host} 127.0.0.1`).join(', '),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

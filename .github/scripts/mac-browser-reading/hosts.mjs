/* global process */
/**
 * Made-up hosts for the reading, on ports 80 and 443 of this runner only.
 * `both.example.com` answers on both. `only-http.example.com` has its own loopback
 * address with nothing on 443, so a connection there is refused. Runs as root for
 * the ports. Writes one line per request, so a row can count who was reached.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';

const [, , log, key, cert] = process.argv;

const answer = (scheme) => (req, res) => {
  appendFileSync(log, `${JSON.stringify({ scheme, host: req.headers.host, path: req.url })}\n`);
  res.setHeader('content-type', 'text/html');
  res.end(`<!doctype html><title>Reading</title><h1>Served over ${scheme}</h1>`);
};

http.createServer(answer('http')).listen(80, '0.0.0.0');
https
  .createServer({ key: readFileSync(key), cert: readFileSync(cert) }, answer('https'))
  .listen(443, '127.0.0.1');

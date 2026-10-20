// The server listens on this computer only (Security gate, DOR-3121): any other
// bind host is refused before a socket opens. No browser needed.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawnSync } = require('child_process');

const SERVER = path.join(__dirname, '..', 'scripts', 'server.cjs');

function start(host) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-loopback-'));
  try {
    return spawnSync(process.execPath, [SERVER], {
      env: { ...process.env, BRAINSTORM_DIR: dir, BRAINSTORM_HOST: host, BRAINSTORM_PORT: '0' },
      encoding: 'utf8',
      timeout: 5000,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const host of ['0.0.0.0', '::', '192.168.1.10', 'example.com']) {
  test(`refuses to listen on ${host}`, () => {
    const r = start(host);
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /listens on this computer only/);
  });
}

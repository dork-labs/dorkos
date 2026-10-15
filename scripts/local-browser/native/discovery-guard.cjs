/** Raw CJS source; read as text, never import into the host. */
module.exports = function activate(b) {
  const assert = require('node:assert/strict'),
    fs = require('node:fs'),
    os = require('node:os');
  const path = require('node:path'),
    { fileURLToPath } = require('node:url');
  const originalHome = process.env.HOME,
    originalCodexHome = process.env.CODEX_HOME;
  for (const key of ['fixtureHome', 'ownedChromeProfile', 'dataDirectory'])
    assert.equal(fs.realpathSync(b[key]), b[key]);
  assert.equal(
    b.ownedChromeProfile,
    path.join(b.fixtureHome, 'Library/Application Support/Google/Chrome')
  );
  assert.equal(fs.realpathSync(process.env.DORK_HOME), b.dataDirectory);
  os.homedir = () => b.fixtureHome;
  const expected = path.join(b.ownedChromeProfile, 'DevToolsActivePort');
  let selfTest = false;
  function guard(input) {
    const file =
      input instanceof URL
        ? fileURLToPath(input)
        : Buffer.isBuffer(input)
          ? input.toString()
          : input;
    if (typeof file !== 'string' || path.basename(file) !== 'DevToolsActivePort') return;
    if (path.resolve(file) !== expected) {
      if (!selfTest)
        fs.appendFileSync(b.guardLog, JSON.stringify({ violation: true, pid: process.pid }) + '\n');
      throw Error('Proof refused foreign DevToolsActivePort');
    }
    const metadata = fs.lstatSync(expected);
    assert(metadata.isFile() && !metadata.isSymbolicLink());
    assert.equal(fs.realpathSync(expected), expected);
    fs.appendFileSync(b.guardLog, JSON.stringify({ ownedPortRead: true, pid: process.pid }) + '\n');
  }
  for (const name of ['readFile', 'readFileSync']) {
    const original = fs[name];
    fs[name] = function (file, ...args) {
      guard(file);
      return Reflect.apply(original, this, [file, ...args]);
    };
  }
  const original = fs.promises.readFile;
  fs.promises.readFile = function (file, ...args) {
    guard(file);
    return Reflect.apply(original, this, [file, ...args]);
  };
  require('node:module').syncBuiltinESMExports();
  const installed = [fs.readFileSync, fs.readFile, fs.promises.readFile];
  function testReadGuards() {
    // Check all identities before any dummy call; a replaced wrapper must never
    // fall through to a filesystem read, even of the deliberately fake path.
    assert.equal(fs.readFileSync, installed[0]);
    assert.equal(fs.readFile, installed[1]);
    assert.equal(fs.promises.readFile, installed[2]);
    selfTest = true;
    try {
      for (const invoke of [
        () => fs.readFileSync('/foreign/DevToolsActivePort'),
        () => fs.readFile('/foreign/DevToolsActivePort', () => {}),
        () => fs.promises.readFile('/foreign/DevToolsActivePort'),
      ]) {
        let refused = false;
        try {
          invoke();
        } catch (error) {
          refused = error.message === 'Proof refused foreign DevToolsActivePort';
        }
        assert(refused);
      }
      return { guardSelfTests: 3, identitiesUnchanged: true };
    } finally {
      selfTest = false;
    }
  }
  testReadGuards();
  fs.writeFileSync(
    b.attestation,
    JSON.stringify({
      pid: process.pid,
      execPath: process.execPath,
      argv: process.argv,
      runtimeHome: os.homedir(),
      dataDirectory: process.env.DORK_HOME,
      homePreserved: process.env.HOME === originalHome,
      codexHomePreserved: process.env.CODEX_HOME === originalCodexHome,
      guardSelfTests: 3,
    }),
    { flag: 'wx', mode: 0o600 }
  );
  return testReadGuards;
};

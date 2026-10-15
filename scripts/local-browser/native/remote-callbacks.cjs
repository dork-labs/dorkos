/** Raw CJS only. Each exported callback is serialized verbatim into a separate Electron/renderer context. */
module.exports = {
  identity: function identity(electron) {
    const app = electron.app;
    return {
      packaged: app.isPackaged,
      appPath: app.getAppPath(),
      home: app.getPath('home'),
      userData: app.getPath('userData'),
      electron: process.versions.electron,
      pid: process.pid,
    };
  },
  suppressUpdater: function suppressUpdater(electron) {
    const load = process
      .getBuiltinModule('module')
      .createRequire(electron.app.getAppPath() + '/package.json');
    const updater = load('electron-updater').autoUpdater;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    const blockedCheck = async () => null;
    updater.checkForUpdatesAndNotify = blockedCheck;
    if (
      updater.autoDownload !== false ||
      updater.autoInstallOnAppQuit !== false ||
      updater.checkForUpdatesAndNotify !== blockedCheck
    )
      throw Error('Candidate updater suppression failed');
    return {
      autoDownload: updater.autoDownload,
      autoInstallOnAppQuit: updater.autoInstallOnAppQuit,
      checkForUpdatesAndNotifySuppressed: true,
    };
  },
  installFork: function installFork(electron, config) {
    if (Date.now() >= config.deadline) throw Error('Late wrapper admission refused');
    const path = process.getBuiltinModule('path'),
      fs = process.getBuiltinModule('fs');
    const expected = path.join(process.resourcesPath, 'app.asar/dist/server/server-entry.mjs');
    if (globalThis[config.key]) throw Error('Proof wrapper already exists');
    const original = electron.utilityProcess.fork,
      descriptor = Object.getOwnPropertyDescriptor(electron.utilityProcess, 'fork');
    if (!descriptor?.writable) throw Error('utilityProcess.fork is not writable');
    const saved = {
      original,
      wrapped: null,
      calls: [],
      admitted: false,
      failed: false,
      closing: false,
    };
    function record(event) {
      saved.calls.push({ ...event, at: Date.now() });
      fs.appendFileSync(
        config.admissions,
        JSON.stringify(saved.calls[saved.calls.length - 1]) + '\n',
        { mode: 0o600 }
      );
    }
    const wrapped = function (entry, args, options) {
      // One synchronous admission latch: no recovery/cleanup race may spawn a second child.
      if (saved.admitted || saved.failed || saved.closing || Date.now() >= config.deadline) {
        saved.failed = true;
        record({ phase: 'refused-second-or-expired' });
        throw Error('Further utility fork refused');
      }
      if (entry !== expected) {
        saved.failed = true;
        throw Error('Unexpected packaged entry');
      }
      const rawDataDirectory = options?.env?.DORK_HOME;
      try {
        if (fs.realpathSync(rawDataDirectory) !== config.dataDirectory)
          throw Error('Foreign utility data directory');
      } catch (error) {
        saved.failed = true;
        record({ phase: 'private-env-refused', error: String(error) });
        throw error;
      }
      saved.admitted = true; // Any later argv/record/fork exception must still forbid another writer.
      const execArgv = [...(options.execArgv ?? []), '--inspect-brk=127.0.0.1:' + config.port];
      record({
        phase: 'admitted',
        id: config.key,
        entry,
        rawDataDirectory,
        canonicalDataDirectory: config.dataDirectory,
        execArgv,
        port: config.port,
      });
      let child;
      try {
        child = Reflect.apply(original, this, [entry, args, { ...options, execArgv }]);
      } catch (error) {
        saved.failed = true;
        record({ phase: 'fork-threw', error: String(error) });
        throw error;
      }
      record({ phase: 'returned', pid: child.pid ?? null });
      child.once('spawn', () => record({ phase: 'spawn', pid: child.pid, entry }));
      child.once('exit', (code) => {
        saved.failed = true;
        record({ phase: 'exit', code });
      });
      child.once('error', (error) => {
        saved.failed = true;
        record({ phase: 'error', error: String(error) });
      });
      return child;
    };
    saved.wrapped = wrapped;
    electron.utilityProcess.fork = wrapped;
    if (electron.utilityProcess.fork !== wrapped) throw Error('Fork wrapper assignment failed');
    globalThis[config.key] = saved;
    return { descriptor, expected, deadline: config.deadline, port: config.port };
  },
  readCalls: function readCalls(electron, key) {
    const saved = globalThis[key];
    if (!saved) throw Error('Owned fork wrapper state missing');
    return {
      calls: saved.calls.map((call) => ({ ...call })),
      admitted: saved.admitted,
      failed: saved.failed,
      closing: saved.closing,
      wrapperStillInstalled: electron.utilityProcess.fork === saved.wrapped,
    };
  },
  fenceFork: function fenceFork(_electron, key) {
    const saved = globalThis[key];
    if (saved) {
      saved.failed = true;
      saved.closing = true;
    }
    return true;
  },
  restartRenderer: function restartRenderer(deadline) {
    if (Date.now() >= deadline) throw Error('Late restart admission refused');
    return globalThis.electronAPI.restartServer();
  },
};

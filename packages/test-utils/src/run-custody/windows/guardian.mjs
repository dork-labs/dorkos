/** Private Windows launcher. Package selection and caller admission remain outside this module. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import {
  captureWindowsPortDeadline,
  windowsDuration,
  WINDOWS_STARTUP_LIMIT_MS,
  WINDOWS_STOP_LIMIT_MS,
} from './guardian-timing.mjs';
import {
  encodeGuardianRequest,
  isAbsoluteWindowsPath,
  readGuardianReports,
} from './guardian-protocol.mjs';

function observation() {
  let publish;
  const result = new Promise((resolve) => {
    publish = resolve;
  });
  return { result, publish };
}

function guardianEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => /^(systemroot|windir)$/i.test(name))
  );
}

function nativeStdio(mode, descriptor) {
  if (mode === 'inherit') return descriptor;
  return mode;
}

/**
 * Launch the already validated, private Windows guardian once. The owners
 * connect independently after readiness. Streams are the actual target lanes.
 * The startup and stop arguments are remaining durations in milliseconds.
 * Stop asks the existing helper for an immediate owned-Job join.
 */
export function launchPrivateWindowsGuardian({ helper, request, binding, startupMs }) {
  if (process.platform !== 'win32' || !isAbsoluteWindowsPath(helper)) {
    throw new Error('Windows guardian requires a resolved native helper on Windows');
  }
  const startup = windowsDuration(startupMs, WINDOWS_STARTUP_LIMIT_MS);
  const bootstrap = encodeGuardianRequest(request, binding, startup.remainingMs());
  let native;
  try {
    if (startup.remainingMs() === 0) throw new Error('Windows guardian startup deadline expired');
    native = spawn(helper, [], {
      env: guardianEnvironment(),
      // The private Job and its two owner pipes govern this guardian's target.
      detached: true,
      windowsHide: true,
      shell: false,
      stdio: [
        'overlapped',
        'overlapped',
        'ignore',
        nativeStdio(request.stdio.stdin, 0),
        nativeStdio(request.stdio.stdout, 1),
        nativeStdio(request.stdio.stderr, 2),
      ],
    });
  } catch (error) {
    bootstrap.fill(0);
    throw error;
  }

  const ready = observation();
  const identity = observation();
  const exited = once(native, 'exit');
  // A failed open/write also has an independent native process outcome.
  native.stdin.on('error', () => {});
  const sent = new Promise((resolve, reject) => {
    try {
      native.stdin.write(bootstrap, (error) => {
        bootstrap.fill(0);
        if (error) reject(new Error('Windows guardian bootstrap did not arrive', { cause: error }));
        else resolve();
      });
    } catch (error) {
      bootstrap.fill(0);
      reject(error);
    }
  });
  let stop;
  function requestStop(waitMs = WINDOWS_STOP_LIMIT_MS) {
    if (stop) return stop;
    const budget = windowsDuration(waitMs, WINDOWS_STOP_LIMIT_MS);
    const requested = sent.then(() => {
      // A late transport close still requires the independent terminal proof.
      if (!native.stdin.destroyed && !native.stdin.writableEnded) native.stdin.end(Buffer.of(1));
      return terminal;
    });
    stop = budget.wait(requested, new Error('Windows guardian cleanup remains unconfirmed'));
    void stop.catch(() => undefined);
    return stop;
  }

  const expireStartup = () => {
    ready.publish(false);
    identity.publish(undefined);
    requestStop();
  };
  const cancelStartup = startup.arm(expireStartup);
  const reports = readGuardianReports(native.stdout, {
    ready: () => {
      if (startup.remainingMs() === 0) expireStartup();
      else ready.publish(true);
    },
    spawned: (pid) => {
      if (startup.remainingMs() === 0) {
        expireStartup();
      } else {
        cancelStartup();
        identity.publish({ pid, executable: request.executable });
      }
    },
  });
  const terminal = Promise.all([reports, exited, sent])
    .then(([reported, [code, signal]]) => {
      if (code !== 0 || signal)
        throw new Error('Native guardian did not report a clean transport exit');
      return reported;
    })
    .catch((error) => {
      native.stdin.destroy();
      throw error;
    })
    .finally(() => {
      cancelStartup();
      ready.publish(false);
      identity.publish(undefined);
    });
  // Owners may await readiness before they consume the terminal result.
  void terminal.catch(() => undefined);

  return {
    ready: ready.result,
    spawned: identity.result,
    terminal,
    stdin: native.stdio[3],
    stdout: native.stdio[4],
    stderr: native.stdio[5],
    stop: requestStop,
  };
}

/** The existing run port passes wall-clock deadlines until its shared migration. */
export function launchWindowsGuardianFromPort({ helper, request, binding }) {
  const budget = captureWindowsPortDeadline(request.deadline, WINDOWS_STARTUP_LIMIT_MS);
  return launchPrivateWindowsGuardian({
    helper,
    request,
    binding,
    startupMs: budget.remainingMs(),
  });
}

import type { ChildProcess } from 'node:child_process';

/** Join independently captured original terminal and both pipes even after outcome/stop failure. */
export function ownOriginalCertificateJoins(options: {
  terminal: Promise<unknown>;
  stdout: Promise<unknown>;
  stderr: Promise<unknown>;
  stop(): void;
}) {
  const terminal = options.terminal;
  const stdout = options.stdout;
  const stderr = options.stderr;
  const stop = options.stop.bind(options);
  let first: { value: unknown } | undefined;
  const fail = (value: unknown) => {
    first ??= { value };
  };
  const originals = [terminal, stdout, stderr].map((original) =>
    original.then(
      () => {},
      (error) => {
        fail(error);
      }
    )
  );
  let closing: Promise<void> | undefined;
  const wait = async () => {
    await Promise.all(originals);
    if (first) throw first.value;
  };
  return Object.freeze({
    fail,
    wait,
    close() {
      if (closing) return closing;
      closing = Promise.resolve().then(async () => {
        try {
          stop();
        } catch (error) {
          fail(error);
        }
        await wait();
      });
      void closing.catch(() => {});
      return closing;
    },
  });
}

/** A child error is outcome evidence; it cannot stand in for original child/pipe closure. */
export function captureOriginalCertificateProducer(child: ChildProcess) {
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (!stdout || !stderr) throw Error('H2_CERTIFICATE_PIPES_UNAVAILABLE');
  const kill = child.kill.bind(child);
  let stopping = false;
  const terminal = new Promise<void>((resolve) =>
    child.once('close', (code, signal) => {
      if (!stopping && (code !== 0 || signal !== null))
        owner.fail(Error('H2_CERTIFICATE_PRODUCER_FAILED'));
      resolve();
    })
  );
  const originalStdout = new Promise<void>((resolve) =>
    stdout.once('close', () => {
      if (!stdout.readableEnded) owner.fail(Error('H2_CERTIFICATE_STDOUT_EOF_UNVERIFIED'));
      resolve();
    })
  );
  const originalStderr = new Promise<void>((resolve) =>
    stderr.once('close', () => {
      if (!stderr.readableEnded) owner.fail(Error('H2_CERTIFICATE_STDERR_EOF_UNVERIFIED'));
      resolve();
    })
  );
  const owner = ownOriginalCertificateJoins({
    terminal,
    stdout: originalStdout,
    stderr: originalStderr,
    stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      stopping = true;
      if (!kill('SIGTERM')) owner.fail(Error('H2_CERTIFICATE_STOP_UNVERIFIED'));
    },
  });
  child.on('error', owner.fail);
  stdout.on('error', owner.fail);
  stderr.on('error', owner.fail);
  stdout.resume();
  stderr.resume();
  return owner;
}

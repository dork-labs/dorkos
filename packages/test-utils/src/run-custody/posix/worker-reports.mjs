/** Authenticated report ordering and control retirement for one POSIX worker. */
import { createControlReader } from './control.mjs';
import { classifyPosixJoin } from './join-fact.mjs';

const dispositions = new Set(['cleaned-owned', 'never-acquired', 'cleanup-uncertain']);

export function bindWorkerReports(control, connection, { receive, joined, lost, retainOutput }) {
  let sawNative = false;
  let receipt;
  let clean = false;
  let failed = false;
  let reports = Promise.resolve();

  function fail() {
    if (failed) return;
    failed = true;
    lost();
  }

  const read = createControlReader(
    connection.token,
    connection.endpointId,
    'anchor-to-guardian',
    (kind, fact) => {
      if (receipt) throw new Error('Unexpected POSIX report after terminal join');
      if (kind === 'joined') {
        if (!fact || Object.keys(fact).length !== 1 || !dispositions.has(fact.kind))
          throw new Error('Malformed POSIX join report');
        receipt = classifyPosixJoin(fact, sawNative);
        return;
      }
      if (kind === 'spawned' || kind === 'exited' || kind === 'closed') sawNative = true;
      reports = reports
        .then(() => {
          if (!failed) return receive(kind, fact);
        })
        .catch(fail);
    }
  );

  control.on('data', (bytes) => {
    if (failed) return;
    try {
      read.push(bytes);
    } catch {
      fail();
    }
  });
  control.on('end', () => {
    if (failed) return;
    try {
      read.end();
      if (!receipt) throw new Error('POSIX control ended before terminal join');
      clean = true;
      if (receipt.kind === 'cleaned-owned' && retainOutput()) {
        // EOF on this socket does not retire any independently buffered data.
        // The underlying absolute stop deadline still covers this pending join.
        void reports.then(() => {
          if (!failed) joined(receipt);
        });
      } else {
        joined(receipt);
        fail();
      }
      control.end();
    } catch {
      fail();
    }
  });
  control.on('close', () => {
    if (!clean) fail();
  });
  control.on('error', fail);
  control.resume();
}

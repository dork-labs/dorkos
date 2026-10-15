import { requireOriginalHostDiagnosticOwner } from '../server-host.js';
/** Finite original DATA forwarding; no control counters or resources are supplied. */
export function createOriginalHostDiagnosticForwarders(ownerKey: object) {
  requireOriginalHostDiagnosticOwner(ownerKey);
  let closeDiagnosticRemainder = '';
  let closeDiagnosticRecords = 0;
  const forwardCloseDiagnostic = (chunk: Buffer) => {
    // Finite close DATA only; arbitrary worker output remains in original bounded custody.
    const lines = (closeDiagnosticRemainder + chunk.toString('utf8')).split('\n');
    closeDiagnosticRemainder = (lines.pop() ?? '').slice(-256);
    for (const line of lines) {
      if (
        closeDiagnosticRecords < 40 &&
        /^ORIGINAL_MCP_CLOSE_STAGE child [1-9][0-9]? [0-9]{13} (startup|reviewed-stop|reviewed-join|saved-stop|saved-join|selection-stop|selection-join|mcp-stop|mcp-join|widget-join|canonical-join|vite-close|previews-close|fixture-close|complete) (begin|done|failed)$/.test(
          line
        )
      ) {
        closeDiagnosticRecords++;
        try {
          console.error(line);
        } catch {
          // Diagnostic transport cannot replace the original close result.
        }
      }
    }
  };
  let resourceDiagnosticRemainder = '';
  let resourceDiagnosticRecords = 0;
  const forwardResourceDiagnostic = (chunk: Buffer) => {
    const lines = (resourceDiagnosticRemainder + chunk.toString('utf8')).split('\n');
    resourceDiagnosticRemainder = (lines.pop() ?? '').slice(-4096);
    for (const line of lines) {
      if (resourceDiagnosticRecords >= 3 || Buffer.byteLength(line + '\n', 'utf8') > 4096) continue;
      try {
        const row: unknown = JSON.parse(line);
        if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
        const data = row as Record<string, unknown>;
        if (
          Object.keys(data).sort().join(',') !==
          'at,counts,kind,phase,resourceCount,sequence,timeoutOrigins,truncated'
        )
          continue;
        if (
          data.kind !== 'ORIGINAL_MCP_POST_CLOSE_RESOURCES' ||
          data.sequence !== resourceDiagnosticRecords + 1
        )
          continue;
        if (
          !['closed-before-disconnect', 'closed-after-disconnect', 'before-exit'].includes(
            String(data.phase)
          )
        )
          continue;
        if (typeof data.at !== 'number' || !Number.isSafeInteger(data.at) || data.at < 0) continue;
        if (
          typeof data.resourceCount !== 'number' ||
          !Number.isInteger(data.resourceCount) ||
          data.resourceCount < 0 ||
          data.resourceCount > 65
        )
          continue;
        if (typeof data.truncated !== 'boolean' || data.truncated !== (data.resourceCount === 65))
          continue;
        if (!data.counts || typeof data.counts !== 'object' || Array.isArray(data.counts)) continue;
        const entries = Object.entries(data.counts);
        if (
          entries.length > 64 ||
          entries.some(
            ([kind, count]) =>
              !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(kind) ||
              typeof count !== 'number' ||
              !Number.isInteger(count) ||
              count < 1 ||
              count > 64
          )
        )
          continue;
        const sum = entries.reduce((total, [, count]) => total + Number(count), 0);
        if (sum > 64 || sum > data.resourceCount) continue;
        if (
          !data.timeoutOrigins ||
          typeof data.timeoutOrigins !== 'object' ||
          Array.isArray(data.timeoutOrigins)
        )
          continue;
        const origins = data.timeoutOrigins as Record<string, unknown>;
        if (
          Object.keys(origins).sort().join(',') !==
          'captures,entries,moduleLevelImportBlindspot,overflow,trackedCount'
        )
          continue;
        if (
          typeof origins.trackedCount !== 'number' ||
          !Number.isInteger(origins.trackedCount) ||
          origins.trackedCount < 0 ||
          origins.trackedCount > 64
        )
          continue;
        if (typeof origins.overflow !== 'boolean' || origins.moduleLevelImportBlindspot !== true)
          continue;
        if (
          !Array.isArray(origins.entries) ||
          origins.entries.length > 4 ||
          origins.entries.some(
            (frames: unknown) =>
              !Array.isArray(frames) ||
              frames.length > 6 ||
              frames.some(
                (frame: unknown) =>
                  typeof frame !== 'string' ||
                  !/^[A-Za-z0-9_./:@+-]{1,160}$/.test(frame) ||
                  frame.startsWith('/') ||
                  frame.includes('..')
              )
          )
        )
          continue;
        if (
          !Array.isArray(origins.captures) ||
          origins.captures.length !== origins.entries.length ||
          origins.captures.some((value: unknown) => {
            if (!value || typeof value !== 'object' || Array.isArray(value)) return true;
            const capture = value as Record<string, unknown>;
            if (
              Object.keys(capture).sort().join(',') !==
              'mode,outsideScope,rawFrameCount,scaffolding,truncated,unparsed,unsafe'
            )
              return true;
            if (
              !['timeout-caller', 'interval-caller', 'hook-fallback'].includes(
                String(capture.mode)
              ) ||
              typeof capture.truncated !== 'boolean'
            )
              return true;
            return ['rawFrameCount', 'unparsed', 'outsideScope', 'unsafe', 'scaffolding'].some(
              (key) =>
                typeof capture[key] !== 'number' ||
                !Number.isInteger(capture[key]) ||
                Number(capture[key]) < 0 ||
                Number(capture[key]) > 64
            );
          })
        )
          continue;
        resourceDiagnosticRecords++;
        console.error(line);
      } catch {
        // Invalid or unavailable resource DATA never changes the original first cause.
      }
    }
  };
  return { forwardCloseDiagnostic, forwardResourceDiagnostic };
}

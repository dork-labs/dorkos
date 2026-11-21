/** Detached recorded-turn policy snapshots for durable hand-off admission. */
import type { TurnPermissionLevel } from '@dorkos/shared/agent-runtime';
import { ceilingCarrying, marksHold, mergeMarks, type TurnMarks } from './turn-marks.js';

interface CaptureRecord {
  serial: number | undefined;
  eligible: boolean;
  marks: TurnMarks | null;
}
export interface RecordedTurn {
  level: TurnPermissionLevel;
  capture: CaptureRecord;
}
/** Detached capture-only marks; public level objects retain legacy ownership semantics. */
export function copyCaptureMarks(marks: TurnMarks): TurnMarks | null {
  try {
    return JSON.parse(JSON.stringify(marks)) as TurnMarks;
  } catch {
    return null;
  } // Capture failure must never change legacy runtime behavior.
}

/** Read only a positively current record; returned policy never changes with its source. */
export function captureTransfer(
  record: RecordedTurn | undefined,
  sessionId: string,
  expectedCurrentSerial: number,
  currentMarks: TurnMarks,
  outsideWords: boolean
) {
  const captured = record?.capture;
  if (
    !captured?.eligible ||
    captured.marks === null ||
    captured.serial !== expectedCurrentSerial ||
    !Number.isSafeInteger(expectedCurrentSerial) ||
    expectedCurrentSerial <= 0
  )
    return { state: 'unknown' as const };
  const marks = mergeMarks(captured.marks, currentMarks);
  const carry = {
    externalAuthor: marks.outsider === true,
    permissionCeiling: ceilingCarrying(marks) ?? null,
    outsider: marksHold(marks),
    teammate: marks.teammate !== undefined && marks.teammate.length > 0,
    outsideWords,
  };
  const snapshot = JSON.parse(
    JSON.stringify({
      state: 'recorded-transfer' as const,
      sessionId,
      turnSerial: captured.serial,
      wordEvidence: 'recorded' as const,
      carry,
    })
  ) as {
    state: 'recorded-transfer';
    sessionId: string;
    turnSerial: number;
    wordEvidence: 'recorded';
    carry: typeof carry;
  };
  const freeze = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };
  freeze(snapshot);
  return snapshot;
}

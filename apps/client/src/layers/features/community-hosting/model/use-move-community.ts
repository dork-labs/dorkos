/**
 * "Move a community here": send an owner export, watch it upload and import,
 * then hand over to claim and connect.
 *
 * Where a move is comes from the service on every poll. Nothing about it is
 * kept in this page beyond the move's id while the dialog is open, so closing
 * the window or reloading loses nothing: the switcher reads the unfinished
 * move from the account and the dialog picks it up again. The upload itself
 * runs in this DorkOS's server, so DorkOS has to keep running until it lands;
 * the import after that needs nothing from this machine.
 *
 * @module features/community-hosting/model/use-move-community
 */
import { useCallback, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CloudCommunityMove,
  CloudCommunityMovePollResponse,
} from '@dorkos/shared/cloud-schemas';
import { useTransport } from '@/layers/shared/model';
import { hostedCommunityKeys } from './hosted-communities';
import { noticeOf, UNREACHABLE_NOTICE } from './use-claim-and-connect';
import { WEB_ADDRESS_RESERVED, WEB_ADDRESS_TAKEN, type StartFailure } from './use-start-community';

/** Where one move is, as the dialog draws it. */
export type MoveStep =
  | { kind: 'uploading'; move: CloudCommunityMove }
  | {
      kind: 'upload-failed';
      move: CloudCommunityMove;
      /**
       * `interrupted`: the connection broke and the same copy can go again.
       * `refused`: the new host would not take these bytes. `lost`: the window
       * closed, or this DorkOS no longer holds the copy (it restarted, or
       * another DorkOS started the move).
       */
      why: 'interrupted' | 'refused' | 'lost';
    }
  | { kind: 'importing'; move: CloudCommunityMove }
  | { kind: 'ready'; move: CloudCommunityMove }
  | { kind: 'failed'; move: CloudCommunityMove }
  | { kind: 'cancelled'; move: CloudCommunityMove }
  | { kind: 'unrecognised'; move: CloudCommunityMove };

/**
 * Read which step a move is on from the service's state and the local upload.
 *
 * @param move - The move, fresh from the service.
 */
export function moveStepOf(move: CloudCommunityMove): MoveStep {
  switch (move.state) {
    case 'awaiting_upload': {
      const upload = move.upload;
      if (upload?.state === 'sending') return { kind: 'uploading', move };
      // Sent, and the service has not noticed yet: that is the import starting.
      if (upload?.state === 'sent') return { kind: 'importing', move };
      const why =
        upload?.state === 'failed' && upload.failure === 'interrupted'
          ? 'interrupted'
          : upload?.state === 'failed' && upload.failure === 'rejected'
            ? 'refused'
            : 'lost';
      return { kind: 'upload-failed', move, why };
    }
    case 'importing':
      return { kind: 'importing', move };
    case 'ready':
    case 'claimed':
      return { kind: 'ready', move };
    case 'failed':
      return { kind: 'failed', move };
    case 'cancelled':
      return { kind: 'cancelled', move };
    default:
      return { kind: 'unrecognised', move };
  }
}

/** A move the dialog can still act on (not failed, cancelled or unknown). */
export function isUnfinishedMove(move: CloudCommunityMove): boolean {
  return move.state === 'awaiting_upload' || move.state === 'importing' || move.state === 'ready';
}

/** Everything the move dialog needs. */
export interface MoveCommunity {
  /** The move being watched, or `null` before one exists. */
  step: MoveStep | null;
  /** Bytes of the export that have reached this DorkOS, while it is being sent. */
  sending: { loaded: number; total: number } | null;
  failure: StartFailure;
  clearFieldFailure: () => void;
  busy: boolean;
  /** Send the export and start the move. */
  start: (input: { file: File; name: string; shortName: string }) => Promise<void>;
  /** Stop sending, or cancel the move. Available until the move is ready. */
  cancel: () => Promise<void>;
  /** Send the export again from the copy this DorkOS holds. */
  sendAgain: () => Promise<void>;
  /** Forget the finished move and go back to choosing a file. */
  startOver: () => void;
}

/**
 * Drive one move.
 *
 * @param resumeMoveId - An unfinished move to pick up, when the dialog opens on one.
 */
export function useMoveCommunity(resumeMoveId: string | null): MoveCommunity {
  const transport = useTransport();
  const client = useQueryClient();
  const [moveId, setMoveId] = useState<string | null>(resumeMoveId);
  const [sending, setSending] = useState<{ loaded: number; total: number } | null>(null);
  const [failure, setFailure] = useState<StartFailure>({ field: null, notice: null });
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const key = useRef<{ body: string; key: string } | null>(null);

  const poll = useQuery<CloudCommunityMovePollResponse>({
    queryKey: hostedCommunityKeys.move(moveId ?? ''),
    queryFn: () => transport.getHostedCommunityMove(moveId!),
    enabled: moveId !== null,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data?.available !== true) return false;
      // Watch the upload closely; otherwise wait as long as the service asks.
      if (data.move.upload?.state === 'sending') return 1_000;
      return data.move.pollAfterMs === null ? false : Math.max(1_000, data.move.pollAfterMs);
    },
  });
  const move = poll.data?.available === true ? poll.data.move : null;
  const step = move ? moveStepOf(move) : null;

  const seed = useCallback(
    (next: CloudCommunityMove) => {
      client.setQueryData(hostedCommunityKeys.move(next.moveId), {
        available: true,
        move: next,
      } satisfies CloudCommunityMovePollResponse);
    },
    [client]
  );

  async function start(input: { file: File; name: string; shortName: string }) {
    const body = {
      name: input.name.trim(),
      ...(input.shortName ? { shortName: input.shortName } : {}),
      file: [input.file.name, input.file.size, input.file.lastModified],
    };
    const serial = JSON.stringify(body);
    if (key.current?.body !== serial) key.current = { body: serial, key: crypto.randomUUID() };
    const controller = new AbortController();
    abort.current = controller;
    setFailure({ field: null, notice: null });
    setSending({ loaded: 0, total: input.file.size });
    try {
      const answer = await transport.startHostedCommunityMove(
        input.file,
        {
          idempotencyKey: key.current.key,
          name: body.name,
          ...(input.shortName ? { shortName: input.shortName } : {}),
        },
        (progress) => setSending(progress),
        controller.signal
      );
      if (answer.ok) {
        seed(answer.move);
        setMoveId(answer.move.moveId);
        void client.invalidateQueries({ queryKey: hostedCommunityKeys.list() });
      } else if ('problem' in answer && answer.problem.code === 'community_name_taken') {
        setFailure({ field: WEB_ADDRESS_TAKEN, notice: null });
      } else if ('problem' in answer && answer.problem.code === 'community_name_reserved') {
        setFailure({ field: WEB_ADDRESS_RESERVED, notice: null });
      } else {
        setFailure({ field: null, notice: noticeOf(answer) });
      }
    } catch {
      // A cancel the person asked for is not a failure worth a sentence.
      if (!controller.signal.aborted) setFailure({ field: null, notice: UNREACHABLE_NOTICE });
    } finally {
      abort.current = null;
      setSending(null);
    }
  }

  async function cancel() {
    if (abort.current) {
      abort.current.abort();
      return;
    }
    if (!moveId) return;
    setBusy(true);
    try {
      const answer = await transport.cancelHostedCommunityMove(moveId);
      if (answer.ok) seed(answer.move);
      else setFailure({ field: null, notice: noticeOf(answer) });
      void client.invalidateQueries({ queryKey: hostedCommunityKeys.list() });
    } catch {
      setFailure({ field: null, notice: UNREACHABLE_NOTICE });
    } finally {
      setBusy(false);
    }
  }

  async function sendAgain() {
    if (!moveId) return;
    setBusy(true);
    setFailure({ field: null, notice: null });
    try {
      const answer = await transport.retryHostedCommunityMoveUpload(moveId);
      if (answer.ok) seed(answer.move);
      else setFailure({ field: null, notice: noticeOf(answer) });
    } catch {
      setFailure({ field: null, notice: UNREACHABLE_NOTICE });
    } finally {
      setBusy(false);
    }
  }

  return {
    step,
    sending,
    failure,
    clearFieldFailure: () => setFailure((f) => ({ ...f, field: null })),
    busy,
    start,
    cancel,
    sendAgain,
    startOver: () => {
      setMoveId(null);
      setFailure({ field: null, notice: null });
    },
  };
}

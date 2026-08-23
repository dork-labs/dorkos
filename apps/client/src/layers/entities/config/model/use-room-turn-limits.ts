/**
 * How much agents may say to each other on their own (`rooms.*`): read + write.
 *
 * @module entities/config/model/use-room-turn-limits
 */
import { useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ServerConfig } from '@dorkos/shared/types';
import { useTransport } from '@/layers/shared/model';
import { configKeys } from '../api/query-keys';
import { useConfig } from './use-config';

/**
 * The five numbers that decide how far a conversation between agents may run
 * before the room stops it.
 *
 * The install-wide values. A single room may override the first four through
 * `PATCH /api/rooms/:id`; the hourly total is the one nothing may override,
 * because it bounds the whole install rather than one room.
 */
export interface RoomTurnLimits {
  /** Whether any of the four numbers below apply at all. */
  turnLimitsEnabled: boolean;
  /** How many replies in a row agents may trade before the room pauses them. */
  maxAgentDepth: number;
  /** How many of those replies any ONE agent may post in one back-and-forth. */
  maxTurnsPerAgentPerCascade: number;
  /** The most automatic replies one room may run in an hour. */
  maxAutomaticTurnsPerRoomPerHour: number;
  /** The most automatic replies this DorkOS may run in an hour, everywhere. */
  maxAutomaticTurnsTotalPerHour: number;
}

/** What {@link useRoomTurnLimits} hands its consumers. */
export interface RoomTurnLimitsState {
  /**
   * The settings in force, or `null` until they have been read.
   *
   * **A caller must not substitute the shipped defaults for `null`.** Every
   * surface that reads this prints the numbers — Settings shows them in fields,
   * a room shows them as the "Use default" it inherits — so guessing produces a
   * screen that states something false about the reader's own install and then
   * corrects itself. Show a skeleton, or show nothing, until they land.
   */
  limits: RoomTurnLimits | null;
  /** Change one or more of them. Deep-merged server-side. */
  setLimits: (patch: Partial<RoomTurnLimits>) => void;
  /** Whether a write is in flight. */
  isPending: boolean;
  /** The last write that failed, or `null` when the last one did not. */
  error: Error | null;
}

/**
 * Read the five limits off a config answer, or `null` when it cannot say.
 *
 * The fields are optional on the wire so that a server too old to have this
 * panel is distinguishable from one reporting a limit of zero. All or nothing:
 * a partial answer is a server we cannot describe honestly.
 */
function readLimits(rooms: ServerConfig['rooms']): RoomTurnLimits | null {
  if (rooms === undefined) return null;
  const {
    turnLimitsEnabled,
    maxAgentDepth,
    maxTurnsPerAgentPerCascade,
    maxAutomaticTurnsPerRoomPerHour,
    maxAutomaticTurnsTotalPerHour,
  } = rooms;
  if (
    turnLimitsEnabled === undefined ||
    maxAgentDepth === undefined ||
    maxTurnsPerAgentPerCascade === undefined ||
    maxAutomaticTurnsPerRoomPerHour === undefined ||
    maxAutomaticTurnsTotalPerHour === undefined
  ) {
    return null;
  }
  return {
    turnLimitsEnabled,
    maxAgentDepth,
    maxTurnsPerAgentPerCascade,
    maxAutomaticTurnsPerRoomPerHour,
    maxAutomaticTurnsTotalPerHour,
  };
}

/**
 * Read and change how much agents may say to each other without being asked.
 *
 * Writes are optimistic and roll back on failure, the same shape
 * `useNotificationPrefs` uses next door — which matters more here than there:
 * the master switch and the four numbers are one control between them, and a
 * switch that waits a round trip before it moves reads as a switch that did not
 * take. The report on failure is the shared mutation toast plus
 * {@link RoomTurnLimitsState.error}, and the value snaps back to what the server
 * still holds.
 *
 * Writing any of these is operator-only, decided by the server
 * (`config-write-policy.ts`). Nothing here needs to know that: an agent driving
 * this cockpit is refused by the same rule that refuses it the API.
 */
export function useRoomTurnLimits(): RoomTurnLimitsState {
  const { data: config } = useConfig();
  const transport = useTransport();
  const queryClient = useQueryClient();

  const limits = readLimits(config?.rooms);

  const mutation = useMutation<
    void,
    Error,
    Partial<RoomTurnLimits>,
    { previous: ServerConfig | undefined }
  >({
    mutationFn: (patch) => transport.updateConfig({ rooms: patch }),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: configKeys.current() });
      const previous = queryClient.getQueryData<ServerConfig>(configKeys.current());
      queryClient.setQueryData<ServerConfig>(configKeys.current(), (old) =>
        // Nothing to patch optimistically when the block is not in the cache
        // yet; the settle-time invalidate refetches it.
        old?.rooms ? { ...old, rooms: { ...old.rooms, ...patch } } : old
      );
      return { previous };
    },
    onError: (_error, _patch, context) => {
      if (context && context.previous !== undefined) {
        queryClient.setQueryData(configKeys.current(), context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: configKeys.current() });
    },
    meta: { errorLabel: "Couldn't change that limit" },
  });

  const { mutate } = mutation;
  const setLimits = useCallback((patch: Partial<RoomTurnLimits>) => mutate(patch), [mutate]);

  return {
    limits,
    setLimits,
    isPending: mutation.isPending,
    error: mutation.isError ? mutation.error : null,
  };
}

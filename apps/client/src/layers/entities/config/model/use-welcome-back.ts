/**
 * Whether agents may greet you when you come back after being away, as the
 * cockpit reads and writes it (spec `team-room-home` D5.2, DOR-1046).
 *
 * Two switches, and they are not the same kind of decision. The first says
 * whether agents may leave a note at all; it costs nothing either way, because
 * the notes are read off session state. The second says whether a note may end
 * in a next-step offer, and that one spends a model turn per agent — so it is
 * separate, it is off by default, and the surface that renders it has to say so.
 *
 * The two numbers behind them — how long an absence has to be, and how many
 * posts one return may produce — stay in the config file for now, because they
 * are judgement calls somebody tunes once and further controls would earn their
 * place only after the first ones have been lived with. They still come back
 * from the server so the switch can describe itself with the threshold actually
 * in force rather than the shipped default.
 *
 * @module entities/config/model/use-welcome-back
 */
import { useCallback } from 'react';
import { useConfig } from './use-config';
import { useUpdateConfig } from './use-update-config';

/** What {@link useWelcomeBack} hands back. */
export interface WelcomeBackSetting {
  /** Whether agents may post when you return. */
  enabled: boolean;
  /** How long you have to be away before coming back counts as a return, in minutes. */
  absenceThresholdMinutes: number;
  /** The most posts one return may produce. */
  maxPosts: number;
  /**
   * Whether a note may end in a next-step offer — the one part of this feature
   * that spends a model turn.
   */
  offersEnabled: boolean;
  /** Turn the posts on or off. */
  setEnabled: (enabled: boolean) => void;
  /** Turn the offers, and the turns they spend, on or off. */
  setOffersEnabled: (offersEnabled: boolean) => void;
  /**
   * Whether this install has the setting at all.
   *
   * False while the config is still loading, on an older server that does not
   * report the block, and in Obsidian, whose `DirectTransport` builds no such
   * block and whose `updateConfig` is a documented no-op. A surface must hide
   * the switch when this is false rather than show one that saves nothing —
   * the same rule {@link useAutonomyAcknowledgement} follows, and for the same
   * reason: a switch that ticks and forgets is worse than no switch.
   */
  isAvailable: boolean;
  /** Whether a write is in flight. */
  isPending: boolean;
}

/**
 * Read and write the welcome-back setting.
 *
 * Rides the shared config query the shell already keeps warm, so the read costs
 * a selector rather than a request. The write is fire-and-forget: a failure
 * leaves the person on the value they already had, which the next read restores.
 */
export function useWelcomeBack(): WelcomeBackSetting {
  const { data: config } = useConfig();
  const updateConfig = useUpdateConfig();
  const welcomeBack = config?.welcomeBack;

  const setEnabled = useCallback(
    (enabled: boolean) => {
      updateConfig.mutate({ welcomeBack: { enabled } });
    },
    [updateConfig]
  );

  const setOffersEnabled = useCallback(
    (offersEnabled: boolean) => {
      updateConfig.mutate({ welcomeBack: { offersEnabled } });
    },
    [updateConfig]
  );

  return {
    // The fallbacks are never SHOWN: a caller that respects `isAvailable`
    // renders nothing while they apply. They exist so the shape is stable.
    enabled: welcomeBack?.enabled ?? false,
    absenceThresholdMinutes: welcomeBack?.absenceThresholdMinutes ?? 0,
    maxPosts: welcomeBack?.maxPosts ?? 0,
    // `false` is also the right fallback for an OLDER server that reports the
    // block without this field: a switch nothing behind it can honour must read
    // as off rather than as a spend somebody never agreed to.
    offersEnabled: welcomeBack?.offersEnabled ?? false,
    setEnabled,
    setOffersEnabled,
    isAvailable: welcomeBack !== undefined,
    isPending: updateConfig.isPending,
  };
}

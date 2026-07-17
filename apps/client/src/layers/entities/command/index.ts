/**
 * Command entity — domain hook for slash command discovery and command ranking.
 *
 * @module entities/command
 */
export { useCommands } from './model/use-commands';
export { useCommandsSync } from './model/use-commands-sync';
export {
  rankCommand,
  type PaletteCommandEntry,
  type RankedCommandEntry,
  type CommandRank,
} from './lib/rank-command';

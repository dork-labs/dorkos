/**
 * Command entity — domain hook for slash command discovery and command ranking.
 *
 * @module entities/command
 */
export { useCommands } from './model/use-commands';
export { rankCommand, type RankedCommandEntry, type CommandRank } from './lib/rank-command';

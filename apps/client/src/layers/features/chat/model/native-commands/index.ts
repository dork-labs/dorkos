/**
 * Native (client-side) chat commands — slash commands DorkOS executes locally
 * and never sends to the runtime/model (spec web-chat-native-commands,
 * ADR-0300). Public surface of the sub-module.
 *
 * @module features/chat/model/native-commands
 */
export { useNativeCommands } from './use-native-commands';
export type { NativeCommandResult } from './use-native-commands';
export { NATIVE_COMMANDS, parseNativeCommand, NATIVE_COMMAND_ENTRIES } from './registry';
export type { NativeCommand, NativeCommandContext } from './registry';
// Shared with the compaction chip (DOR-112) — see dispatch-compact-intent.ts
// for why it lives here rather than loose in `chat/model/`.
export { dispatchCompactIntent } from './dispatch-compact-intent';

import type { TestModeNativeMethodView } from '../native/test-mode-native-methods.js';
import type { TestModeScenarioSessionView } from './test-mode-scenario-session-types.js';
const originalProjectionFreeze = Object.freeze;

/** Fixed readonly native view inputs; this module neither registers nor selects authority. */
export interface OriginalTestModeNativeViewPorts {
  nativeEntries(): TestModeNativeMethodView['nativeEntries'];
  nativePrincipals(): TestModeNativeMethodView['nativePrincipals'];
  nativeLocks(): TestModeNativeMethodView['nativeLocks'];
  preparedRoomContexts(): TestModeNativeMethodView['preparedRoomContexts'];
  activeNativeStreams(): TestModeNativeMethodView['activeNativeStreams'];
  installNative: TestModeNativeMethodView['installNative'];
  nativeStream: TestModeNativeMethodView['nativeStream'];
  sendScenario: TestModeNativeMethodView['sendScenario'];
}

/** Fixed readonly session view inputs; original writable counter setter stays constructor-owned. */
export interface OriginalTestModeSessionViewPorts {
  type(): TestModeScenarioSessionView['type'];
  registry(): TestModeScenarioSessionView['registry'];
  settingsPort(): TestModeScenarioSessionView['settingsPort'];
  managedMcp(): TestModeScenarioSessionView['managedMcp'];
  openTurns(): TestModeScenarioSessionView['openTurns'];
  nativeEntries(): TestModeScenarioSessionView['nativeEntries'];
  nativePrincipals(): TestModeScenarioSessionView['nativePrincipals'];
  nativeRoomEmitter(): TestModeScenarioSessionView['nativeRoomEmitter'];
  originalScenarioStarts(): TestModeScenarioSessionView['originalScenarioStarts'];
  nativeLocks(): TestModeScenarioSessionView['nativeLocks'];
  originalNativeCanonicalAliases(): TestModeScenarioSessionView['originalNativeCanonicalAliases'];
  revealCanonicalSessionId(): TestModeScenarioSessionView['revealCanonicalSessionId'];
  syntheticCompaction(): TestModeScenarioSessionView['syntheticCompaction'];
  setOriginalScenarioStarts(value: number): void;
}

/** Assemble original native descriptors without authenticating or registering a caller. */
export function projectOriginalTestModeNativeView(
  runtime: TestModeNativeMethodView['runtime'],
  custody: TestModeNativeMethodView['custody'],
  ports: Readonly<OriginalTestModeNativeViewPorts>
): Readonly<TestModeNativeMethodView> {
  return originalProjectionFreeze<TestModeNativeMethodView>({
    runtime,
    custody,
    get nativeEntries() {
      return ports.nativeEntries();
    },
    get nativePrincipals() {
      return ports.nativePrincipals();
    },
    get nativeLocks() {
      return ports.nativeLocks();
    },
    get preparedRoomContexts() {
      return ports.preparedRoomContexts();
    },
    get activeNativeStreams() {
      return ports.activeNativeStreams();
    },
    installNative: ports.installNative,
    nativeStream: ports.nativeStream,
    sendScenario: ports.sendScenario,
  });
}

/** Assemble original session descriptors without owning maps, keys, or effectful entry points. */
export function projectOriginalTestModeSessionView(
  runtime: TestModeScenarioSessionView['runtime'],
  custody: TestModeScenarioSessionView['custody'],
  declaredCanonicalIds: TestModeScenarioSessionView['declaredCanonicalIds'],
  ports: Readonly<OriginalTestModeSessionViewPorts>
): Readonly<TestModeScenarioSessionView> {
  return originalProjectionFreeze<TestModeScenarioSessionView>({
    runtime,
    custody,
    get type() {
      return ports.type();
    },
    get registry() {
      return ports.registry();
    },
    get settingsPort() {
      return ports.settingsPort();
    },
    get managedMcp() {
      return ports.managedMcp();
    },
    get openTurns() {
      return ports.openTurns();
    },
    get nativeEntries() {
      return ports.nativeEntries();
    },
    get nativePrincipals() {
      return ports.nativePrincipals();
    },
    get nativeRoomEmitter() {
      return ports.nativeRoomEmitter();
    },
    get originalScenarioStarts() {
      return ports.originalScenarioStarts();
    },
    set originalScenarioStarts(value: number) {
      ports.setOriginalScenarioStarts(value);
    },
    get nativeLocks() {
      return ports.nativeLocks();
    },
    get originalNativeCanonicalAliases() {
      return ports.originalNativeCanonicalAliases();
    },
    declaredCanonicalIds,
    get revealCanonicalSessionId() {
      return ports.revealCanonicalSessionId();
    },
    get syntheticCompaction() {
      return ports.syntheticCompaction();
    },
  });
}

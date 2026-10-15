import type { OriginalClaudeNativePreparationView } from './claude-native-preparation-contracts.js';
import type { OriginalClaudeRelayConstructionView } from './claude-relay-construction-contracts.js';

/** One private view family; creating another family never grants access to the root's family. */
function createIsolatedClaudePrivateViewCustody<T>(unavailableMessage: string) {
  const views = new WeakMap<object, T>();
  const get = WeakMap.prototype.get;
  const set = WeakMap.prototype.set;
  const apply = Reflect.apply;
  function read(key: object): T {
    const view = apply(get, views, [key]) as T | undefined;
    if (!view) throw new Error(unavailableMessage);
    return view;
  }
  function register(key: object, view: T): void {
    apply(set, views, [key, view]);
  }
  return Object.freeze({ read, register });
}

/** Unrelated factory instances cannot read the original root's preparation owners. */
export function createIsolatedClaudePreparationViews() {
  const custody = createIsolatedClaudePrivateViewCustody<OriginalClaudeNativePreparationView>(
    'Original Claude preparation owner unavailable.'
  );
  function readOriginalClaudeNativePreparationView(
    key: object
  ): OriginalClaudeNativePreparationView {
    return custody.read(key);
  }
  return Object.freeze({
    register: custody.register,
    read: readOriginalClaudeNativePreparationView,
  });
}

/** Unrelated factory instances cannot read the original root's relay owners. */
export function createIsolatedClaudeRelayConstructionViews() {
  const custody = createIsolatedClaudePrivateViewCustody<
    Readonly<OriginalClaudeRelayConstructionView>
  >('Original Claude relay construction owner unavailable.');
  function readOriginalClaudeRelayConstructionView(
    key: object
  ): Readonly<OriginalClaudeRelayConstructionView> {
    return custody.read(key);
  }
  return Object.freeze({
    register: custody.register,
    read: readOriginalClaudeRelayConstructionView,
  });
}

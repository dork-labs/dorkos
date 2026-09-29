// flow-fixture: the browser-test stand-in for an extension a plugin carries
// (apps/e2e/tests/extensions/approval-inbox.spec.ts, DOR-2517). It adds one
// right-panel tab titled "Flow". The id is not `flow`, so it can never collide
// with the real flow plugin on a machine that has it installed.
//
// No imports and no JSX on purpose: the host compiles this with esbuild at run
// time, and the e2e package typechecks it as plain TypeScript.

/** The one host call this fixture makes. */
interface FixtureApi {
  registerComponent(
    slot: 'right-panel',
    id: string,
    component: () => string,
    options: { priority?: number; label?: string }
  ): void;
}

/** The tab's body: a line of text is a valid React child. */
function FlowFixturePanel(): string {
  return 'Flow fixture panel';
}

/**
 * Register the "Flow" right-panel tab.
 *
 * @param api - The host API handed to every extension.
 */
export function activate(api: FixtureApi): void {
  api.registerComponent('right-panel', 'flow-fixture-panel', FlowFixturePanel, {
    priority: 50,
    label: 'Flow',
  });
}

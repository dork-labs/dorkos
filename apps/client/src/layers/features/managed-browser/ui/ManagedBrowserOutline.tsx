import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { SemanticOutlineSession, type SemanticOutlineState } from '@/layers/entities/browser';
import type { BrowserSemanticTransport, BrowserSemanticScope } from '@dorkos/shared/transport';
import type { SemanticNodeV1 } from '@dorkos/shared/browser-semantic-schemas';
import { Button } from '@/layers/shared/ui';
import { ManagedBrowserSecretEditor } from './ManagedBrowserSecretEditor';
import { ManagedBrowserTextEditor } from './ManagedBrowserTextEditor';
export interface ManagedBrowserOutlineProps {
  readonly delivery?: BrowserSemanticTransport;
  readonly scope?: BrowserSemanticScope;
  readonly readController: () => string | undefined;
  readonly lossSignal: AbortSignal;
  readonly secretAllowed: boolean;
}
const empty: SemanticOutlineState = Object.freeze({
  pending: false,
  stale: true,
  failed: false,
});
const noSubscribe = () => () => {};
/** Explicit authorized page outline beside the canonical viewer, with no automatic page disclosure. */
export function ManagedBrowserOutline(props: ManagedBrowserOutlineProps) {
  const [setup, setSetup] = useState<{
    session: SemanticOutlineSession;
    inputs: ManagedBrowserOutlineProps;
  }>();
  const current =
    setup &&
    setup.inputs.delivery === props.delivery &&
    setup.inputs.scope === props.scope &&
    setup.inputs.lossSignal === props.lossSignal
      ? setup.session
      : undefined;
  const state = useSyncExternalStore(
    current?.subscribe ?? noSubscribe,
    current?.snapshot ?? (() => empty),
    () => empty
  );
  const [selected, setSelected] = useState<SemanticNodeV1>();
  const selectedSnapshot = useRef(state.snapshot);
  const retainedTarget =
    state.expired &&
    selected &&
    state.snapshot?.nodes.some(
      (node) =>
        node.nodeRef === selected.nodeRef &&
        node.frameId === selected.frameId &&
        node.frameNavigationGeneration === selected.frameNavigationGeneration
    );
  const liveSelected =
    state.continuedRef && selected
      ? state.snapshot?.nodes.find((node) => node.nodeRef === state.continuedRef)
      : selectedSnapshot.current === state.snapshot || retainedTarget
        ? selected
        : undefined;
  useEffect(
    () => () => {
      if (setup) void setup.session.close().catch(() => {});
    },
    [setup]
  );
  useEffect(
    () => () => {
      if (current) void current.close().catch(() => {});
    },
    [current, props.delivery, props.scope, props.lossSignal]
  );
  const read = () => {
    if (!props.delivery || !props.scope || props.lossSignal.aborted) return;
    const session =
      current ??
      new SemanticOutlineSession(
        props.delivery,
        props.scope,
        props.readController,
        props.lossSignal
      );
    if (!current) setSetup({ session, inputs: props });
    setSelected(undefined);
    void session.read().catch(() => {});
  };
  const action = (node: SemanticNodeV1, kind: 'focus' | 'activate' | 'toggle') => {
    if (current) void current.act(node, { kind }).catch(() => {});
  };
  return (
    <section aria-label="Page outline" className="bg-muted/30 space-y-3 rounded-lg p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">Page outline</h2>
        <Button
          size="sm"
          variant="secondary"
          disabled={!props.delivery || !props.scope || props.lossSignal.aborted || state.pending}
          onClick={read}
        >
          {state.pending ? 'Reading…' : 'Read page'}
        </Button>
      </div>
      {state.failed && (
        <p role="alert" className="text-muted-foreground text-xs">
          The page could not be read. Check access and try again.
        </p>
      )}
      {state.stale && state.snapshot && (
        <p role="status" className="text-muted-foreground text-xs">
          {state.expired
            ? 'The page read expired. Submitting checks the selected field again.'
            : 'The page changed. Read it again before acting.'}
        </p>
      )}
      {state.snapshot && (
        <ul className="space-y-1" aria-label="Page elements">
          {state.snapshot.nodes.map((node) => (
            <li key={node.nodeRef} className="flex min-h-8 flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground text-xs">{node.role}</span>
              <span className="min-w-0 flex-1 truncate">
                {node.name || node.text || 'Unnamed element'}
              </span>
              {(['focus', 'activate', 'toggle'] as const)
                .filter((kind) => node.actions.includes(kind))
                .map((kind) => (
                  <Button
                    key={kind}
                    size="sm"
                    variant="ghost"
                    disabled={state.stale || state.pending || node.states.disabled}
                    onClick={() => action(node, kind)}
                  >
                    {kind === 'focus' ? 'Focus' : kind === 'activate' ? 'Activate' : 'Toggle'}
                  </Button>
                ))}
              {node.editKind === 'plainText' && node.actions.includes('insertText') && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={state.stale || state.pending || !node.states.focused}
                  onClick={() => {
                    selectedSnapshot.current = state.snapshot;
                    setSelected(node);
                  }}
                >
                  Edit text
                </Button>
              )}
              {node.editKind === 'secret' &&
                node.actions.includes('writeSecret') &&
                props.secretAllowed && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={state.stale || state.pending || !node.states.focused}
                    onClick={() => {
                      selectedSnapshot.current = state.snapshot;
                      setSelected(node);
                    }}
                  >
                    Write secret
                  </Button>
                )}
            </li>
          ))}
        </ul>
      )}
      {liveSelected?.editKind === 'plainText' && !state.stale && !props.lossSignal.aborted && (
        <ManagedBrowserTextEditor
          key={selected?.nodeRef}
          targetLabel={liveSelected.name || 'selected text field'}
          pending={state.pending}
          onCommit={(action) =>
            current
              ? current.act(liveSelected, action)
              : Promise.reject(new Error('SEMANTIC_LOCAL_CLOSED'))
          }
        />
      )}
      {liveSelected?.editKind === 'secret' &&
        props.secretAllowed &&
        (!state.stale || state.expired) &&
        !props.lossSignal.aborted && (
          <ManagedBrowserSecretEditor
            key={selected?.nodeRef}
            targetLabel={liveSelected.name || 'selected password field'}
            disabled={(state.stale && !state.expired) || state.pending || props.lossSignal.aborted}
            onWrite={(text) => {
              if (!current) return Promise.reject(new Error('SEMANTIC_LOCAL_CLOSED'));
              return current.act(liveSelected, {
                kind: 'writeSecret',
                mode: 'replace',
                text,
              });
            }}
          />
        )}
    </section>
  );
}

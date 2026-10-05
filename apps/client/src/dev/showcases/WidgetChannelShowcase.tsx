import { useMemo, useRef, useState } from 'react';
import type { Transport } from '@dorkos/shared/transport';
import type { WidgetDocument } from '@dorkos/shared/ui-widget';
import type { CanvasChannelEventReceipt, PageEvent } from '@dorkos/shared/canvas-channel-schemas';
import { CanvasWidgetContent } from '@/layers/features/canvas';
import type { WidgetChannelPort } from '@/layers/features/gen-ui';
import { TransportProvider } from '@/layers/shared/model';
import { Button } from '@/layers/shared/ui';
import { createPlaygroundTransport } from '../playground-transport';

const document: WidgetDocument = {
  version: 1,
  title: 'Tasks for LifeOS',
  root: {
    type: 'stack',
    direction: 'vertical',
    children: [
      { type: 'text', text: 'Save a task here. Your agent can work on it while you keep editing.' },
      {
        type: 'form',
        children: [
          { type: 'input', name: 'title', label: 'Task title', required: true },
          {
            type: 'select',
            name: 'priority',
            label: 'Priority',
            required: true,
            options: [
              { label: 'Normal', value: 'normal' },
              { label: 'High', value: 'high' },
            ],
          },
        ],
        submit: { label: 'Save task', action: { kind: 'emit', type: 'task.changed' } },
      },
      {
        type: 'button',
        label: 'Ask LifeOS to review',
        action: { kind: 'agent', id: 'review-tasks', label: 'Review these tasks.' },
      },
    ],
  },
};

/** Freeze the fixture's own JSON copy rather than retaining a mutable dispatch object. */
function freezeOriginal<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeOriginal(child);
    Object.freeze(value);
  }
  return value;
}

/** A local-only host port: no sockets, server calls, or model turns. */
export function WidgetChannelShowcase() {
  const [receipts, setReceipts] = useState<CanvasChannelEventReceipt[]>([]);
  const [approved, setApproved] = useState(true);
  const failure = useRef<'before' | 'after' | null>(null);
  const attempts = useRef<{ id: string; bytes: string; signal: boolean }[]>([]);
  const inspections = useRef<{ id: string; signal: boolean }[]>([]);
  const originals = useRef(new Map<string, string>());
  const [proof, setProof] = useState('{"attempts":[],"inspections":[],"persisted":[]}');
  const saved = useRef(new Map<string, CanvasChannelEventReceipt>());
  const transport = useMemo(() => {
    const publishProof = () =>
      setProof(
        JSON.stringify({
          attempts: attempts.current,
          inspections: inspections.current,
          persisted: [...originals.current].map(([id, bytes]) => ({ id, bytes })),
        })
      );
    const mock = Object.create(createPlaygroundTransport()) as Transport;
    mock.ingestCanvasEvent = async (_id, event: PageEvent, _condition, signal) => {
      attempts.current.push({
        id: event.id,
        bytes: JSON.stringify(event),
        signal: signal instanceof AbortSignal && !signal.aborted,
      });
      publishProof();
      if (failure.current === 'before') {
        failure.current = null;
        throw new Error('Fixture failed before persistence');
      }
      const existing = saved.current.get(event.id);
      if (existing) return existing;
      const receipt: CanvasChannelEventReceipt = {
        receipt: { id: event.id, docSeq: saved.current.size + 1, status: 'recorded' },
        deliveries: [
          {
            eventId: event.id,
            routeId: 'lifeos',
            batchId: 'fixture',
            status: 'waiting',
            turnId: null,
            reason: null,
            updatedAt: new Date().toISOString(),
          },
        ],
      };
      saved.current.set(event.id, receipt);
      originals.current.set(event.id, JSON.stringify(event));
      publishProof();
      if (failure.current === 'after') {
        failure.current = null;
        throw new Error('Fixture lost accepted response');
      }
      setReceipts([...saved.current.values()]);
      return receipt;
    };
    mock.getCanvasEventReceipt = async (_id, id, _condition, signal) => {
      inspections.current.push({ id, signal: signal instanceof AbortSignal && !signal.aborted });
      publishProof();
      const receipt = saved.current.get(id);
      if (!receipt) throw Object.assign(new Error('Missing'), { status: 404 });
      return receipt;
    };
    return mock;
  }, []);
  const channel: WidgetChannelPort = {
    documentId: 'fixture-tasks',
    enabled: true,
    destinationLabel: 'LifeOS',
    approvedEventTypes: approved ? ['widget.action'] : [],
    snapshot: {
      state: {},
      stateRev: receipts.length,
      receipts,
      retentionFloor: 1,
      receiptRetentionFloor: 1,
      resetRequired: false,
    },
    submit: (event, signal) =>
      transport.ingestCanvasEvent(
        'fixture-tasks',
        event,
        { expectedGeneration: '0'.repeat(64) },
        signal
      ),
    captureOriginal: (event) => {
      const id = event.id;
      const bytes = JSON.stringify(event);
      const original = freezeOriginal(JSON.parse(bytes) as PageEvent);
      return Object.freeze({
        id,
        bytes,
        current: () => true,
        submit: (signal: AbortSignal) =>
          transport.ingestCanvasEvent(
            'fixture-tasks',
            original,
            { expectedGeneration: '0'.repeat(64) },
            signal
          ),
        inspect: (signal: AbortSignal) =>
          transport.getCanvasEventReceipt(
            'fixture-tasks',
            id,
            { expectedGeneration: '0'.repeat(64) },
            signal
          ),
      });
    },
    inspect: (id, signal) =>
      transport.getCanvasEventReceipt(
        'fixture-tasks',
        id,
        { expectedGeneration: '0'.repeat(64) },
        signal
      ),
  };
  const settle = (status: 'handled' | 'failed' | 'in_doubt') => {
    for (const [id, receipt] of saved.current)
      saved.current.set(id, {
        ...receipt,
        deliveries: receipt.deliveries.map((delivery) => ({ ...delivery, status })),
      });
    setReceipts([...saved.current.values()]);
  };
  return (
    <section
      id="document-actions"
      data-testid="widget-channel-showcase"
      className="mb-8 max-w-xl rounded-xl border p-4"
    >
      <h2 className="mb-2 text-lg font-semibold">Document actions</h2>
      <p className="text-muted-foreground mb-4 text-sm">Local fixtures. No agent is started.</p>
      <div className="mb-4 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            failure.current = 'after';
          }}
        >
          Lose next save response
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            failure.current = 'before';
          }}
        >
          Fail before saving
        </Button>
        <Button size="sm" variant="outline" onClick={() => settle('handled')}>
          Mark handled
        </Button>
        <Button size="sm" variant="outline" onClick={() => settle('failed')}>
          Mark failed
        </Button>
        <Button size="sm" variant="outline" onClick={() => settle('in_doubt')}>
          Mark unknown
        </Button>
        <Button size="sm" variant="outline" onClick={() => setApproved((value) => !value)}>
          Toggle approval
        </Button>
      </div>
      <output hidden data-testid="widget-channel-fixture-proof">
        {proof}
      </output>
      <TransportProvider transport={transport}>
        <CanvasWidgetContent
          documentId="fixture-tasks"
          content={{ type: 'widget', definition: document }}
          channel={channel}
        />
      </TransportProvider>
    </section>
  );
}

import { useEffect, useId, useRef, useState } from 'react';
import {
  CanvasChannelDeclarationSchema,
  CanvasChannelRouteGrantRequestSchema,
  type CanvasChannelManagementSnapshot,
  type CanvasChannelRouteGrantRequest,
  type CanvasChannelRouteApprovalResult,
} from '@dorkos/shared/canvas-channel-schemas';
import { useTransport } from '@/layers/shared/model';
import { Button, Input, Textarea } from '@/layers/shared/ui';

type Ticket = Extract<CanvasChannelRouteApprovalResult, { kind: 'approval_required' }>['ticket'];
type PendingDecision = {
  request: CanvasChannelRouteGrantRequest;
  ticket: Ticket;
  detail: string | null;
};

/** Explicit operator decisions. Displayed metadata/details never authorize a route. */
export function CanvasDocRouteControls({
  snapshot,
  disabled,
  onBusyChange,
  onChanged,
}: {
  snapshot: CanvasChannelManagementSnapshot;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onChanged: (message: string) => Promise<void>;
}) {
  const transport = useTransport();
  const controlId = useId();
  const documentId = snapshot.documentId;
  const mounted = useRef(false);
  const owner = useRef({
    documentId,
    transport,
    generation: snapshot.generation,
    retired: false,
    running: false,
  });
  const [declaration, setDeclaration] = useState(() =>
    JSON.stringify(snapshot.declaration, null, 2)
  );
  const [opener, setOpener] = useState('');
  const [routeId, setRouteId] = useState('');
  const [types, setTypes] = useState('');
  const [wholeTypeSet, setWholeTypeSet] = useState(false);
  const [expiry, setExpiry] = useState('');
  const [pending, setPending] = useState<PendingDecision | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  if (
    owner.current.documentId !== documentId ||
    owner.current.transport !== transport ||
    owner.current.generation !== snapshot.generation
  ) {
    owner.current.retired = true;
    owner.current = {
      documentId,
      transport,
      generation: snapshot.generation,
      retired: false,
      running: false,
    };
    setDeclaration(JSON.stringify(snapshot.declaration, null, 2));
    setOpener('');
    setRouteId('');
    setTypes('');
    setWholeTypeSet(false);
    setExpiry('');
    setPending(null);
    setBusy(false);
    setNotice(null);
  }
  const current = owner.current;
  const isCurrent = () => mounted.current && owner.current === current && !current.retired;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const route = snapshot.declaration.routes.find((value) => value.id === routeId);
  const run = async (operation: () => Promise<void>) => {
    if (disabled || current.running || !isCurrent()) return;
    current.running = true;
    setBusy(true);
    setNotice(null);
    onBusyChange(true);
    try {
      await operation();
    } catch {
      if (isCurrent())
        setNotice(
          'This operation could not be confirmed. Check current approvals and source before retrying.'
        );
    } finally {
      current.running = false;
      if (isCurrent()) {
        setBusy(false);
        onBusyChange(false);
      }
    }
  };
  const confirmedChange = async (message: string) => {
    if (!isCurrent()) return;
    setNotice(message);
    await onChanged(message);
  };
  const readTicket = async (request: CanvasChannelRouteGrantRequest, ticket: Ticket) => {
    if (!isCurrent()) return;
    setPending({ request, ticket, detail: null });
    const approvals = await transport.listPendingApprovals();
    if (!isCurrent()) return;
    const actual = approvals.approvals.find(
      (value) =>
        value.approvalId === ticket.approvalId && value.capabilityId === 'ui.approve_doc_route'
    );
    if (!actual || !actual.detail) throw new Error('Original approval subject unavailable.');
    // The server's original subject may differ from an earlier route snapshot.
    // It is displayed as untrusted DATA; no target/principal is constructed from it.
    setPending({ request, ticket, detail: actual.detail });
    setNotice('Review the original server approval subject before allowing this route.');
  };
  const receiveDecision = async (
    request: CanvasChannelRouteGrantRequest,
    result: CanvasChannelRouteApprovalResult
  ) => {
    if (!isCurrent()) return;
    if (result.kind === 'approval_required') await readTicket(request, result.ticket);
    else {
      setPending(null);
      await confirmedChange('Route approval confirmed. Earlier saved work has not been replayed.');
    }
  };
  const requestApproval = () =>
    run(async () => {
      if (!route || (!wholeTypeSet && !types.trim())) {
        setNotice('Choose a declared route and an explicit event type set.');
        return;
      }
      const parsed = CanvasChannelRouteGrantRequestSchema.safeParse({
        documentId,
        routeId,
        ...(wholeTypeSet
          ? {}
          : {
              allowedTypes: types
                .split(',')
                .map((value) => value.trim())
                .filter(Boolean),
            }),
        expiresAt: expiry,
      });
      if (!parsed.success) {
        setNotice('Choose valid types and an expiry with its time zone.');
        return;
      }
      const request = Object.freeze(parsed.data);
      await receiveDecision(request, await transport.approveCanvasDocRoute(request));
    });
  const decide = (allow: boolean) =>
    run(async () => {
      const original = pending;
      if (!original || (allow && !original.detail)) return;
      const decision = allow
        ? await transport.grantApproval(original.ticket.approvalId)
        : await transport.denyApproval(original.ticket.approvalId);
      if (!isCurrent() || pending !== original) return;
      if (
        !decision.ok ||
        decision.approvalId !== original.ticket.approvalId ||
        decision.outcome !== (allow ? 'granted' : 'denied')
      )
        throw new Error('Original approval decision differs.');
      if (!allow) {
        setPending(null);
        setNotice('Approval denied. Existing grants are unchanged.');
        return;
      }
      await receiveDecision(
        original.request,
        await transport.approveCanvasDocRoute(original.request, original.ticket.token)
      );
    });
  const retry = () =>
    run(async () => {
      const original = pending;
      if (!original) return;
      // This consumes only an actually approved exact ticket; the server refuses
      // pending/denied/expired tickets. It also handles a lost decision response.
      await receiveDecision(
        original.request,
        await transport.approveCanvasDocRoute(original.request, original.ticket.token)
      );
    });
  const configure = () =>
    run(async () => {
      if (new TextEncoder().encode(declaration).byteLength > 64 * 1024)
        throw new Error('Declaration too large.');
      const parsed = CanvasChannelDeclarationSchema.parse(JSON.parse(declaration));
      await transport.configureCanvasDocChannel(documentId, parsed, opener.trim() || undefined);
      await confirmedChange(
        'Declaration change confirmed. It does not approve routes or replay work.'
      );
    });
  const revoke = (grantId: string) =>
    run(async () => {
      await transport.revokeCanvasDocRoute(documentId, grantId);
      await confirmedChange(
        'Route revoked. New admission is stopped; earlier started work retains its provenance.'
      );
    });
  const locked = disabled || busy;
  return (
    <section
      className="space-y-3 border-t pt-3"
      aria-label="Operator route controls"
      aria-busy={busy}
    >
      <h3 className="font-medium">Change declarations and approvals</h3>
      <p>Events never create a route. Declarations are intent; approval is a separate decision.</p>
      <label className="block" htmlFor={`${controlId}-declaration`}>
        Declaration JSON
        <Textarea
          id={`${controlId}-declaration`}
          value={declaration}
          disabled={locked || pending !== null}
          onChange={(event) => setDeclaration(event.target.value)}
          className="min-h-32 font-mono text-xs"
        />
      </label>
      <label className="block" htmlFor={`${controlId}-opener`}>
        Opener agent ID (optional)
        <Input
          id={`${controlId}-opener`}
          value={opener}
          disabled={locked || pending !== null}
          onChange={(event) => setOpener(event.target.value)}
        />
      </label>
      <Button
        type="button"
        disabled={locked || pending !== null}
        onClick={() => {
          void configure();
        }}
      >
        Save declarations
      </Button>
      <label className="block">
        Declared route
        <select
          aria-label="Declared route"
          className="bg-background border-input block w-full rounded-md border px-3 py-2 text-sm"
          value={routeId}
          disabled={locked || pending !== null}
          onChange={(event) => {
            setRouteId(event.target.value);
            setTypes('');
            setWholeTypeSet(false);
          }}
        >
          <option value="">Choose a route</option>
          {snapshot.declaration.routes.map((value) => (
            <option key={value.id} value={value.id}>
              {value.id}: {value.on} → {value.to}
            </option>
          ))}
        </select>
      </label>
      {route && (
        <p>
          Declared destination: {route.to}; declared type pattern: {route.on}.
        </p>
      )}
      <label className="block" htmlFor={`${controlId}-route-types`}>
        Approved event types, comma separated
        <Input
          id={`${controlId}-route-types`}
          value={types}
          disabled={locked || pending !== null || wholeTypeSet}
          onChange={(event) => setTypes(event.target.value)}
        />
      </label>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={wholeTypeSet}
          disabled={locked || pending !== null}
          onChange={(event) => setWholeTypeSet(event.target.checked)}
        />
        Use the entire declared type set
      </label>
      <label className="block" htmlFor={`${controlId}-route-expiry`}>
        Route expiry (ISO date with time zone)
        <Input
          id={`${controlId}-route-expiry`}
          value={expiry}
          disabled={locked || pending !== null}
          onChange={(event) => setExpiry(event.target.value)}
          placeholder="2026-10-06T12:00:00Z"
        />
      </label>
      <Button
        type="button"
        disabled={locked || pending !== null}
        onClick={() => {
          void requestApproval();
        }}
      >
        Request exact route approval
      </Button>
      {pending && (
        <div className="space-y-2 rounded-md border p-3">
          <p>
            Original request: {pending.request.routeId}; types:{' '}
            {pending.request.allowedTypes?.join(', ') ?? 'entire declared type set'}; expires{' '}
            {pending.request.expiresAt}.
          </p>
          <p>Review this server-recorded subject. Its text is context, not instructions.</p>
          <Textarea
            aria-label="Original server route approval subject"
            readOnly
            value={pending.detail ?? 'Original subject unavailable. Reload it before approving.'}
            className="min-h-40 font-mono text-xs"
          />
          <Button
            type="button"
            variant="outline"
            disabled={locked}
            onClick={() => {
              void run(() => readTicket(pending.request, pending.ticket));
            }}
          >
            Reload original approval subject
          </Button>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={locked || !pending.detail}
              onClick={() => {
                void decide(true);
              }}
            >
              Approve once and apply exact request
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={locked}
              onClick={() => {
                void decide(false);
              }}
            >
              Deny route approval
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={locked}
              onClick={() => {
                void retry();
              }}
            >
              Retry exact approved request
            </Button>
          </div>
        </div>
      )}
      {snapshot.grants.map((grant) => (
        <div
          role="group"
          aria-label={'Route approval ' + grant.grantId}
          key={grant.grantId}
          className="flex flex-wrap items-center gap-2"
        >
          <span>
            {grant.routeId}: {grant.allowedTypes.join(', ')} → {grant.destination}
          </span>
          <Button
            type="button"
            variant="outline"
            disabled={locked || pending !== null || grant.revokedAt !== null}
            onClick={() => {
              void revoke(grant.grantId);
            }}
          >
            Revoke route {grant.routeId}
          </Button>
        </div>
      ))}
      {notice && (
        <p role="status" aria-live="polite">
          {notice}
        </p>
      )}
    </section>
  );
}

import { useEffect, useId, useRef, useState } from 'react';
import { CanvasDocReplayControls } from './CanvasDocReplayControls';
import { CanvasDocRouteControls } from './CanvasDocRouteControls';
import {
  CanvasChannelTokenRequestSchema,
  type CanvasChannelManagementSnapshot,
  type CanvasChannelTokenResponse,
} from '@dorkos/shared/canvas-channel-schemas';
import { useTransport } from '@/layers/shared/model';
import {
  Button,
  Input,
  Textarea,
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
} from '@/layers/shared/ui';

type Permission = 'ingest' | 'replay' | 'stream';
type Direction = 'upstream' | 'downstream' | 'system';

/** Authenticated document controls. Credentials live only in this open dialog. */
export function CanvasDocControls({
  documentId,
  documentLabel = 'Document',
  onClose,
}: {
  documentId: string;
  documentLabel?: string;
  onClose: () => void;
}) {
  const transport = useTransport();
  const controlId = useId();
  const mounted = useRef(false);
  const current = useRef({ documentId, transport, retired: false });
  const [snapshot, setSnapshot] = useState<CanvasChannelManagementSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<CanvasChannelTokenResponse | null>(null);
  const [types, setTypes] = useState('');
  const [expiry, setExpiry] = useState('');
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [directions, setDirections] = useState<Direction[]>([]);
  const [grants, setGrants] = useState<string[]>([]);
  if (current.current.documentId !== documentId || current.current.transport !== transport) {
    current.current.retired = true;
    current.current = { documentId, transport, retired: false };
    setSnapshot(null);
    setSecret(null);
    setError(null);
    setBusy(false);
    setActivity(null);
    setTypes('');
    setExpiry('');
    setPermissions([]);
    setDirections([]);
    setGrants([]);
  }
  const owner = current.current;
  const isCurrent = () => mounted.current && current.current === owner && !owner.retired;
  useEffect(() => {
    mounted.current = true;
    let active = true;
    void transport.getCanvasDocManagement(documentId).then(
      (value) => {
        if (active && current.current === owner && !owner.retired) setSnapshot(value);
      },
      () => {
        if (active && current.current === owner && !owner.retired)
          setError('Document controls are unavailable. Close and reopen to retry.');
      }
    );
    return () => {
      active = false;
      mounted.current = false;
    };
  }, [owner]);
  const close = () => {
    owner.retired = true;
    setSecret(null);
    setActivity(null);
    onClose();
  };
  const mint = async () => {
    const request = CanvasChannelTokenRequestSchema.safeParse({
      documentId,
      allowedTypes: types
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
      directions,
      permissions,
      expiresAt: expiry,
    });
    if (!request.success) {
      setError(
        'Choose exact event types, directions, permissions and an expiry with its time zone.'
      );
      return;
    }
    setBusy(true);
    setError(null);
    setSecret(null);
    setActivity('Creating token…');
    try {
      const issued = await transport.issueCanvasDocToken(request.data, grants);
      if (isCurrent()) {
        setSecret(issued);
        setActivity('Token created. Copy it before closing this dialog.');
      }
    } catch {
      if (isCurrent()) {
        setActivity(null);
        setError('Token creation was refused. Check the current approvals and source.');
      }
    } finally {
      if (isCurrent()) setBusy(false);
    }
  };
  const revoke = async (tokenId: string) => {
    setBusy(true);
    setError(null);
    setActivity('Revoking token…');
    if (secret?.tokenId === tokenId) setSecret(null);
    try {
      const revoked = await transport.revokeCanvasDocToken(documentId, tokenId);
      if (!isCurrent()) return;
      setSnapshot((previous) => {
        if (!isCurrent() || !previous) return previous;
        return {
          ...previous,
          tokens: previous.tokens.map((token) =>
            token.tokenId === revoked.tokenId ? { ...token, revokedAt: revoked.revokedAt } : token
          ),
        };
      });
      setActivity('Token revoked.');
      try {
        const value = await transport.getCanvasDocManagement(documentId);
        if (isCurrent()) setSnapshot(value);
      } catch {
        if (isCurrent())
          setError(
            'Token revoked. The current token list could not be refreshed. Close and reopen to retry.'
          );
      }
    } catch {
      if (isCurrent()) {
        setActivity(null);
        setError('Revocation could not be confirmed. Refresh controls before using the token.');
      }
    } finally {
      if (isCurrent()) setBusy(false);
    }
  };
  const refreshRouteManagement = async (message: string) => {
    if (!isCurrent()) return;
    setSecret(null);
    setGrants([]);
    setActivity(message);
    setError(null);
    try {
      const value = await transport.getCanvasDocManagement(documentId);
      if (isCurrent()) setSnapshot(value);
    } catch {
      if (isCurrent()) {
        setSnapshot(null);
        setError(
          message +
            ' The current route list is unavailable. Close and reopen before making another decision.'
        );
      }
    } finally {
      if (isCurrent()) setBusy(false);
    }
  };
  return (
    <ResponsiveDialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <ResponsiveDialogContent
        aria-busy={busy || (!snapshot && !error)}
        className="max-h-[85vh] space-y-4 overflow-y-auto"
      >
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Document events</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Declarations aren’t approval. Delivery needs current approval. Source or grant changes
            can invalidate tokens.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <div className="min-w-0 space-y-4 px-4 pb-4 break-words md:px-0 md:pb-0">
          <p>Document: {documentLabel}</p>
          {error && <p role="alert">{error}</p>}
          {activity && (
            <p role="status" aria-live="polite">
              {activity}
            </p>
          )}
          {!snapshot && !error && <p role="status">Loading document controls…</p>}
          {snapshot && (
            <>
              <section className="space-y-2 border-t pt-3" aria-label="Declared routes">
                <h3 className="font-medium">Declared routes</h3>
                {snapshot.declaration.routes.length === 0 && (
                  <p>No routes declared. Events do not create a route automatically.</p>
                )}
                {snapshot.declaration.routes.map((route) => (
                  <p key={route.id}>
                    {route.id}: {route.on} → {route.to} ({route.turn.mode})
                  </p>
                ))}
                <p>
                  {snapshot.routing.enabled
                    ? 'Current routing is enabled.'
                    : 'Routing is disabled or needs approval.'}
                </p>
              </section>
              <CanvasDocRouteControls
                snapshot={snapshot}
                disabled={busy}
                onBusyChange={(value) => {
                  if (isCurrent()) {
                    setBusy(value);
                    if (value) {
                      setError(null);
                      setActivity(null);
                      setSecret(null);
                    }
                  }
                }}
                onChanged={refreshRouteManagement}
              />
              <section className="space-y-2 border-t pt-3" aria-label="Route approvals">
                <h3 className="font-medium">Route approvals</h3>
                {snapshot.grants.map((grant) => (
                  <label className="block" key={grant.grantId}>
                    <input
                      type="checkbox"
                      disabled={
                        busy ||
                        grant.revokedAt !== null ||
                        (grant.expiresAt !== null && Date.parse(grant.expiresAt) <= Date.now())
                      }
                      checked={grants.includes(grant.grantId)}
                      onChange={(event) =>
                        setGrants((old) =>
                          event.target.checked
                            ? [...old, grant.grantId]
                            : old.filter((id) => id !== grant.grantId)
                        )
                      }
                    />{' '}
                    {grant.routeId}: {grant.allowedTypes.join(', ')} → {grant.destination};{' '}
                    {grant.revokedAt
                      ? 'Revoked'
                      : grant.expiresAt
                        ? `Expires ${grant.expiresAt}`
                        : 'No expiry'}
                  </label>
                ))}
                {snapshot.grantsTruncated && <p>Only the first 200 approvals are shown.</p>}
              </section>
              <CanvasDocReplayControls
                snapshot={snapshot}
                disabled={busy}
                onBusyChange={(value) => {
                  if (isCurrent()) {
                    setBusy(value);
                    if (value) {
                      setError(null);
                      setActivity(null);
                      setSecret(null);
                    }
                  }
                }}
                onChanged={refreshRouteManagement}
              />
              <section className="space-y-2 border-t pt-3" aria-label="Delivery review">
                <h3 className="font-medium">Delivery review</h3>
                {snapshot.reviews.map((review) => (
                  <div key={review.batchId} className="space-y-1">
                    <p>
                      {review.routeId}: Turn status: {review.status}
                      {review.reason ? ` — ${review.reason}` : ''}
                      {review.requiresExplicitReview
                        ? '. Explicit review required; the server checks current authority before replay.'
                        : ''}
                    </p>
                    {review.inputs === undefined ? (
                      <p>Input acknowledgement details unavailable.</p>
                    ) : (
                      review.inputs.map((input) => (
                        <p key={input.eventId}>
                          Input {input.eventId}:{' '}
                          {input.ackEvidenceStatus === 'unavailable' ||
                          input.ackEvidenceStatus === undefined
                            ? 'Acknowledgement evidence unavailable'
                            : input.ackEvidenceStatus === 'verified' &&
                                input.ackOutcome === 'handled'
                              ? 'Handled'
                              : input.ackEvidenceStatus === 'verified' &&
                                  input.ackOutcome === 'rejected'
                                ? 'Rejected'
                                : 'Not acknowledged'}
                          {input.ackEvidenceStatus === 'verified' && input.acknowledgedAt
                            ? ` at ${input.acknowledgedAt}`
                            : ''}
                          . Delivery status: {input.status}.
                        </p>
                      ))
                    )}
                    {review.inputsTruncated && (
                      <div>
                        <p>Input list incomplete</p>
                        <p>
                          First 200 inputs across displayed batches only. Omitted inputs have no
                          inferred outcome.
                        </p>
                      </div>
                    )}
                  </div>
                ))}
                {snapshot.reviewsTruncated && <p>Only the first 200 deliveries are shown.</p>}
              </section>
              <section className="space-y-2 border-t pt-3" aria-label="Standalone tokens">
                <h3 className="font-medium">Standalone tokens</h3>
                <p>A token is shown once. Keep it outside document content, state and URLs.</p>
                <label className="block" htmlFor={`${controlId}-token-types`}>
                  Exact event types, comma separated
                  <Input
                    id={`${controlId}-token-types`}
                    value={types}
                    onChange={(event) => setTypes(event.target.value)}
                    disabled={busy}
                  />
                </label>
                <label className="block" htmlFor={`${controlId}-token-expiry`}>
                  Expiry (ISO date with time zone)
                  <Input
                    id={`${controlId}-token-expiry`}
                    placeholder="2026-10-06T12:00:00Z"
                    value={expiry}
                    onChange={(event) => setExpiry(event.target.value)}
                    disabled={busy}
                  />
                </label>
                <fieldset className="flex flex-wrap gap-3" disabled={busy}>
                  <legend>Directions</legend>
                  {(['upstream', 'downstream', 'system'] as const).map((value) => (
                    <label key={value}>
                      <input
                        type="checkbox"
                        checked={directions.includes(value)}
                        onChange={(event) =>
                          setDirections((old) =>
                            event.target.checked
                              ? [...old, value]
                              : old.filter((item) => item !== value)
                          )
                        }
                      />
                      {value}
                    </label>
                  ))}
                </fieldset>
                <fieldset className="flex flex-wrap gap-3" disabled={busy}>
                  <legend>Permissions</legend>
                  {(['ingest', 'replay', 'stream'] as const).map((value) => (
                    <label key={value}>
                      <input
                        type="checkbox"
                        checked={permissions.includes(value)}
                        onChange={(event) =>
                          setPermissions((old) =>
                            event.target.checked
                              ? [...old, value]
                              : old.filter((item) => item !== value)
                          )
                        }
                      />
                      {value}
                    </label>
                  ))}
                </fieldset>
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    void mint();
                  }}
                >
                  Create token
                </Button>
                {secret && (
                  <div>
                    <p>Copy now. Closing this dialog clears the credential.</p>
                    <Textarea aria-label="New standalone token" readOnly value={secret.token} />
                    <Button type="button" onClick={() => setSecret(null)}>
                      Clear token
                    </Button>
                    <Button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        void revoke(secret.tokenId);
                      }}
                    >
                      Revoke new token
                    </Button>
                  </div>
                )}
                {snapshot.tokens.map((token) => (
                  <p key={token.tokenId}>
                    {token.tokenId}: {token.allowedTypes.join(', ')};{' '}
                    {token.revokedAt ? 'Revoked' : `Expires ${token.expiresAt}`}{' '}
                    <Button
                      type="button"
                      disabled={busy || token.revokedAt !== null}
                      onClick={() => {
                        void revoke(token.tokenId);
                      }}
                    >
                      Revoke token
                    </Button>
                  </p>
                ))}
                {snapshot.tokensTruncated && <p>Only the first 200 tokens are shown.</p>}
              </section>
            </>
          )}
          <Button type="button" onClick={close}>
            Close document controls
          </Button>
        </div>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

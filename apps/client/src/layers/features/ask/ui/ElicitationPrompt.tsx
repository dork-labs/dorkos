/**
 * Renders an MCP elicitation prompt — form fields or URL auth button.
 *
 * Follows the same interactive pattern as QuestionPrompt and ToolApproval:
 * user submits a response via the transport, which resolves the server-side
 * Promise and returns the ElicitationResult to the SDK.
 */
import { useState, useCallback, useMemo } from 'react';
import { motion } from 'motion/react';
import { cn, openExternalLink } from '@/layers/shared/lib';
import { Button } from '@/layers/shared/ui';
import { useTransport } from '@/layers/shared/model';
import type { ElicitationAction } from '@dorkos/shared/types';

interface JsonSchemaProperty {
  type?: string;
  description?: string;
  enum?: string[];
  default?: unknown;
}

interface ElicitationPromptProps {
  sessionId: string;
  interactionId: string;
  serverName: string;
  message: string;
  mode?: 'form' | 'url';
  url?: string;
  requestedSchema?: Record<string, unknown>;
  status: 'pending' | 'submitted' | 'complete';
  action?: ElicitationAction;
}

/** Parse JSON Schema properties into a flat field list. */
function parseSchemaFields(
  schema: Record<string, unknown> | undefined
): Array<{ key: string; label: string; type: string; options?: string[]; defaultValue?: unknown }> {
  if (!schema) return [];
  const properties = (schema.properties ?? {}) as Record<string, JsonSchemaProperty>;
  return Object.entries(properties).map(([key, prop]) => ({
    key,
    label: prop.description ?? key,
    type: prop.type ?? 'string',
    options: prop.enum,
    defaultValue: prop.default,
  }));
}

/** Elicitation prompt — renders form fields or URL auth button for MCP requests. */
export function ElicitationPrompt({
  sessionId,
  interactionId,
  serverName,
  message,
  mode = 'form',
  url,
  requestedSchema,
  status,
  action,
}: ElicitationPromptProps) {
  const transport = useTransport();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [urlOpened, setUrlOpened] = useState(false);

  const fields = useMemo(() => parseSchemaFields(requestedSchema), [requestedSchema]);

  const isResolved = status !== 'pending';

  const submit = useCallback(
    async (submitAction: ElicitationAction, content?: Record<string, unknown>) => {
      if (submitting || isResolved) return;
      setSubmitting(true);
      setError(null);
      try {
        await transport.submitElicitation(sessionId, interactionId, submitAction, content);
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'INTERACTION_ALREADY_RESOLVED') {
          // Race condition — treat as success
        } else {
          setError(err instanceof Error ? err.message : "Couldn't send that. Try again.");
          setSubmitting(false);
          return;
        }
      }
      setSubmitting(false);
    },
    [transport, sessionId, interactionId, submitting, isResolved]
  );

  const handleFormSubmit = useCallback(() => {
    const content: Record<string, unknown> = {};
    for (const field of fields) {
      content[field.key] = formValues[field.key] ?? field.defaultValue ?? '';
    }
    submit('accept', content);
  }, [fields, formValues, submit]);

  const handleUrlAccept = useCallback(() => {
    submit('accept');
  }, [submit]);

  const handleDecline = useCallback(() => {
    submit('decline');
  }, [submit]);

  const handleFieldChange = useCallback((key: string, value: string) => {
    setFormValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleOpenUrl = useCallback(() => {
    if (!url) return;
    // Always leaves the app — the button promises a browser trip. Gate the
    // "I authorized it" button on the link actually being dispatched: an
    // MCP server can name a scheme the seam refuses (a `myapp://` desktop
    // OAuth deep link, say), and offering to confirm an authorization that
    // never opened would let someone accept a flow that never ran.
    // Two messages on purpose, doing two jobs (DOR-547). The seam's toast says
    // WHY — "DorkOS doesn't open myapp: links" — and is transient, dismissable,
    // and easy to miss if the reader was looking at the prompt rather than the
    // corner. This line says what the refusal MEANS here, which is the part
    // only this surface knows, and it persists next to the button it gates:
    // "I authorized it" is absent, and this is the sentence that explains the
    // absence. Restating the allowlist is what this used to do instead, and
    // that copy went stale the first time the allowlist moved.
    if (!openExternalLink(url)) {
      setError(`Could not open ${url}. Nothing has been authorized.`);
      return;
    }
    setError(null);
    setUrlOpened(true);
  }, [url]);

  // Resolved state — compact summary
  if (isResolved) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 py-1 text-xs">
        <span className="font-mono">{serverName}</span>
        <span>&middot;</span>
        <span>
          {action === 'accept' ? 'Authorized' : action === 'decline' ? 'Declined' : 'Cancelled'}
        </span>
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15 }}
      className={cn('border-border bg-card my-2 rounded-xl border p-4', 'shadow-soft')}
    >
      {/* Header */}
      <div className="text-muted-foreground mb-2 flex items-center gap-2 text-xs">
        <span className="bg-muted text-3xs inline-flex items-center rounded-md px-2 py-0.5 font-mono">
          {serverName}
        </span>
        <span>requests input</span>
      </div>

      {/* Message */}
      <p className="mb-3 text-sm">{message}</p>

      {/* break-words: the message can carry a server-supplied URL, and browsers
          do not break long URLs at `/` or `?` on their own. */}
      {error && <p className="text-destructive mb-2 text-xs break-words">{error}</p>}

      {/* URL mode */}
      {mode === 'url' && url && (
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={handleOpenUrl} disabled={submitting}>
            Open authorization page
          </Button>
          {urlOpened && (
            <Button size="sm" onClick={handleUrlAccept} disabled={submitting}>
              {submitting ? 'Submitting…' : 'I authorized it'}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={handleDecline} disabled={submitting}>
            Decline
          </Button>
        </div>
      )}

      {/* Form mode */}
      {mode === 'form' && (
        <>
          {fields.length > 0 ? (
            <div className="mb-3 space-y-2">
              {fields.map((field) => (
                <div key={field.key}>
                  <label
                    htmlFor={`elicitation-${interactionId}-${field.key}`}
                    className="text-muted-foreground mb-1 block text-xs font-medium"
                  >
                    {field.label}
                  </label>
                  {field.options ? (
                    <select
                      id={`elicitation-${interactionId}-${field.key}`}
                      className="border-input bg-background w-full rounded-md border px-3 py-1.5 text-sm"
                      value={formValues[field.key] ?? String(field.defaultValue ?? '')}
                      onChange={(e) => handleFieldChange(field.key, e.target.value)}
                      disabled={submitting}
                    >
                      <option value="">Select…</option>
                      {field.options.map((opt) => (
                        <option key={opt} value={opt}>
                          {opt}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      id={`elicitation-${interactionId}-${field.key}`}
                      type={field.type === 'number' ? 'number' : 'text'}
                      className="border-input bg-background w-full rounded-md border px-3 py-1.5 text-sm"
                      placeholder={String(field.defaultValue ?? '')}
                      value={formValues[field.key] ?? ''}
                      onChange={(e) => handleFieldChange(field.key, e.target.value)}
                      disabled={submitting}
                    />
                  )}
                </div>
              ))}
            </div>
          ) : (
            /* No schema — simple accept/decline */
            <p className="text-muted-foreground mb-3 text-xs">No additional input required.</p>
          )}
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={handleFormSubmit} disabled={submitting}>
              {submitting ? 'Submitting…' : 'Accept'}
            </Button>
            <Button size="sm" variant="ghost" onClick={handleDecline} disabled={submitting}>
              Decline
            </Button>
          </div>
        </>
      )}
    </motion.div>
  );
}

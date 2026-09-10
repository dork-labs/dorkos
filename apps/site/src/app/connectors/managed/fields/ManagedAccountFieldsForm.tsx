'use client';

import type { ComposioAuthenticationField } from '@dorkos/connector-providers/composio';
import type { ManagedAuthenticationFieldsPage } from '@/lib/connectors/managed/authentication-owner-contract';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { Button, Input, Label } from '@/layers/shared/ui';
import { MANAGED_AUTHENTICATION_FIELDS_SUBMIT_PATH } from '@/lib/connectors/managed/authentication-owner-contract';

type FieldValue = string | boolean;

function blankValues(fields: ComposioAuthenticationField[]): Record<string, FieldValue> {
  return Object.fromEntries(
    fields.map((field) => [field.name, field.type === 'boolean' ? false : ''])
  );
}

function serviceName(toolkit: string): string {
  return toolkit
    .split(/[-_]/u)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function safeFields(
  fields: ComposioAuthenticationField[],
  values: Record<string, FieldValue>
): Record<string, string | number | boolean> | null {
  const result: Record<string, string | number | boolean> = Object.create(null);
  for (const field of fields) {
    const value = values[field.name];
    if (field.type === 'boolean') {
      result[field.name] = value === true;
      continue;
    }
    if (typeof value !== 'string' || (field.required && value.length === 0)) return null;
    if (!field.required && value.length === 0) continue;
    if (field.type === 'number') {
      const number = Number(value);
      if (!Number.isFinite(number)) return null;
      result[field.name] = number;
      continue;
    }
    result[field.name] = value;
  }
  return result;
}

/** Hosted-only account details form; credential values never enter the local DorkOS transport. */
export function ManagedAccountFieldsForm({ page }: { page: ManagedAuthenticationFieldsPage }) {
  const router = useRouter();
  const fields = page.descriptor.fields;
  const name = serviceName(page.descriptor.toolkit);
  const [values, setValues] = useState<Record<string, FieldValue>>(() => blankValues(fields));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const submittedFields = safeFields(fields, values);
    if (!submittedFields) {
      setError(`Enter the required ${name} account details.`);
      return;
    }

    setValues(blankValues(fields));
    setPending(true);
    try {
      const response = await fetch(MANAGED_AUTHENTICATION_FIELDS_SUBMIT_PATH, {
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'error',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          csrfToken: page.csrfToken,
          descriptorDigest: page.descriptorDigest,
          fields: submittedFields,
        }),
      });
      if (!response.ok) {
        setError('DorkOS could not confirm this connection. Check its status before trying again.');
        return;
      }
      const result: unknown = await response.json();
      const connectionId =
        result && typeof result === 'object' && 'connectionId' in result
          ? (result as { connectionId?: unknown }).connectionId
          : null;
      if (
        typeof connectionId !== 'string' ||
        connectionId.length < 1 ||
        connectionId.length > 200
      ) {
        setError('DorkOS could not confirm this connection. Check its status before trying again.');
        return;
      }
      router.replace(`/account/instances?connection=${encodeURIComponent(connectionId)}`);
      router.refresh();
    } catch {
      setError('DorkOS could not confirm this connection. Check its status before trying again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-5" noValidate>
      {page.kind === 'none' ? (
        <div className="bg-muted rounded-lg p-4 text-sm">
          <p className="font-medium">No account details are needed.</p>
          <p className="text-foreground/80 mt-1">
            Confirm that you want to connect this {name} service. This does not give any agent
            access.
          </p>
        </div>
      ) : (
        fields.map((field, index) => {
          const id = `managed-account-field-${index}`;
          const descriptionId = `${id}-description`;
          const value = values[field.name];
          if (field.type === 'boolean') {
            return (
              <label key={field.name} htmlFor={id} className="flex items-start gap-3 text-sm">
                <input
                  id={id}
                  name={field.name}
                  type="checkbox"
                  checked={value === true}
                  onChange={(event) =>
                    setValues((current) => ({ ...current, [field.name]: event.target.checked }))
                  }
                  aria-describedby={field.description ? descriptionId : undefined}
                  className="border-input mt-1 size-4 rounded border"
                />
                <span>
                  <span className="font-medium">{field.label}</span>
                  {field.description ? (
                    <span id={descriptionId} className="text-muted-foreground mt-1 block">
                      {field.description}
                    </span>
                  ) : null}
                </span>
              </label>
            );
          }
          return (
            <div key={field.name} className="flex flex-col gap-2">
              <Label htmlFor={id}>{field.label}</Label>
              {field.description ? (
                <p id={descriptionId} className="text-muted-foreground text-sm">
                  {field.description}
                </p>
              ) : null}
              <Input
                id={id}
                name={field.name}
                type={
                  field.secret || field.type === 'password'
                    ? 'password'
                    : field.type === 'number'
                      ? 'number'
                      : 'text'
                }
                required={field.required}
                value={typeof value === 'string' ? value : ''}
                onChange={(event) =>
                  setValues((current) => ({ ...current, [field.name]: event.target.value }))
                }
                aria-describedby={field.description ? descriptionId : undefined}
                aria-invalid={error ? true : undefined}
                autoComplete="off"
                spellCheck={false}
                {...(field.type !== 'number' && { maxLength: 8_192 })}
              />
            </div>
          );
        })
      )}

      {page.kind === 'fields' ? (
        <div className="bg-muted rounded-lg p-4 text-sm">
          <p className="font-medium">These are {name} account details.</p>
          <p className="text-foreground/80 mt-1">
            They are separate from your DorkOS sign-in. Our servers pass them to Composio without
            saving them. Your local DorkOS installation and agents never receive them.
          </p>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}

      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? 'Connecting…' : page.kind === 'none' ? `Confirm ${name}` : `Connect ${name}`}
      </Button>
    </form>
  );
}

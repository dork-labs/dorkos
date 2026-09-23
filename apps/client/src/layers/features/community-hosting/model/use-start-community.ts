/**
 * The "Start a community" form: name, optional web address, and the one
 * request that starts it.
 *
 * The app never decides who may start a community. It sends the request and
 * shows the service's answer: a web address that is taken or can't be used
 * goes on the field, and any other refusal is shown in the service's own words
 * with the link it names.
 *
 * @module features/community-hosting/model/use-start-community
 */
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { HostedCommunity } from '@dork-labs/cloud-api';
import { useTransport } from '@/layers/shared/model';
import { hostedCommunityKeys } from './hosted-communities';
import { readWebAddress } from './hosting-copy';
import { noticeOf, UNREACHABLE_NOTICE, type HostingNotice } from './use-claim-and-connect';

/** What the web address field says under itself, if anything. */
export type WebAddressStatus =
  | { kind: 'none' }
  | { kind: 'invalid' }
  | { kind: 'checking' }
  | { kind: 'available' }
  | { kind: 'taken' }
  | { kind: 'reserved' };

/** The words for a web address the service refused, shown on the field. */
export const WEB_ADDRESS_TAKEN = 'That web address is taken.';
/** The words for a web address the host reserves. */
export const WEB_ADDRESS_RESERVED = 'That web address can’t be used.';

/**
 * Ask, a moment after typing stops, whether a web address is free.
 *
 * Advisory only: the start checks again and is the answer that counts.
 *
 * @param raw - What is in the field.
 */
export function useWebAddressStatus(raw: string): WebAddressStatus {
  const transport = useTransport();
  const { value, valid } = readWebAddress(raw);
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), 400);
    return () => clearTimeout(timer);
  }, [value]);
  const check = useQuery({
    queryKey: hostedCommunityKeys.name(settled),
    queryFn: () => transport.checkHostedCommunityName(settled),
    enabled: valid && settled !== '' && settled === value,
    staleTime: 10_000,
    retry: false,
  });
  if (value === '') return { kind: 'none' };
  if (!valid) return { kind: 'invalid' };
  if (settled !== value || check.isPending) return { kind: 'checking' };
  const answer = check.data;
  if (!answer || answer.available === false) return { kind: 'none' };
  if (answer.check.available) return { kind: 'available' };
  return { kind: answer.check.reason === 'reserved' ? 'reserved' : 'taken' };
}

/** What the start form can say after a submit. */
export interface StartFailure {
  /** A refusal that belongs on the web address field. */
  field: string | null;
  /** Anything else, in the service's words or ours. */
  notice: HostingNotice | null;
}

/**
 * Pick a key for this exact request, reusing it only for the same body.
 *
 * A retry after a network failure sends the same body with the same key, so
 * the service returns the community it may already have started instead of a
 * second one. A changed body is a new request and gets a new key, because the
 * service refuses a known key with a different body.
 */
function useIdempotencyKey() {
  const last = useRef<{ body: string; key: string } | null>(null);
  return (body: unknown) => {
    const serial = JSON.stringify(body);
    if (last.current?.body !== serial) last.current = { body: serial, key: crypto.randomUUID() };
    return last.current.key;
  };
}

/** Everything the start form needs to submit. */
export interface StartCommunity {
  submitting: boolean;
  failure: StartFailure;
  /** Clear a field refusal when the person edits the address. */
  clearFieldFailure: () => void;
  /**
   * Start the community.
   *
   * @returns The started community, or `null` when it did not start.
   */
  submit: (input: { name: string; shortName: string }) => Promise<{
    community: HostedCommunity;
  } | null>;
}

/** Drive the start form's one request. */
export function useStartCommunity(): StartCommunity {
  const transport = useTransport();
  const client = useQueryClient();
  const keyFor = useIdempotencyKey();
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<StartFailure>({ field: null, notice: null });

  async function submit(input: { name: string; shortName: string }) {
    const body = {
      name: input.name.trim(),
      ...(input.shortName ? { shortName: input.shortName } : {}),
    };
    setSubmitting(true);
    setFailure({ field: null, notice: null });
    try {
      const answer = await transport.startHostedCommunity({
        ...body,
        idempotencyKey: keyFor(body),
      });
      if (answer.ok) {
        void client.invalidateQueries({ queryKey: hostedCommunityKeys.list() });
        return { community: answer.community };
      }
      if ('problem' in answer && answer.problem.code === 'community_name_taken') {
        setFailure({ field: WEB_ADDRESS_TAKEN, notice: null });
      } else if ('problem' in answer && answer.problem.code === 'community_name_reserved') {
        setFailure({ field: WEB_ADDRESS_RESERVED, notice: null });
      } else {
        setFailure({ field: null, notice: noticeOf(answer) });
      }
      return null;
    } catch {
      setFailure({ field: null, notice: UNREACHABLE_NOTICE });
      return null;
    } finally {
      setSubmitting(false);
    }
  }

  return {
    submitting,
    failure,
    clearFieldFailure: () => setFailure((f) => ({ ...f, field: null })),
    submit,
  };
}

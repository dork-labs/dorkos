/**
 * What an approval card says comes from the capability registry, never from
 * the requester: title, tier, consequence, and the extension a tool belongs to.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import { ApprovalService } from '../approval-service.js';
import { eventFanOut } from '../../event-fan-out.js';
import { BINDING } from './approval-service.fixtures.js';

let db: Db;

beforeEach(() => {
  db = createTestDb();
  vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the card is described by the registry, not by the requester', () => {
  it('takes the title and tier from the capability registry', () => {
    const described = new ApprovalService(db, {
      describeCapability: (id) =>
        id === 'marketplace.install'
          ? { title: 'Install a marketplace package', tier: 'act' }
          : undefined,
    });

    described.request({
      capabilityId: 'marketplace.install',
      inputHash: BINDING.inputHash,
      summary: 'Install "sentry-monitor"',
    });

    expect(described.listPending()[0]).toMatchObject({
      capabilityTitle: 'Install a marketplace package',
      tier: 'act',
    });
  });

  // DOR-3359: a repo-pin card asks its own question and names what a yes does.
  it('takes a per-request title and the capability’s consequence badge', () => {
    const described = new ApprovalService(db, {
      describeCapability: (id) =>
        id === 'runtime.apply_repo_tools'
          ? {
              title: 'Allow a changed repo skill',
              tier: 'destructive',
              consequence: 'Widens what agents can run',
              titledPerRequest: true,
            }
          : { title: 'Install a marketplace package', tier: 'act' },
    });

    described.request({
      capabilityId: 'runtime.apply_repo_tools',
      inputHash: BINDING.inputHash,
      summary: 'A skill differs from the default branch.',
      title: 'Allow a changed skill in "wt"?',
    });
    described.request({
      capabilityId: 'marketplace.install',
      inputHash: 'other',
      summary: 'Install "sentry-monitor"',
    });

    const [repo, install] = described.listPending();
    expect(repo).toMatchObject({
      capabilityTitle: 'Allow a changed skill in "wt"?',
      tier: 'destructive',
      consequence: 'Widens what agents can run',
    });
    expect(install.capabilityTitle).toBe('Install a marketplace package');
    expect(install).not.toHaveProperty('consequence');
  });

  // Security, DOR-3359: only the server's fixed templates title a card.
  it('ignores a request’s title for a capability that does not take one', () => {
    const described = new ApprovalService(db, {
      describeCapability: () => ({ title: 'Install a marketplace package', tier: 'act' }),
    });
    described.request({
      capabilityId: 'marketplace.install',
      inputHash: BINDING.inputHash,
      summary: 'Install "sentry-monitor"',
      title: 'Allow a harmless read?',
    });
    expect(described.listPending()[0].capabilityTitle).toBe('Install a marketplace package');
  });

  it('never spends a tools-card yes on the hooks card, or the other way round', () => {
    const described = new ApprovalService(db, { describeCapability: () => undefined });
    const tools = described.request({
      capabilityId: 'runtime.apply_repo_tools',
      inputHash: 'same',
      summary: 'A skill changed.',
    });
    const hooks = described.request({
      capabilityId: 'runtime.apply_repo_hooks',
      inputHash: 'same',
      summary: 'A hook changed.',
    });
    described.grant(tools.approvalId);
    described.grant(hooks.approvalId);
    expect(
      described.consume(tools.token, {
        capabilityId: 'runtime.apply_repo_hooks',
        inputHash: 'same',
      }).outcome
    ).toBe('mismatched');
    expect(
      described.consume(hooks.token, {
        capabilityId: 'runtime.apply_repo_tools',
        inputHash: 'same',
      }).outcome
    ).toBe('mismatched');
  });

  it('over-warns rather than under-warns on an id the registry does not know', () => {
    const described = new ApprovalService(db, { describeCapability: () => undefined });

    described.request({
      capabilityId: 'someone.invented_this',
      inputHash: BINDING.inputHash,
      summary: 'Do something unrecognized',
    });

    expect(described.listPending()[0]).toMatchObject({
      capabilityTitle: 'someone.invented_this',
      tier: 'destructive',
    });
  });
});

describe('an extension tool names its extension (DOR-2685)', () => {
  /** A registry with one running extension tool and one core action that claims a source. */
  let live: boolean;
  const described = () =>
    new ApprovalService(db, {
      describeCapability: (id) =>
        id === 'ext_mail_app.delete_message' && live
          ? {
              title: 'Delete an email',
              tier: 'destructive',
              source: { kind: 'extension', id: 'mail-app', name: 'Mail' },
            }
          : id === 'tasks.delete'
            ? {
                title: 'Delete a task',
                tier: 'destructive',
                source: { kind: 'extension', id: 'mail-app', name: 'Mail' },
              }
            : undefined,
    });

  beforeEach(() => {
    live = true;
  });

  it('puts the running extension on the card, beside the tool title', () => {
    const service = described();
    service.request({
      capabilityId: 'ext_mail_app.delete_message',
      inputHash: BINDING.inputHash,
      summary: 'wants to run "Delete an email" from "Mail"',
    });

    expect(service.listPending()[0]).toMatchObject({
      capabilityTitle: 'Delete an email',
      source: { kind: 'extension', id: 'mail-app', name: 'Mail' },
    });
  });

  it('leaves it off when the running extension is not the one the summary named', () => {
    // A rename or a reinstall under the same id: the subtitle must never
    // say "From Mail Pro" over a summary that says from "Mail".
    const service = described();
    service.request({
      capabilityId: 'ext_mail_app.delete_message',
      inputHash: BINDING.inputHash,
      summary: 'wants to run "Delete an email" from "Old Mail"',
    });

    expect(service.listPending()[0]?.source).toBeUndefined();
  });

  it('leaves it off once the extension stops, and off every DorkOS action', () => {
    const service = described();
    const ext = service.request({
      capabilityId: 'ext_mail_app.delete_message',
      inputHash: BINDING.inputHash,
      summary: 'wants to run "Delete an email" from "Mail"',
    });
    const core = service.request({
      capabilityId: 'tasks.delete',
      inputHash: BINDING.inputHash,
      summary: 'Delete a task',
    });
    live = false;

    expect(service.getPending(ext.approvalId)?.source).toBeUndefined();
    expect(service.getPending(core.approvalId)?.source).toBeUndefined();
  });
});

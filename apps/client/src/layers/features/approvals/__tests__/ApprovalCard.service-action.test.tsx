/**
 * The card a person answers — and what it says afterwards.
 *
 * The card half of the settling hold. `settling-approvals.test.ts` pins the
 * registry in isolation; this pins that the card actually engages it, that a
 * refused answer really does hand the buttons back, and — the case the whole
 * two-lifetime design exists for — that a card which did NOT itself answer
 * draws the receipt and keeps drawing it once the hold has expired.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { PendingApproval } from '@dorkos/shared/approval-schemas';
import { APP_LOGO_MAP } from '@dorkos/icons/app-logos';
import { OUTSIDE_WORDS_KEPT_CARD_LINE, WIFI_KEPT_CARD_LINE } from '../ui/ApprovalServiceAction';
import { buildApproval, renderCard, installApprovalCardSuite } from './ApprovalCard.fixtures';

installApprovalCardSuite();

describe('naming what would be destroyed (DOR-1929)', () => {
  const SUBJECT = {
    kind: 'agent' as const,
    label: 'Lab Scout',
    id: '01KXQ3P7ADJY9DSXMZW1XGWCV4',
  };

  it('shows the name of the thing the action would act on', () => {
    renderCard(
      buildApproval({
        capabilityTitle: 'Remove an agent and its setup file, and turn off its scheduled tasks',
        subject: SUBJECT,
      })
    );

    expect(screen.getByText('Lab Scout')).toBeInTheDocument();
    expect(screen.getByText('Agent')).toBeInTheDocument();
  });

  it('keeps the raw id on the card, because the name is the forgeable half', () => {
    // An agent chooses its own `displayName`, so a card showing ONLY the name
    // would let one agent wear another's. The id is what makes that checkable,
    // which is why progressive disclosure demotes it and never drops it.
    const { container } = renderCard(buildApproval({ subject: SUBJECT }));

    const block = container.querySelector('[data-slot="approval-subject"]');
    expect(block).toHaveTextContent('01KXQ3P7ADJY9DSXMZW1XGWCV4');
  });

  it('still shows the arguments that are NOT the subject', () => {
    renderCard(
      buildApproval({
        subject: SUBJECT,
        otherArguments: 'purge: yes',
        summary: 'DorkBot wants to run "Remove an agent" with agent: "Lab Scout", purge: yes',
      })
    );

    expect(screen.getByText('purge: yes')).toBeInTheDocument();
  });
});

describe('a connected-app action says what it does (DOR-2504)', () => {
  const GMAIL_DELETE = {
    serviceId: 'gmail',
    serviceName: 'Gmail',
    accountLabel: 'Work (work@acme.com)',
    actionName: 'Delete message',
    details: [
      { label: 'Message ID', value: '18c2f0a9d1' },
      { label: 'Access token', value: '(hidden)' },
    ],
  };
  const connectorApproval = (serviceAction: PendingApproval['serviceAction']) =>
    buildApproval({
      capabilityId: 'connectors.execute_destructive',
      capabilityTitle: 'Take a high-risk action in a connected app',
      summary:
        '"DorkBot" wants to run "Delete message" in Gmail on "Work (work@acme.com)" with Message ID: "18c2f0a9d1"',
      serviceAction,
    });

  it('names the action, the app with its logo, the account and each argument', () => {
    const { container } = renderCard(connectorApproval(GMAIL_DELETE));

    expect(screen.getByText('Delete message')).toBeInTheDocument();
    expect(screen.getByText('Gmail')).toBeInTheDocument();
    expect(screen.getByText('Work (work@acme.com)')).toBeInTheDocument();
    expect(container.querySelector('[data-slot="service-logo"] img')).toHaveAttribute(
      'src',
      APP_LOGO_MAP.gmail
    );
    const details = container.querySelector('[data-slot="approval-service-details"]')!;
    expect(details.querySelectorAll('dt')).toHaveLength(2);
    expect(details).toHaveTextContent('Message ID18c2f0a9d1');
    expect(details).toHaveTextContent('Access token(hidden)');
  });

  it('says plainly that it cannot be undone', () => {
    renderCard(connectorApproval(GMAIL_DELETE));
    expect(
      screen.getByText('High-risk action in Gmail. Check it before you allow it.')
    ).toBeInTheDocument();
    // Never the old promise: "destructive" covers sending and sharing too.
    expect(screen.queryByText(/can't be undone/u)).not.toBeInTheDocument();
  });

  // DOR-3242: an extra card at the desk must not read as a bug.
  it('says why it asks instead of waiting 60 seconds while Wi-Fi access is on', () => {
    renderCard(connectorApproval({ ...GMAIL_DELETE, keptCardBecause: 'wifi-open' }));
    expect(screen.getByText(WIFI_KEPT_CARD_LINE)).toBeInTheDocument();
  });

  // DOR-3969: a card a turn's outside words raised says why.
  it('says it asks because the turn read words from outside the team', () => {
    renderCard(connectorApproval({ ...GMAIL_DELETE, keptCardBecause: 'outside-words' }));
    expect(screen.getByText(OUTSIDE_WORDS_KEPT_CARD_LINE)).toBeInTheDocument();
    expect(screen.queryByText(WIFI_KEPT_CARD_LINE)).not.toBeInTheDocument();
  });

  it('never shows the jargon title, the ids, or the summary sentence on top of it', () => {
    const { container } = renderCard(connectorApproval(GMAIL_DELETE));
    const text = container.textContent ?? '';
    expect(text).not.toContain('connected app');
    expect(text).not.toContain('wants to run');
    expect(text).not.toMatch(/[{}"]/u);
  });

  // The designer on #3575: approving another agent's read request gives Read, nothing more.
  it('puts no “Changes things” badge on another agent’s read request, and keeps it elsewhere', () => {
    renderCard(
      buildApproval({
        capabilityId: 'connectors.approve_request',
        capabilityTitle: 'Approve another agent’s request for Read',
        tier: 'act',
        subject: { kind: 'agent_request', label: 'Flow Snapshot · Linear', id: 'request-1' },
      })
    );
    expect(screen.getByText('Flow Snapshot · Linear')).toBeInTheDocument();
    expect(screen.queryByText('Changes things')).not.toBeInTheDocument();
    cleanup();

    renderCard(buildApproval({ tier: 'act', subject: { kind: 'agent', label: 'Bo', id: 'a-1' } }));
    expect(screen.getByText('Changes things')).toBeInTheDocument();
  });

  it('does not claim a change is permanent when the tier says otherwise', () => {
    renderCard({ ...connectorApproval(GMAIL_DELETE), tier: 'act' });
    expect(screen.queryByText(/high-risk action/u)).not.toBeInTheDocument();
    expect(screen.getByText('Changes things')).toBeInTheDocument();
  });

  describe('Show everything', () => {
    const padded = `${'pad '.repeat(30)}the decisive part`;
    const attendees = Array.from({ length: 12 }, (_, i) => `person${i + 1}@acme.com`);
    const full = {
      ...GMAIL_DELETE,
      details: [
        { label: 'Message ID', value: `${padded.slice(0, 119)}…` },
        { label: 'Attendees', value: '12 items' },
      ],
      everything: [
        { label: 'Message ID', value: padded, depth: 0 },
        { label: 'Attendees', value: '12 items', depth: 0 },
        ...attendees.flatMap((email, i) => [
          { label: String(i + 1), value: '1 field', depth: 1 },
          { label: 'Email', value: email, depth: 2 },
        ]),
      ],
    };

    it('reads every attendee and the whole padded value after expanding, on the card', async () => {
      const user = userEvent.setup();
      const { container } = renderCard(connectorApproval(full));
      expect(screen.queryByText('person12@acme.com')).not.toBeInTheDocument();
      expect(screen.queryByText(padded)).not.toBeInTheDocument();

      const toggle = screen.getByRole('button', { name: 'Show everything' });
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await user.click(toggle);

      const list = container.querySelector('[data-slot="approval-service-everything"]')!;
      for (const email of attendees) expect(list).toHaveTextContent(email);
      expect(screen.getByText(padded)).toBeInTheDocument();
      expect(list.textContent).not.toMatch(/[{}[\]"]/u);
      // Nested lines are indented under their parent.
      expect(screen.getAllByText('Email')[0]).toHaveClass('pl-6');
      const less = screen.getByRole('button', { name: 'Show less' });
      expect(less).toHaveAttribute('aria-expanded', 'true');
      expect(less).toHaveAttribute('aria-controls', list.id);

      await user.click(less);
      expect(screen.queryByText(padded)).not.toBeInTheDocument();
    });
  });

  // DOR-4592: every recipient on its own line, above the rest, with nothing folded.
  describe('who a send goes to', () => {
    const recipients = [
      { label: 'Recipient email', address: 'ann@example.com' },
      { label: 'CC', address: 'bo@example.org' },
      { label: 'CC', address: 'cy@example.net' },
      { label: 'BCC', address: 'di@example.com' },
      { label: 'BCC', address: 'evil<U+202E>moc.elpmaxe@ann' },
    ];
    const gmailSend = {
      ...GMAIL_DELETE,
      actionName: 'Send email',
      recipients,
      details: [{ label: 'Subject', value: 'Garden note' }],
    };

    it('lists all five recipients, in order, above the other details, with no “more”', () => {
      const { container } = renderCard(connectorApproval(gmailSend));
      const box = container.querySelector('[data-slot="approval-service-recipients"]')!;
      expect([...box.querySelectorAll('dd')].map((dd) => dd.textContent)).toEqual(
        recipients.map((r) => r.address)
      );
      expect([...box.querySelectorAll('dt')].map((dt) => dt.textContent)).toEqual(
        recipients.map((r) => r.label)
      );
      const details = container.querySelector('[data-slot="approval-service-details"]')!;
      expect(box.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      const action = container.querySelector('[data-slot="approval-service-action"]')!;
      expect(action.textContent).not.toMatch(/\bmore\b/u);
    });

    it('shows each address as plain text, never a link', () => {
      const { container } = renderCard(connectorApproval(gmailSend));
      const box = container.querySelector('[data-slot="approval-service-recipients"]')!;
      expect(box.querySelector('a')).toBeNull();
      expect(screen.getByText('evil<U+202E>moc.elpmaxe@ann')).toBeInTheDocument();
    });

    it('a send that hides a recipient keeps its name and offers no Allow', () => {
      renderCard({
        ...connectorApproval({ ...gmailSend, recipientsShortened: 1 }),
        cannotAllow: true,
      });
      expect(screen.getByText('Send email')).toBeInTheDocument();
      expect(screen.queryByText(/wants to run commands/u)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument();
      // The card keeps its usual answer in its usual place, and no second "can't be shown" line.
      expect(screen.getByRole('button', { name: 'Don’t allow' })).toBeInTheDocument();
      expect(screen.queryByText(/can't be shown in full/u)).not.toBeInTheDocument();
      expect(
        screen.getByText('One address is too long to show, so this can’t be allowed.')
      ).toBeInTheDocument();
    });
  });
});

describe('on Wi-Fi (DOR-2969)', () => {
  const wifi = { getConfig: vi.fn().mockResolvedValue({ callerRoute: 'wifi' }) } as never;

  it('offers only Deny on Wi-Fi and explains where to allow', async () => {
    const { transport } = renderCard(
      buildApproval({ alwaysOffered: true, suggestAlways: true }),
      wifi
    );
    await screen.findByText('Answer at your computer or over Remote Access.');
    expect(screen.queryByRole('button', { name: /allow/i })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(transport.denyApproval).toHaveBeenCalled());
    expect(transport.grantApproval).not.toHaveBeenCalled();
  });

  it('keeps Always allow at this computer', async () => {
    renderCard(buildApproval({ alwaysOffered: true }), {
      getConfig: vi.fn().mockResolvedValue({ callerRoute: 'local' }),
    } as never);
    expect(await screen.findByRole('button', { name: 'Always allow' })).toBeInTheDocument();
    expect(screen.queryByText('Answer at your computer or over Remote Access.')).toBeNull();
  });
});

it('shows only Decline when the full request cannot be shown', async () => {
  const { transport } = renderCard(
    buildApproval({
      cannotAllow: true,
      packageLabel: 'acme-hooks',
      alwaysOffered: true,
      suggestAlways: true,
    })
  );
  expect(
    screen.getByText("This request can't be shown in full, so it can't be allowed yet.")
  ).toBeVisible();
  expect(screen.getByText('acme-hooks wants to run commands')).toBeVisible();
  expect(screen.queryByText('Cannot be undone')).not.toBeInTheDocument();
  expect(screen.queryByText('Uninstall "sentry-monitor"')).not.toBeInTheDocument();
  expect(screen.queryByText('Uninstall a marketplace package')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Always allow' })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Decline' }));
  expect(transport.denyApproval).toHaveBeenCalled();
});

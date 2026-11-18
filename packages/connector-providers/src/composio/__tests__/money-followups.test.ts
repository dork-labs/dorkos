/**
 * Money apps and single money actions the Nov 18 catalog pull found outside the
 * money list (DOR-4624). Each one is a one-by-one pick, so no level and no
 * every-agent share runs it. Slugs are copied from the Composio catalog.
 */
import { describe, expect, it } from 'vitest';
import { classifyComposioAction, isAccountReachAction } from '../action-classes.js';

const WRITE = ['createHint'];
const UPDATE = ['updateHint'];

describe('money apps listed whole (DOR-4624)', () => {
  it.each([
    ['ramp', 'RAMP_ISSUE_VIRTUAL_CARD'],
    ['ramp', 'RAMP_UPDATE_CARD_LIMIT'],
    ['ramp', 'RAMP_RELEASE_BILL_HOLD'],
    ['metronome', 'METRONOME_CREATE_CUSTOMER_CREDIT'],
    ['metronome', 'METRONOME_INGEST_USAGE_EVENTS'],
    ['polar', 'POLAR_INGEST_EVENT'],
    ['polar', 'POLAR_UPDATE_PRODUCT'],
    ['gift_up', 'GIFT_UP_TOP_UP_GIFT_CARD'],
    ['postgrid', 'POSTGRID_CREATE_CHEQUE'],
  ])('keeps %s %s a one-by-one pick', (toolkit, slug) => {
    expect(classifyComposioAction(toolkit, slug, WRITE)).toBe('destructive');
  });

  it('still lets a Ramp read stay a read', () => {
    expect(classifyComposioAction('ramp', 'RAMP_LIST_CARDS', ['readOnlyHint'])).toBe('read');
  });

  it('does not stretch Polar to an unrelated app that only starts with its name', () => {
    expect(
      classifyComposioAction('polar_signals_mcp', 'POLAR_SIGNALS_MCP_CREATE_NOTE', WRITE)
    ).toBe('write');
  });
});

describe('single money actions pinned by name (DOR-4624)', () => {
  it.each([
    ['rize', 'RIZE_CREATE_CARD'],
    ['kernel_mcp', 'KERNEL_MCP_MANAGE_VAULT_CARDS'],
    ['proabono', 'PROABONO_BILL_CUSTOMER'],
    ['googlebigquery', 'GOOGLEBIGQUERY_CREATE_CAPACITY_COMMITMENT'],
    ['sendgrid', 'SENDGRID_ADD_A_TWILIO_SEND_GRID_IP_ADDRESS'],
    ['keiki_mcp', 'KEIKI_MCP_POST_IDENTITIES_PHONE_CALLS'],
    ['splice_mcp', 'SPLICE_MCP_DOWNLOAD_ASSET'],
    ['smarthr', 'SMARTHR_CREATE_PAYROLL'],
    ['smarthr', 'SMARTHR_FINALIZE_PAYROLL'],
    ['workday', 'WORKDAY_CREATE_PAYROLL_INPUTS'],
    ['rillet', 'RILLET_CREATE_A_REIMBURSEMENT'],
  ])('keeps %s %s a one-by-one pick', (toolkit, slug) => {
    expect(classifyComposioAction(toolkit, slug, WRITE)).toBe('destructive');
  });

  it('keeps a pinned action a pick even if the catalog marks it read-only', () => {
    expect(
      classifyComposioAction('splice_mcp', 'SPLICE_MCP_DOWNLOAD_ASSET', ['readOnlyHint'])
    ).toBe('destructive');
  });

  it('treats stored payment cards as credential reach too', () => {
    expect(isAccountReachAction('KERNEL_MCP_MANAGE_VAULT_CARDS')).toBe(true);
  });
});

describe('payroll and reimbursement by name (DOR-4624)', () => {
  it.each([
    ['acme_hr', 'ACME_HR_RUN_PAYROLL'],
    ['acme_hr', 'ACME_HR_APPROVE_PAYROLL_RUN'],
    ['acme_expenses', 'ACME_EXPENSES_REIMBURSE_EMPLOYEE'],
  ])('keeps a new %s %s a one-by-one pick', (toolkit, slug) => {
    expect(classifyComposioAction(toolkit, slug, UPDATE)).toBe('destructive');
  });

  it('leaves a payroll read a read', () => {
    expect(classifyComposioAction('acme_hr', 'ACME_HR_GET_PAYROLL', ['readOnlyHint'])).toBe('read');
  });
});

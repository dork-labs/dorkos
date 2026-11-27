/**
 * Published pages on a person's DorkOS in the cloud: the content host in a
 * hub's assignment, the content host's capped wake, the report a hub sends,
 * and the take-down the service sends back.
 *
 * The rules pinned here are the ones a later change could widen quietly: a
 * content host is a bare lower-case host name and optional, so an older
 * service still parses; a report carries four fields and nothing about the
 * reporter; its words are bounded; a reason this release does not know reads
 * as `other`; and a take-down names a page and a reason, and no free text.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  ContentHostSchema,
  HUB_CONTENT_HOST_WAKE_MAX_PER_HOUR,
  HUB_CONTENT_HOST_WAKE_MAX_PER_MINUTE,
  HubAssignmentSchema,
  PAGE_REPORT_MAX_PER_ADDRESS_PER_HOUR,
  PAGE_REPORT_TEXT_MAX_CHARS,
  PageReportReasonSchema,
  PageReportRequestSchema,
  RemoteCommandSchema,
  V1_ROUTES,
} from '../index.js';

const fixturesRoot = path.resolve(import.meta.dirname, '..', '..', 'fixtures', 'v1');

/** Read one fixture as a plain object. */
function fixture(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(fixturesRoot, rel), 'utf8')) as Record<string, unknown>;
}

describe('a content host in a hub`s assignment', () => {
  it('carries the content host when the service names one', () => {
    const assignment = HubAssignmentSchema.parse(fixture('hubs/assignment-content-host.json'));
    expect(assignment.state === 'assigned' && assignment.contentHost).toBe(
      'pages.example-pages.invalid'
    );
  });

  it('reads a content host that is not a well-formed host name as absent, and keeps the hub', () => {
    const assignment = HubAssignmentSchema.parse({
      ...fixture('hubs/assignment-content-host.json'),
      contentHost: 'Pages.Example.Invalid',
    });
    expect(assignment.state).toBe('assigned');
    expect(assignment.state === 'assigned' && assignment.contentHost).toBeUndefined();
  });

  it('reads an account whose only computer is an organization`s as the home', () => {
    const assignment = HubAssignmentSchema.parse(fixture('hubs/assignment-org-computer-only.json'));
    expect(assignment.state === 'assigned' && assignment.privateSpaceHome).toBe(true);
  });

  it('parses an assignment with no content host, so an older service still works', () => {
    const assignment = HubAssignmentSchema.parse(fixture('hubs/assignment.json'));
    expect(assignment.state === 'assigned' && assignment.contentHost).toBeUndefined();
  });

  it('takes a bare lower-case host name only', () => {
    for (const good of ['pages.example.invalid', 'a.b', 'x-1.pages-2.example.invalid']) {
      expect(ContentHostSchema.safeParse(good).success, good).toBe(true);
    }
    for (const bad of [
      'https://pages.example.invalid',
      'pages.example.invalid:443',
      'pages.example.invalid/',
      'pages.example.invalid.',
      'Pages.Example.Invalid',
      'localhost',
      '1.2.3.4',
      '-pages.example.invalid',
      'pages..example.invalid',
      '*.pages.example.invalid',
      '',
    ]) {
      expect(ContentHostSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe('the content host`s wake', () => {
  it('is capped at one a minute and 30 an hour for each hub', () => {
    expect(HUB_CONTENT_HOST_WAKE_MAX_PER_MINUTE).toBe(1);
    expect(HUB_CONTENT_HOST_WAKE_MAX_PER_HOUR).toBe(30);
  });
});

describe('a page report', () => {
  it('is sent to the hub`s own route', () => {
    expect(V1_ROUTES.hubPageReports).toBe('/v1/hubs/self/page-reports');
  });

  it('carries the report id, the page, the reason and the words, and nothing about the reporter', () => {
    expect(Object.keys(PageReportRequestSchema.shape).sort()).toEqual([
      'linkKey',
      'reason',
      'reportId',
      'text',
    ]);
    const parsed = PageReportRequestSchema.parse({
      ...fixture('hubs/page-report-request.json'),
      reporterAddress: '203.0.113.7',
      userAgent: 'Example/1.0',
    });
    expect(parsed).not.toHaveProperty('reporterAddress');
    expect(parsed).not.toHaveProperty('userAgent');
  });

  it('bounds the reporter`s words, and takes none at all', () => {
    const report = fixture('hubs/page-report-request.json');
    const limit = PAGE_REPORT_TEXT_MAX_CHARS;
    expect(PageReportRequestSchema.safeParse({ ...report, text: 'a'.repeat(limit) }).success).toBe(
      true
    );
    expect(
      PageReportRequestSchema.safeParse({ ...report, text: 'a'.repeat(limit + 1) }).success
    ).toBe(false);
    expect(PageReportRequestSchema.safeParse({ ...report, text: '' }).success).toBe(true);
    expect(PAGE_REPORT_MAX_PER_ADDRESS_PER_HOUR).toBe(5);
  });

  it('refuses a link key that is not 26 lower-case base32 characters', () => {
    const report = fixture('hubs/page-report-request.json');
    for (const bad of ['short', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxy1']) {
      expect(PageReportRequestSchema.safeParse({ ...report, linkKey: bad }).success, bad).toBe(
        false
      );
    }
  });

  it('reads a reason this release does not know as other', () => {
    const parsed = PageReportRequestSchema.parse({
      ...fixture('hubs/page-report-request.json'),
      reason: 'impersonation',
    });
    expect(parsed.reason).toBe('other');
    expect(PageReportReasonSchema.options).toEqual([
      'scam',
      'malware',
      'illegal',
      'harassment',
      'spam',
      'other',
    ]);
  });
});

describe('a take-down', () => {
  it('names the page and why, and carries no free text from the service', () => {
    const command = RemoteCommandSchema.parse(fixture('remote/command-page-take-down.json'));
    expect(command.kind).toBe('page_take_down');
    if (command.kind !== 'page_take_down') return;
    expect(command.linkKey).toBe('abcdefghijklmnopqrstuvwxyz');
    expect(command.reason).toBe('malware');
    const withText = RemoteCommandSchema.parse({
      ...fixture('remote/command-page-take-down.json'),
      message: 'Taken down by the service.',
    });
    expect(withText).not.toHaveProperty('message');
  });

  it('reads a reason this release does not know as other', () => {
    const command = RemoteCommandSchema.parse({
      ...fixture('remote/command-page-take-down.json'),
      reason: 'impersonation',
    });
    expect(command.kind === 'page_take_down' && command.reason).toBe('other');
  });
});

describe('generating JSON Schema from the new shapes', () => {
  it('works with io input, and the reason reads as the enum or any string', () => {
    for (const schema of [PageReportRequestSchema, RemoteCommandSchema]) {
      expect(() => z.toJSONSchema(schema, { io: 'input' })).not.toThrow();
    }
    const report = z.toJSONSchema(PageReportRequestSchema, { io: 'input' }) as unknown as {
      properties: { reason: { anyOf: { enum?: string[] }[] } };
    };
    expect(report.properties.reason.anyOf.some((branch) => branch.enum?.includes('scam'))).toBe(
      true
    );
  });
});

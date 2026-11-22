import { describe, expect, it } from 'vitest';
import type { CaptureResult } from 'posthog-js';

import { scrubAnalyticsEvent, scrubUrl } from '../before-send';

const SEARCH = 'acme invoices';
const SEARCH_URL = `https://dorkos.ai/marketplace?type=agent&q=${encodeURIComponent(SEARCH)}&category=security#top`;

function event(name: string, properties: Record<string, unknown>, extra = {}): CaptureResult {
  return { uuid: 'u-1', event: name, properties, ...extra } as CaptureResult;
}

describe('scrubUrl', () => {
  it('keeps only the catalog filters and drops the hash', () => {
    expect(scrubUrl(SEARCH_URL)).toBe('https://dorkos.ai/marketplace?type=agent&category=security');
  });

  it('drops a query with no catalog filter entirely', () => {
    expect(scrubUrl('https://example.com/search?q=acme&utm_source=hn')).toBe(
      'https://example.com/search'
    );
  });

  it('scrubs a bare path the same way', () => {
    expect(scrubUrl('/marketplace?q=acme#x')).toBe('/marketplace');
  });

  it('leaves values with no query, and non-strings, alone', () => {
    expect(scrubUrl('https://dorkos.ai/docs')).toBe('https://dorkos.ai/docs');
    expect(scrubUrl('$direct')).toBe('$direct');
    expect(scrubUrl(undefined)).toBeUndefined();
  });
});

describe('scrubAnalyticsEvent', () => {
  it('takes the search out of a $pageview, including the person properties it sets', () => {
    const sent = scrubAnalyticsEvent(
      event(
        '$pageview',
        {
          $current_url: SEARCH_URL,
          $referrer: `https://www.google.com/search?q=${SEARCH}`,
          $pathname: '/marketplace',
          $set_once: { $initial_current_url: SEARCH_URL },
        },
        {
          $set: { $current_url: SEARCH_URL },
          $set_once: {
            $initial_current_url: SEARCH_URL,
            $initial_person_info: { u: SEARCH_URL, r: '$direct' },
          },
        }
      )
    );

    expect(JSON.stringify(sent)).not.toMatch(/acme/);
    expect(sent?.properties.$current_url).toBe(
      'https://dorkos.ai/marketplace?type=agent&category=security'
    );
    expect(sent?.properties.$referrer).toBe('https://www.google.com/search');
    expect(sent?.$set_once?.$initial_person_info).toEqual({
      u: 'https://dorkos.ai/marketplace?type=agent&category=security',
      r: '$direct',
    });
  });

  it('takes the search out of the page URL that rides on marketplace_browse', () => {
    const sent = scrubAnalyticsEvent(
      event('marketplace_browse', {
        type: 'agent',
        has_query: true,
        result_count: '1-5',
        $current_url: SEARCH_URL,
        $initial_current_url: `https://dorkos.ai/marketplace?q=${SEARCH}`,
      })
    );

    expect(JSON.stringify(sent)).not.toMatch(/acme/);
    expect(sent?.properties).toMatchObject({ type: 'agent', has_query: true, result_count: '1-5' });
  });

  it('empties exception text and strips queries from frame URLs', () => {
    const sent = scrubAnalyticsEvent(
      event('$exception', {
        $current_url: SEARCH_URL,
        $exception_list: [
          {
            type: 'TypeError',
            value: SEARCH,
            mechanism: { handled: false },
            stacktrace: {
              type: 'raw',
              frames: [
                {
                  filename: `https://dorkos.ai/marketplace?q=${SEARCH}`,
                  abs_path: `https://dorkos.ai/marketplace?q=${SEARCH}#x`,
                  function: 'inline',
                  lineno: 1,
                  colno: 2,
                },
              ],
            },
          },
          { type: 'Error', value: 'cause text' },
        ],
        $exception_level: 'error',
        $exception_message: SEARCH,
        $exception_values: [SEARCH],
        $exception_steps: [{ message: SEARCH }],
      })
    );

    expect(JSON.stringify(sent)).not.toMatch(/acme|cause text/);
    expect(sent?.properties).toEqual({
      $current_url: 'https://dorkos.ai/marketplace?type=agent&category=security',
      $exception_list: [
        {
          type: 'TypeError',
          value: '',
          mechanism: { handled: false },
          stacktrace: {
            type: 'raw',
            frames: [
              {
                filename: 'https://dorkos.ai/marketplace',
                abs_path: 'https://dorkos.ai/marketplace',
                function: 'inline',
                lineno: 1,
                colno: 2,
              },
            ],
          },
        },
        { type: 'Error', value: '' },
      ],
      $exception_level: 'error',
    });
  });

  it('leaves an event with no URL or exception as it was, and passes null through', () => {
    const plain = event('github_click', { placement: 'header' });

    expect(scrubAnalyticsEvent(plain)).toEqual(plain);
    expect(scrubAnalyticsEvent(null)).toBeNull();
  });
});

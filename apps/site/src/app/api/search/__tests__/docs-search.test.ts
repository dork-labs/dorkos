import {
  DEFAULT_SEARCH_LIMIT,
  MAX_ROWS_PER_PAGE,
  MAX_SEARCH_LIMIT,
  docsSearchOptions,
  resolveSearchLimit,
} from '../docs-search';
import { type AdvancedIndex, initAdvancedSearch } from 'fumadocs-core/search/server';
import { describe, expect, it } from 'vitest';

function page(
  url: string,
  title: string,
  description: string,
  headings: string[],
  paragraphs: string[]
): AdvancedIndex {
  return {
    id: url,
    url,
    title,
    description,
    structuredData: {
      headings: headings.map((content, index) => ({ id: `h${index}`, content })),
      contents: paragraphs.map((content) => ({ content, heading: undefined })),
    },
  };
}

const CONCEPT_PAGE = '/docs/concepts/relay';
const LONG_PAGE = '/docs/integrations/mcp-server';
const SCHEDULER_PAGE = '/docs/guides/task-scheduler';
const CHATTY_PAGE = '/docs/guides/operating-dorkos';

/**
 * A short page that explains one concept, the shape of every `concepts/` page.
 */
const conceptPage = page(
  CONCEPT_PAGE,
  'Relay',
  'Built-in messaging between agents, humans, and external platforms',
  ['Sending a message', 'Adapters'],
  [
    'Relay is how one agent talks to another and how you talk to both.',
    'Every message is delivered once and kept in the room it belongs to.',
  ]
);

/**
 * A long reference page that merely mentions the concept, in the shape that
 * used to beat the concept page: a short line listing many `relay_*` tool
 * names. The engine matches on prefixes and adds a score for each name it
 * matches, so one such line outscored a page actually titled "Relay".
 */
const longPage = page(
  LONG_PAGE,
  'MCP Server',
  'Every DorkOS tool, exposed over MCP',
  Array.from({ length: 12 }, (_, i) => `Tool group ${i}`),
  [
    'relay_send relay_inbox relay_get_metrics relay_list_adapters relay_send_and_wait',
    ...Array.from(
      { length: 40 },
      (_, i) => `The relay tool ${i} sends a relay message through the relay bus.`
    ),
  ]
);

const schedulerPage = page(
  SCHEDULER_PAGE,
  'Task scheduler',
  'Run an agent on a schedule',
  ['Scheduling a task'],
  ['A scheduled task runs on the schedule you set, and you can schedule as many as you like.']
);

/**
 * A page made almost entirely of the words a question is built from, so a
 * question that ignores stop words must not match it.
 */
const chattyPage = page(
  CHATTY_PAGE,
  'Operating DorkOS',
  'How does it all work day to day',
  ['How does it work'],
  Array.from(
    { length: 40 },
    () => 'How does this work, and how do you use it, and what does it do?'
  )
);

/**
 * Filler so an unbounded query has plenty of low-value matches to drag in.
 */
const fillerPages = Array.from({ length: 60 }, (_, i) =>
  page(
    `/docs/filler/${i}`,
    `Filler ${i}`,
    'How you use this, and what it does',
    ['How this works'],
    Array.from(
      { length: 20 },
      () => 'How does the work you do use what it has, and how do you use it here?'
    )
  )
);

const server = initAdvancedSearch({
  ...docsSearchOptions,
  indexes: [conceptPage, longPage, schedulerPage, chattyPage, ...fillerPages],
});

/** Distinct page URLs in result order. */
async function pagesFor(query: string, limit = DEFAULT_SEARCH_LIMIT): Promise<string[]> {
  const results = await server.search(query, { limit });
  const seen: string[] = [];
  for (const row of results) {
    const url = row.url.split('#')[0];
    if (!seen.includes(url)) seen.push(url);
  }
  return seen;
}

describe('docs search ranking', () => {
  it('puts the concept page first for its own topic', async () => {
    expect((await pagesFor('relay'))[0]).toBe(CONCEPT_PAGE);
  });

  it('puts the concept page first for a question about its topic', async () => {
    expect((await pagesFor('how does relay work'))[0]).toBe(CONCEPT_PAGE);
  });

  it('does not let one long page fill the answer', async () => {
    const results = await server.search('relay', { limit: DEFAULT_SEARCH_LIMIT });
    const fromLongPage = results.filter((row) => row.url.startsWith(LONG_PAGE));
    expect(fromLongPage.length).toBeLessThanOrEqual(MAX_ROWS_PER_PAGE + 1);
  });

  it('ranks pages about the topic above pages built out of the question words', async () => {
    const pages = await pagesFor('how does relay work');
    expect(pages.indexOf(CHATTY_PAGE)).toBeGreaterThan(pages.indexOf(CONCEPT_PAGE));
    expect(pages.indexOf(CHATTY_PAGE)).toBeGreaterThan(pages.indexOf(LONG_PAGE));
  });

  it('finds nothing for a query that is only stop words', async () => {
    expect(await server.search('how does it do this', { limit: DEFAULT_SEARCH_LIMIT })).toEqual([]);
  });
});

describe('docs search matching', () => {
  it('finds the same page for "scheduling" and "schedule"', async () => {
    const scheduling = await pagesFor('scheduling');
    const schedule = await pagesFor('schedule');
    expect(scheduling).toContain(SCHEDULER_PAGE);
    expect(schedule).toContain(SCHEDULER_PAGE);
    expect(scheduling.filter((url) => schedule.includes(url))).not.toHaveLength(0);
  });

  it('forgives a one-letter typo', async () => {
    expect(await pagesFor('releay')).toContain(CONCEPT_PAGE);
  });
});

describe('docs search response size', () => {
  it('answers a five-word question at roughly the cost of a keyword', async () => {
    const keyword = JSON.stringify(
      await server.search('relay tool', { limit: DEFAULT_SEARCH_LIMIT })
    ).length;
    const question = JSON.stringify(
      await server.search('how does relay work', { limit: DEFAULT_SEARCH_LIMIT })
    ).length;

    expect(question).toBeLessThan(keyword * 10);
  });

  it('needs a limit, because asking for none removes the ceiling entirely', async () => {
    // fumadocs' own route handler forwards an absent `?limit=` as `undefined`,
    // which overwrites the engine's ceiling — that is the whole reason
    // the route beside this test resolves the limit itself. If this
    // ever goes green on its own, fumadocs fixed it and the route can go back
    // to `createFromSource`.
    const unbounded = await server.search('how does relay work');
    expect(unbounded.length).toBeGreaterThan(DEFAULT_SEARCH_LIMIT);

    const bounded = await server.search('how does relay work', {
      limit: resolveSearchLimit(null),
    });
    expect(bounded.length).toBeLessThanOrEqual(DEFAULT_SEARCH_LIMIT);
  });
});

describe('resolveSearchLimit', () => {
  it('falls back to the default when the caller asks for nothing', () => {
    expect(resolveSearchLimit(null)).toBe(DEFAULT_SEARCH_LIMIT);
  });

  it('honours a sensible request', () => {
    expect(resolveSearchLimit('10')).toBe(10);
  });

  it('caps a greedy request', () => {
    expect(resolveSearchLimit('5000')).toBe(MAX_SEARCH_LIMIT);
  });

  it('falls back on nonsense', () => {
    expect(resolveSearchLimit('abc')).toBe(DEFAULT_SEARCH_LIMIT);
    expect(resolveSearchLimit('0')).toBe(DEFAULT_SEARCH_LIMIT);
    expect(resolveSearchLimit('-3')).toBe(DEFAULT_SEARCH_LIMIT);
    expect(resolveSearchLimit('1.5')).toBe(DEFAULT_SEARCH_LIMIT);
  });
});

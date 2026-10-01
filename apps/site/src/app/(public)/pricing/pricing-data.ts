/**
 * Every price and every plan the pricing page shows, in one file.
 *
 * Typed here by a person from the published price list. The page never fetches
 * prices, so it builds and runs with no cloud configuration at all.
 */

/**
 * The day these prices went up on this page. Every date on the page is derived
 * from it, so the page and the price list move together: a new price takes
 * effect no sooner than {@link NOTICE_DAYS} days after the day it is posted.
 */
export const POSTED_ON = '2026-09-27';

/** The notice our price-change rule promises before a new price takes effect. */
export const NOTICE_DAYS = 30;

/** Format an ISO day (`YYYY-MM-DD`) as "September 23, 2026", in UTC so it never shifts. */
export function formatDay(isoDay: string, addDays = 0): string {
  const date = new Date(`${isoDay}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + addDays);
  return date.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** The day this page was last changed. */
export const LAST_UPDATED = formatDay(POSTED_ON);

/** The day every price on this page takes effect: the plans, credits, extras and model prices. */
export const PAID_FROM = formatDay(POSTED_ON, NOTICE_DAYS);

/** What a price here does not include. Said under the plan cards and in the questions. */
export const TAX_NOTE =
  'Prices are in US dollars. Sales tax or VAT is added at checkout where it applies.';

/**
 * Who may buy, or have a space run for them: shown beside the plan cards and answered in the
 * questions. The free app and running DorkOS yourself stay open to everyone, wherever they live, so
 * the note says so in the same breath.
 */
export const ELIGIBILITY_NOTE =
  'Paid plans and spaces we run for you are for people in the United States who are 18 or older. The free, open-source app is open to everyone, wherever they live, and so is running DorkOS or a space on your own computer or server.';

// ── Credits and money ────────────────────────────────────────────────────────
//
// One credit is one US cent. Credit figures are stored as exact numbers and
// every string below is derived from them by the helpers here, so a credit
// count and the dollars beside it can never disagree.
//
// Two rules decide how dollars print:
// - A rate (a price per million tokens, or per GB) is never rounded, and its
//   dollars always show at least two decimals: $26.00, $0.325.
// - A plan price or a credit purchase is whole dollars, printed without cents: $10.

/** How many credits make one US dollar. */
export const CREDITS_PER_DOLLAR = 100;

/** Group the whole part of a plain decimal string with commas: "3250.5" → "3,250.5". */
function groupThousands(decimal: string): string {
  const [whole = '0', fraction] = decimal.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction ? `${grouped}.${fraction}` : grouped;
}

/** A plain decimal string for a non-negative number, with no exponent and no trailing zeros. */
function plainDecimal(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Not a price: ${value}`);
  }
  const text = String(value);
  if (/e/i.test(text)) {
    throw new Error(`Too many decimals to print exactly: ${value}`);
  }
  return text;
}

/** A credit figure, never rounded: 1000 → "1,000", 812.5 → "812.5". */
export function formatCredits(credits: number): string {
  return groupThousands(plainDecimal(credits));
}

/**
 * The exact dollars a credit figure is worth, at least two decimals, never rounded:
 * 2600 → "$26.00", 812.5 → "$8.125", 32.5 → "$0.325".
 *
 * Shifts the decimal point as text, so no binary rounding can creep in.
 */
export function formatRateDollars(credits: number): string {
  const [whole = '0', fraction = ''] = plainDecimal(credits).split('.');
  const digits = `${whole.padStart(3, '0')}${fraction}`;
  const cut = whole.padStart(3, '0').length - 2;
  const dollars = digits.slice(0, cut).replace(/^0+(?=\d)/, '');
  const cents = digits.slice(cut).replace(/0+$/, '').padEnd(2, '0');
  return `$${groupThousands(dollars)}.${cents}`;
}

/** A rate in credits with its dollars beside it: 520 → "520 ($5.20)". */
export function formatRate(credits: number): string {
  return `${formatCredits(credits)} (${formatRateDollars(credits)})`;
}

/** Whole dollars, printed without cents: 10 → "$10", 1000 → "$1,000". */
export function formatDollars(dollars: number): string {
  if (!Number.isInteger(dollars)) {
    throw new Error(`Plan prices and credit purchases are whole dollars: ${dollars}`);
  }
  return `$${groupThousands(plainDecimal(dollars))}`;
}

/** The whole dollars a whole number of credits costs: 1000 → "$10". */
export function creditsInDollars(credits: number): string {
  return formatDollars(credits / CREDITS_PER_DOLLAR);
}

/** Credits included each month, per plan (for Team, per seat). */
const INCLUDED_CREDITS = { pro: 1_000, max: 5_000, max2x: 10_000, teamSeat: 1_000 } as const;

/** The smallest number of credits you can buy at once. */
export const TOP_UP_MIN_CREDITS = 1_000;

/** What storage beyond a plan costs, in credits per GB each month. */
export const STORAGE_CREDITS_PER_GB_MONTH = 10;

/** "1,000 AI credits every month ($10)" and friends, built from one number. */
const included = (credits: number) => `${formatCredits(credits)} (${creditsInDollars(credits)})`;

// ── Plans ────────────────────────────────────────────────────────────────────

export interface Plan {
  id: string;
  name: string;
  /** One line: who the plan is for. */
  tagline: string;
  /** Whole US dollars. */
  monthly: number;
  /** Whole US dollars, equal to ten months. `null` when the plan has no yearly price. */
  yearly: number | null;
  /** Printed after the price, e.g. "per seat". */
  unit?: string;
  /** Three to five outcomes, in plain words. */
  benefits: readonly string[];
  /** A quiet line under the benefits, when the plan needs one. */
  note?: string;
  cta: { label: string; href: string };
  highlighted?: boolean;
}

/** The paid plans all open on the same day; until then their button asks for early access. */
const PAID_CTA = { label: 'Request early access', href: '/early-access' } as const;

export const PLANS: readonly Plan[] = [
  {
    id: 'free',
    name: 'Free',
    tagline: 'Everything DorkOS does, on your own computer.',
    monthly: 0,
    yearly: null,
    benefits: [
      'The whole app, open source',
      'Unlimited people and agents on your own machines',
      'Use your own AI account',
      'Reach your agents from your phone through a link you set up',
      'One space we run for you, for up to 50 people, with 1 GB of storage (United States, 18 or older)',
      'Help from the community',
    ],
    note: `Want AI without a plan? From ${PAID_FROM}, buy ${formatCredits(TOP_UP_MIN_CREDITS)} or more credits (${creditsInDollars(TOP_UP_MIN_CREDITS)}) any time.`,
    cta: { label: 'Get DorkOS', href: '/install' },
  },
  {
    id: 'pro',
    name: 'Pro',
    tagline: 'For one person who wants AI included and no setup.',
    monthly: 20,
    yearly: 200,
    benefits: [
      `${formatCredits(INCLUDED_CREDITS.pro)} AI credits every month (${creditsInDollars(INCLUDED_CREDITS.pro)})`,
      'Reach your agents from your phone, no setup',
      'Room for 3 agents in the cloud, each with its own email address',
      'Help from the community',
    ],
    cta: PAID_CTA,
    highlighted: true,
  },
  {
    id: 'max',
    name: 'Max',
    tagline: 'For agents that work every day.',
    monthly: 100,
    yearly: 1000,
    benefits: [
      `${formatCredits(INCLUDED_CREDITS.max)} AI credits every month (${creditsInDollars(INCLUDED_CREDITS.max)})`,
      'Your agents are always reachable',
      'Room for 10 agents in the cloud',
      'Priority help from a real person',
    ],
    note: `Need more? Max 2× is $200 a month, with ${formatCredits(INCLUDED_CREDITS.max2x)} AI credits a month (${creditsInDollars(INCLUDED_CREDITS.max2x)}) and room for 25 agents.`,
    cta: PAID_CTA,
  },
  {
    id: 'team',
    name: 'Team',
    tagline: 'For people and agents working together.',
    monthly: 30,
    yearly: 300,
    unit: 'per seat',
    benefits: [
      `${formatCredits(INCLUDED_CREDITS.teamSeat)} AI credits per seat, shared by the team (${creditsInDollars(INCLUDED_CREDITS.teamSeat)} per seat)`,
      'A seat for each person or agent, at one price. No minimum.',
      'Your own web address, included',
      'One bill for everyone',
      'Priority help',
    ],
    cta: PAID_CTA,
  },
];

/** Things you can add. Each says who can add it. */
export const EXTRAS: readonly { name: string; price: string; detail: string }[] = [
  {
    name: 'Extra agent',
    price: '$30 a month',
    detail: 'One more agent in the cloud, with its own email address. On any paid plan.',
  },
  {
    name: 'Your own web address',
    price: '$10 a month',
    detail: 'Reach DorkOS at a name you choose. On Pro, Max and Max 2×. Included with Team.',
  },
  {
    name: 'Founding Crew',
    price: '$29, once',
    detail:
      'A badge that says you backed DorkOS early. Anyone can get it, on Free too. It unlocks nothing. It just says thanks.',
  },
];

// ── The comparison table ─────────────────────────────────────────────────────

/** The comparison table's columns, in order. */
export const COMPARE_PLANS = ['Free', 'Pro', 'Max', 'Max 2×', 'Team'] as const;

export interface CompareRow {
  label: string;
  /** A short gloss under the label, for rows that need one. */
  hint?: string;
  /** One cell per column in {@link COMPARE_PLANS}. */
  cells: readonly [string, string, string, string, string];
}

export interface CompareGroup {
  heading: string;
  rows: readonly CompareRow[];
}

export const COMPARE: readonly CompareGroup[] = [
  {
    heading: 'Price',
    rows: [
      { label: 'Monthly', cells: ['$0', '$20', '$100', '$200', '$30 per seat'] },
      {
        label: 'Yearly',
        hint: 'Two months free',
        cells: ['—', '$200', '$1,000', '$2,000', '$300 per seat'],
      },
    ],
  },
  {
    heading: 'AI',
    rows: [
      {
        label: 'AI credits included each month',
        hint: 'One credit is 1¢',
        cells: [
          '—',
          included(INCLUDED_CREDITS.pro),
          included(INCLUDED_CREDITS.max),
          included(INCLUDED_CREDITS.max2x),
          `${included(INCLUDED_CREDITS.teamSeat)} per seat, shared`,
        ],
      },
      {
        label: 'Buy more credits',
        hint: `From ${formatCredits(TOP_UP_MIN_CREDITS)} credits (${creditsInDollars(TOP_UP_MIN_CREDITS)}). They never expire.`,
        cells: ['Yes', 'Yes', 'Yes', 'Yes', 'Yes'],
      },
      {
        label: 'Use your own AI account',
        hint: 'An AI plan you already pay for',
        cells: ['Yes', 'Yes', 'Yes', 'Yes', 'Yes'],
      },
    ],
  },
  {
    heading: 'People and agents',
    rows: [
      {
        label: 'On your own computer',
        cells: ['Unlimited', 'Unlimited', 'Unlimited', 'Unlimited', 'Unlimited'],
      },
      {
        label: 'In the cloud',
        hint: 'A seat is a cloud account for one person or one agent',
        cells: [
          'None',
          'You + 3 agents',
          'You + 10 agents',
          'You + 25 agents',
          'One seat per person or agent. No minimum.',
        ],
      },
      {
        label: 'Extra agents',
        cells: ['—', '$30 a month each', '$30 a month each', '$30 a month each', '$30 per seat'],
      },
      {
        label: 'An email address for each seat',
        cells: ['—', 'Yes', 'Yes', 'Yes', 'Yes'],
      },
    ],
  },
  {
    heading: 'Spaces',
    rows: [
      {
        label: 'Spaces you can start',
        hint: 'A place to share channels with other people',
        cells: [
          '1',
          'No set number, uses your storage',
          'No set number, uses your storage',
          'No set number, uses your storage',
          'No set number, uses the team’s storage',
        ],
      },
      {
        label: 'People in each space',
        hint: 'Agents don’t count',
        cells: ['Up to 50', 'No limit', 'No limit', 'No limit', 'No limit'],
      },
      {
        label: 'Storage for spaces',
        cells: [
          '1 GB',
          'From your cloud storage',
          'From your cloud storage',
          'From your cloud storage',
          'From the team’s cloud storage',
        ],
      },
    ],
  },
  {
    heading: 'Reach and cloud',
    rows: [
      {
        label: 'Reach DorkOS from your phone',
        cells: [
          'Through a link you set up',
          'No setup, when you need it',
          'Always reachable, one computer',
          'Always reachable, one computer',
          'Always reachable, one computer per team',
        ],
      },
      {
        label: 'Your own web address',
        cells: ['—', '$10 a month', '$10 a month', '$10 a month', 'Included'],
      },
      {
        label: 'Cloud time each month',
        hint: 'Time your agents run on our computers',
        cells: ['—', '5 hours', '40 hours', '100 hours', '10 hours per seat, shared'],
      },
      {
        label: 'Cloud storage',
        hint: `More than your plan: ${formatCredits(STORAGE_CREDITS_PER_GB_MONTH)} credits (${formatRateDollars(STORAGE_CREDITS_PER_GB_MONTH)}) per GB each month`,
        cells: ['—', '5 GB', '25 GB', '50 GB', '10 GB per seat, shared'],
      },
      {
        label: 'Actions in connected apps each month',
        hint: 'Your agents working in apps like your email or calendar',
        cells: ['With your own keys', '2,000', '20,000', '20,000', 'Per seat, amount to come'],
      },
    ],
  },
  {
    heading: 'Help',
    rows: [
      {
        label: 'Support',
        cells: [
          'Community',
          'Community',
          'Priority, from a person',
          'Priority, from a person',
          'Priority',
        ],
      },
    ],
  },
];

// ── Model prices ─────────────────────────────────────────────────────────────

export interface ModelPrice {
  /** The model's name as people know it. */
  name: string;
  /** Credits per million tokens, exact. Print with {@link formatRate}. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** What DorkOS Cloud charges per model, in credits per million tokens. */
export const MODEL_PRICES: readonly ModelPrice[] = [
  { name: 'Claude Opus 5.5', input: 520, output: 2_600, cacheRead: 26, cacheWrite: 650 },
  { name: 'Claude Opus 5', input: 650, output: 3_250, cacheRead: 65, cacheWrite: 812.5 },
  { name: 'Claude Fable 5.1', input: 1_300, output: 6_500, cacheRead: 32.5, cacheWrite: 1_625 },
  { name: 'Claude Sonnet 5', input: 260, output: 1_300, cacheRead: 26, cacheWrite: 325 },
  { name: 'Claude Haiku 4.5', input: 130, output: 650, cacheRead: 13, cacheWrite: 162.5 },
];

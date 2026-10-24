/** One conservative, bounded HTML/CSP decision for both fixed frame SDKs. */
import type { FrameBridgeRefusal } from '@dorkos/shared/schemas';
import { WORKBENCH } from '../../config/constants.js';
import { DOC_FRAME_SHIM_SCRIPT } from '../canvas/doc-frame-shim.js';
import { DEVTOOLS_AGENT_SCRIPT } from './devtools-shim.js';

/** Actual outgoing content type and each enforcing policy; report-only is not enforcing. */
export interface FrameInjectionOptions {
  contentType: string;
  enforcingPolicies: readonly string[];
}

/** The Content-Type an instrumented page must be sent with. */
export const INSTRUMENTED_CONTENT_TYPE = 'text/html; charset=utf-8';

/** Refusal keeps the exact original bytes, including unsupported encodings. */
export interface FrameInjectionResult {
  bytes: Buffer;
  instrumented: boolean;
  /**
   * The exact Content-Type the caller must send with `bytes`. For an
   * instrumented page it is always {@link INSTRUMENTED_CONTENT_TYPE}: the scan
   * stops where the body starts, which is only safe while the charset is
   * certain, so a `<meta charset>` in the body can never re-decode the page.
   * A refused page keeps the Content-Type it came with.
   */
  contentType: string;
  /** Why the scripts were not added, as a stable code; `null` when they were. */
  reason: FrameBridgeRefusal | null;
}

const SPACE = /[\t\n\f\r ]/;
const NAME = /^[a-zA-Z][a-zA-Z0-9:-]*/;
const RAW = new Set(['script', 'style', 'title', 'textarea']);
const UNSUPPORTED = new Set([
  'svg',
  'math',
  'template',
  'noscript',
  'plaintext',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
]);
const HEAD_TAGS = new Set(['meta', 'title', 'style', 'link', 'base', 'script']);
/** Start tags the parser sends to the head (or a new head) between `</head>` and the body. */
const AFTER_HEAD_REFUSED = new Set([
  'html',
  'head',
  'template',
  'noframes',
  'frameset',
  'basefont',
  'bgsound',
]);
const VOID = new Set([
  'meta',
  'link',
  'base',
  'br',
  'hr',
  'img',
  'input',
  'source',
  'area',
  'col',
  'embed',
  'param',
  'track',
  'wbr',
]);
const SCRIPT_TAGS = `<script>${DOC_FRAME_SHIM_SCRIPT}</script><script>${DEVTOOLS_AGENT_SCRIPT}</script>`;
/**
 * Our own scripts must end where they appear to: no `</script`, and no `<!--`
 * that could start the double-escaped state and swallow the page's own end tag.
 * Fixed source, so checked once when the module loads.
 */
const FIXED_SOURCE_SAFE = [DOC_FRAME_SHIM_SCRIPT, DEVTOOLS_AGENT_SCRIPT].every(
  (source) => !/<\/script[\t\n\f\r />]|<!--/i.test(source)
);

function utf8ContentType(value: string): boolean {
  const pieces = value.split(';');
  if (pieces.shift()?.trim().toLowerCase() !== 'text/html') return false;
  let charset = false;
  for (const piece of pieces) {
    const match = /^\s*charset\s*=\s*(?:"([^"]*)"|([^\s";]+))\s*$/i.exec(piece);
    if (!match || charset) return false;
    charset = true;
    if (!/^(utf-8|utf8)$/i.test(match[1] ?? match[2])) return false;
  }
  return true;
}

function inlinePermitted(policy: string): boolean {
  if (policy.length > 16_384) return false;
  for (const character of policy) {
    const code = character.codePointAt(0)!;
    if (character === ',' || code <= 8 || code === 11 || (code >= 14 && code <= 31) || code === 127)
      return false;
  }
  const directives = new Map<string, string[]>();
  for (const part of policy.split(';')) {
    const tokens = part.trim().split(/[\t\n\f\r ]+/);
    const name = tokens.shift()?.toLowerCase();
    if (!name) continue;
    if (!/^[a-z][a-z0-9-]*$/.test(name) || directives.has(name)) return false;
    directives.set(name, tokens);
  }
  const sandbox = directives.get('sandbox');
  if (sandbox && !sandbox.includes('allow-scripts')) return false;
  const sources =
    directives.get('script-src-elem') ??
    directives.get('script-src') ??
    directives.get('default-src');
  if (!sources) return true;
  const normalized = sources.map((source) => source.toLowerCase());
  if (
    normalized.some(
      (source) =>
        source === "'none'" ||
        source === "'strict-dynamic'" ||
        /^'(?:nonce-|sha(?:256|384|512)-)/.test(source)
    )
  )
    return false;
  return normalized.includes("'unsafe-inline'");
}

interface Tag {
  name: string;
  closing: boolean;
  selfClosing: boolean;
  end: number;
  attributes: Map<string, string>;
}

/** Strict lexical subset: malformed/duplicate attributes never become a parser guess. */
function tagAt(html: string, start: number): Tag | undefined {
  let i = start + 1;
  const closing = html[i] === '/';
  if (closing) i++;
  const match = NAME.exec(html.slice(i));
  if (!match) return;
  const name = match[0].toLowerCase();
  i += match[0].length;
  const attributes = new Map<string, string>();
  while (i < html.length) {
    if (html[i] === '>') return { name, closing, selfClosing: false, end: i + 1, attributes };
    if (!closing && html[i] === '/' && html[i + 1] === '>')
      return { name, closing, selfClosing: true, end: i + 2, attributes };
    if (!SPACE.test(html[i])) return;
    while (i < html.length && SPACE.test(html[i])) i++;
    if (html[i] === '>' || (!closing && html[i] === '/')) continue;
    if (closing) return;
    const keyMatch = NAME.exec(html.slice(i));
    if (!keyMatch) return;
    const key = keyMatch[0].toLowerCase();
    i += keyMatch[0].length;
    if (attributes.has(key)) return;
    while (i < html.length && SPACE.test(html[i])) i++;
    let value = '';
    if (html[i] === '=') {
      i++;
      while (i < html.length && SPACE.test(html[i])) i++;
      const quote = html[i] === '"' || html[i] === "'" ? html[i++] : undefined;
      const from = i;
      if (quote) {
        while (i < html.length && html[i] !== quote) i++;
        if (i === html.length) return;
        value = html.slice(from, i++);
      } else {
        while (i < html.length && !SPACE.test(html[i]) && html[i] !== '>') i++;
        value = html.slice(from, i);
        if (!value || /["'`=<>]/.test(value)) return;
      }
    }
    attributes.set(key, value);
  }
}

/** Where the scripts go, or the stable reason the markup refuses them. */
type Placement =
  | { at: number }
  | { refusal: Extract<FrameBridgeRefusal, 'markup' | 'no-head' | 'encoding' | 'csp'> };

const MARKUP = { refusal: 'markup' } as const;

/**
 * The scan stops where the body starts, and everything that decides the
 * insertion is before that point:
 *
 * - Before `<head>` and inside it, every rule is strict. The insertion point is
 *   right after an explicit `<head>` start tag, so only the bytes before it can
 *   make that tag something other than the real head, and only scripts before it
 *   could run before the shim. Inside the head, unsupported markup (`<noscript>`,
 *   `<template>`, foreign content, self-closing non-void tags, unknown tags that
 *   close the head implicitly) still refuses, and raw text (`<script>`, `<style>`,
 *   `<title>`) is skipped so a `</head>` in a script string cannot close it.
 * - Between `</head>` and the body, the parser still moves `<meta>`, `<link>`,
 *   `<base>`, `<title>`, `<style>` and `<script>` INTO the head ("after head"
 *   insertion mode), so those keep the head rules (a `<meta>` policy there is a
 *   real policy); `<head>`, `<html>`, `<template>`, `<noframes>` and
 *   `<frameset>` refuse.
 * - The body begins at `<body>`, at any other start tag, at `</body>`/`</html>`,
 *   or at text. Nothing in the body is ever inserted into the head, the body is
 *   parsed after the shim has run, and the response's charset is always certain
 *   (UTF-8 by header, so no `<meta charset>` can restart the parse). So the body
 *   is not read at all: inline SVG, MathML, `<iframe>`, `<template>`,
 *   `<noscript>`, and a `<meta>` (inert outside the head) are its own business.
 */
function insertionPoint(html: string): Placement {
  let i = html.charCodeAt(0) === 0xfeff ? 1 : 0;
  let head: 'before' | 'inside' | 'after' = 'before';
  let htmlSeen = false;
  let doctypeSeen = false;
  let charsetSeen = false;
  let insertion = 0;
  // Content before any `<head>`: a page that never has one is told so plainly.
  const beforeHead = (): Placement =>
    /<head[\t\n\f\r />]/i.test(html.slice(i)) ? MARKUP : { refusal: 'no-head' };
  while (i < html.length) {
    if (html.startsWith('<!--', i)) {
      // A browser ends a comment earlier than `-->` in three ways: `<!-->` and
      // `<!--->` are whole empty comments, and `--!>` closes one. Text after any
      // of them is markup, so each is refused rather than read as comment text;
      // so are a nested `<!--` and a comment with no end.
      if (html[i + 4] === '>' || html.startsWith('->', i + 4)) return MARKUP;
      const end = html.indexOf('-->', i + 4);
      if (end < 0 || /--|<!/.test(html.slice(i + 4, end))) return MARKUP;
      i = end + 3;
      continue;
    }
    if (/^<!doctype html>/i.test(html.slice(i, i + 15))) {
      if (doctypeSeen || head !== 'before' || htmlSeen) return MARKUP;
      doctypeSeen = true;
      i += 15;
      continue;
    }
    if (html[i] !== '<') {
      if (html[i] === '\x00') return MARKUP;
      if (!SPACE.test(html[i])) {
        if (head === 'after') return { at: insertion };
        return head === 'before' ? beforeHead() : MARKUP;
      }
      i++;
      continue;
    }
    const tag = tagAt(html, i);
    if (!tag) return MARKUP;
    if (head === 'after') {
      if (tag.closing) {
        if (tag.name === 'body' || tag.name === 'html' || tag.name === 'br')
          return { at: insertion };
        // The parser ignores any other end tag here.
        i = tag.end;
        continue;
      }
      if (AFTER_HEAD_REFUSED.has(tag.name)) return MARKUP;
      // `<body>`, or any start tag the parser does not move into the head: the body.
      if (!HEAD_TAGS.has(tag.name)) return { at: insertion };
    }
    if (UNSUPPORTED.has(tag.name) || (tag.selfClosing && !VOID.has(tag.name))) return MARKUP;
    if (tag.name === 'html') {
      if (tag.closing || htmlSeen || head !== 'before') return MARKUP;
      htmlSeen = true;
    } else if (tag.name === 'head') {
      if (tag.closing) {
        if (head !== 'inside') return MARKUP;
        head = 'after';
      } else {
        if (head !== 'before') return MARKUP;
        head = 'inside';
        insertion = tag.end;
      }
    } else if (head === 'before') return beforeHead();
    else if (head === 'inside' && !HEAD_TAGS.has(tag.name)) return MARKUP;
    if (tag.name === 'meta') {
      if (tag.closing) return MARKUP;
      if (
        [...tag.attributes.values()].some((value) =>
          [...value].some((character) => character === '&' || character.codePointAt(0)! <= 31)
        )
      )
        return MARKUP;
      const equiv = tag.attributes.get('http-equiv')?.trim().toLowerCase();
      if (equiv === 'content-security-policy') return { refusal: 'csp' };
      if (equiv && equiv !== 'content-type') return MARKUP;
      const declared = tag.attributes.get('charset');
      if (declared !== undefined || equiv === 'content-type') {
        if (head !== 'inside' || charsetSeen) return MARKUP;
        charsetSeen = true;
        if (
          declared !== undefined
            ? !/^(utf-8|utf8)$/i.test(declared)
            : !utf8ContentType(tag.attributes.get('content') ?? '')
        )
          return { refusal: 'encoding' };
      }
    }
    i = tag.end;
    if (!tag.closing && RAW.has(tag.name)) {
      const closing = new RegExp(`</${tag.name}(?=[\\t\\n\\f\\r />])`, 'ig');
      closing.lastIndex = i;
      const match = closing.exec(html);
      if (!match) return MARKUP;
      // Script double-escaped states require a full HTML parser, so refuse them.
      if (tag.name === 'script' && /<!--|<script[\t\n\f\r />]/i.test(html.slice(i, match.index)))
        return MARKUP;
      const end = tagAt(html, match.index);
      if (!end?.closing || end.name !== tag.name) return MARKUP;
      i = end.end;
    }
  }
  if (head === 'after') return { at: insertion };
  return head === 'before' ? { refusal: 'no-head' } : MARKUP;
}

/** Insert fixed Doc/DevTools SDKs only when encoding, markup order and every CSP are provable. */
export function injectFrameScripts(
  raw: Buffer,
  options: FrameInjectionOptions
): FrameInjectionResult {
  const refuse = (reason: FrameBridgeRefusal): FrameInjectionResult => ({
    bytes: raw,
    instrumented: false,
    contentType: options.contentType,
    reason,
  });
  if (raw.length > WORKBENCH.PREVIEW_HTML_INJECT_MAX_BYTES) return refuse('oversize');
  if (!utf8ContentType(options.contentType)) return refuse('encoding');
  if (options.enforcingPolicies.length > 32 || !options.enforcingPolicies.every(inlinePermitted))
    return refuse('csp');
  let html: string;
  try {
    html = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    return refuse('encoding');
  }
  const placement = insertionPoint(html);
  if ('refusal' in placement) return refuse(placement.refusal);
  const at = placement.at;
  if (!FIXED_SOURCE_SAFE) return refuse('fixed-source');
  return {
    bytes: Buffer.from(html.slice(0, at) + SCRIPT_TAGS + html.slice(at), 'utf8'),
    instrumented: true,
    contentType: INSTRUMENTED_CONTENT_TYPE,
    reason: null,
  };
}

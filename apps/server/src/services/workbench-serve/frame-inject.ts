/** One conservative, bounded HTML/CSP decision for both fixed frame SDKs. */
import { WORKBENCH } from '../../config/constants.js';
import { DOC_FRAME_SHIM_SCRIPT } from '../canvas/doc-frame-shim.js';
import { DEVTOOLS_AGENT_SCRIPT } from './devtools-shim.js';

/** Actual outgoing content type and each enforcing policy; report-only is not enforcing. */
export interface FrameInjectionOptions {
  contentType: string;
  enforcingPolicies: readonly string[];
}

/** Refusal keeps the exact original bytes, including unsupported encodings. */
export interface FrameInjectionResult {
  bytes: Buffer;
  instrumented: boolean;
  reason: string | null;
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
const SCRIPT_TAGS = `<script>${DOC_FRAME_SHIM_SCRIPT}</script><script>${DEVTOOLS_AGENT_SCRIPT}</script>`;

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

function insertionPoint(html: string): number | undefined {
  let i = html.charCodeAt(0) === 0xfeff ? 1 : 0;
  let head: 'before' | 'inside' | 'after' = 'before';
  let htmlSeen = false;
  let htmlClosed = false;
  let bodySeen = false;
  let bodyClosed = false;
  let doctypeSeen = false;
  let charsetSeen = false;
  let insertion: number | undefined;
  while (i < html.length) {
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      if (end < 0 || /--|<!/.test(html.slice(i + 4, end))) return;
      i = end + 3;
      continue;
    }
    if (/^<!doctype html>/i.test(html.slice(i, i + 15))) {
      if (doctypeSeen || head !== 'before' || htmlSeen) return;
      doctypeSeen = true;
      i += 15;
      continue;
    }
    if (html[i] !== '<') {
      if ((head !== 'after' || htmlClosed || bodyClosed) && !SPACE.test(html[i])) return;
      if (html[i] === '\x00') return;
      i++;
      continue;
    }
    const tag = tagAt(html, i);
    if (
      !tag ||
      UNSUPPORTED.has(tag.name) ||
      (tag.selfClosing &&
        ![
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
        ].includes(tag.name))
    )
      return;
    if (htmlClosed || bodyClosed) {
      if (!(tag.closing && tag.name === 'html' && bodyClosed && !htmlClosed)) return;
    }
    if (tag.name === 'html') {
      if (tag.closing) {
        if (!htmlSeen || head !== 'after' || htmlClosed) return;
        htmlClosed = true;
      } else {
        if (htmlSeen || head !== 'before') return;
        htmlSeen = true;
      }
    } else if (tag.name === 'head') {
      if (tag.closing) {
        if (head !== 'inside') return;
        head = 'after';
      } else {
        if (head !== 'before') return;
        head = 'inside';
        insertion = tag.end;
      }
    } else if (tag.name === 'body') {
      if (head !== 'after') return;
      if (tag.closing) {
        if (!bodySeen || bodyClosed) return;
        bodyClosed = true;
      } else {
        if (bodySeen) return;
        bodySeen = true;
      }
    } else if (head === 'before' || (head === 'inside' && !HEAD_TAGS.has(tag.name))) return;
    if (tag.name === 'meta') {
      if (tag.closing) return;
      if (
        [...tag.attributes.values()].some((value) =>
          [...value].some((character) => character === '&' || character.codePointAt(0)! <= 31)
        )
      )
        return;
      const equiv = tag.attributes.get('http-equiv')?.trim().toLowerCase();
      if (equiv && equiv !== 'content-type') return;
      const declared = tag.attributes.get('charset');
      if (declared !== undefined || equiv === 'content-type') {
        if (head !== 'inside' || charsetSeen) return;
        charsetSeen = true;
        if (
          declared !== undefined
            ? !/^(utf-8|utf8)$/i.test(declared)
            : !utf8ContentType(tag.attributes.get('content') ?? '')
        )
          return;
      }
    }
    i = tag.end;
    if (!tag.closing && RAW.has(tag.name)) {
      const closing = new RegExp(`</${tag.name}(?=[\\t\\n\\f\\r />])`, 'ig');
      closing.lastIndex = i;
      const match = closing.exec(html);
      if (!match) return;
      // Script double-escaped states require a full HTML parser, so refuse them.
      if (tag.name === 'script' && /<!--|<script[\t\n\f\r />]/i.test(html.slice(i, match.index)))
        return;
      const end = tagAt(html, match.index);
      if (!end?.closing || end.name !== tag.name) return;
      i = end.end;
    }
  }
  return head === 'after' ? insertion : undefined;
}

/** Insert fixed Doc/DevTools SDKs only when encoding, markup order and every CSP are provable. */
export function injectFrameScripts(
  raw: Buffer,
  options: FrameInjectionOptions
): FrameInjectionResult {
  const refuse = (reason: string): FrameInjectionResult => ({
    bytes: raw,
    instrumented: false,
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
  const at = insertionPoint(html);
  if (at === undefined) return refuse('markup');
  if (
    /<\/script[\t\n\f\r />]/i.test(DOC_FRAME_SHIM_SCRIPT) ||
    /<\/script[\t\n\f\r />]/i.test(DEVTOOLS_AGENT_SCRIPT)
  )
    return refuse('fixed-source');
  return {
    bytes: Buffer.from(html.slice(0, at) + SCRIPT_TAGS + html.slice(at), 'utf8'),
    instrumented: true,
    reason: null,
  };
}

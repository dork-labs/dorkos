/**
 * A small, three-valued evaluator for GitHub Actions `if:` expressions.
 *
 * The census has to answer one question about a condition: can it be true on
 * `pull_request`, and can it be true on `merge_group`? It fixes
 * `github.event_name` to one event and treats every other runtime value (step
 * outputs, labels, `needs.*` results, variables) as unknown. The answer is
 * `true`, `false`, or `unknown`, and `unknown` means "a person has to decide",
 * which the census routes to the allowlist.
 *
 * What it knows beyond `event_name`: on `merge_group` the
 * `github.event.pull_request` object is absent (so `contains(...labels...)` is
 * false there), and on `pull_request` the `github.event.merge_group` object is
 * absent. Status functions are read on the success path: `success()` and
 * `always()` are true, `failure()` and `cancelled()` false.
 *
 * Supported: `==` `!=` `<` `<=` `>` `>=`, `&&` `||` `!`, parentheses, string,
 * number, boolean and null literals, property paths with `.name`, `.*` and
 * `['name']`, and the functions `contains`, `startsWith`, `endsWith`,
 * `fromJSON`, `success`, `always`, `failure`, `cancelled`. Anything else
 * evaluates to unknown rather than guessing.
 */

/** The two events a required check must report on. */
export type GateEvent = 'pull_request' | 'merge_group';

/** A three-valued truth. */
export type Truth = 'true' | 'false' | 'unknown';

const UNKNOWN: unique symbol = Symbol('unknown');
type Value = unknown;

type Token =
  | { t: 'op'; v: string }
  | { t: 'str'; v: string }
  | { t: 'num'; v: number }
  | { t: 'ident'; v: string };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '<=', '>=', '&&', '||'].includes(two)) {
      out.push({ t: 'op', v: two });
      i += 2;
      continue;
    }
    if ('!<>()[],.*'.includes(c)) {
      out.push({ t: 'op', v: c });
      i++;
      continue;
    }
    if (c === "'") {
      let s = '';
      i++;
      for (;;) {
        if (i >= src.length) throw new Error('unterminated string literal');
        if (src[i] === "'") {
          if (src[i + 1] === "'") {
            s += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        s += src[i];
        i++;
      }
      out.push({ t: 'str', v: s });
      continue;
    }
    const num = /^-?(?:0x[0-9a-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i.exec(src.slice(i));
    if (num && !/[A-Za-z_]/.test(src[i - 1] ?? '')) {
      out.push({ t: 'num', v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(src.slice(i));
    if (id) {
      out.push({ t: 'ident', v: id[0] });
      i += id[0].length;
      continue;
    }
    throw new Error(`unexpected character '${c}'`);
  }
  return out;
}

type Node =
  | { k: 'lit'; v: Value }
  | { k: 'not'; e: Node }
  | { k: 'bin'; op: string; l: Node; r: Node }
  | { k: 'call'; name: string; args: Node[] }
  | { k: 'path'; root: string; parts: (string | Node | '*')[] };

class Parser {
  private i = 0;
  private readonly toks: Token[];
  constructor(toks: Token[]) {
    this.toks = toks;
  }

  parse(): Node {
    const n = this.or();
    if (this.i < this.toks.length) throw new Error('trailing tokens');
    return n;
  }
  private peek(v?: string): boolean {
    const t = this.toks[this.i];
    return t !== undefined && t.t === 'op' && (v === undefined || t.v === v);
  }
  private eat(v: string): void {
    if (!this.peek(v)) throw new Error(`expected '${v}'`);
    this.i++;
  }
  private or(): Node {
    let l = this.and();
    while (this.peek('||')) {
      this.i++;
      l = { k: 'bin', op: '||', l, r: this.and() };
    }
    return l;
  }
  private and(): Node {
    let l = this.cmp();
    while (this.peek('&&')) {
      this.i++;
      l = { k: 'bin', op: '&&', l, r: this.cmp() };
    }
    return l;
  }
  private cmp(): Node {
    const l = this.unary();
    for (const op of ['==', '!=', '<=', '>=', '<', '>']) {
      if (this.peek(op)) {
        this.i++;
        return { k: 'bin', op, l, r: this.unary() };
      }
    }
    return l;
  }
  private unary(): Node {
    if (this.peek('!')) {
      this.i++;
      return { k: 'not', e: this.unary() };
    }
    return this.primary();
  }
  private primary(): Node {
    const t = this.toks[this.i];
    if (!t) throw new Error('unexpected end of expression');
    if (t.t === 'op' && t.v === '(') {
      this.i++;
      const e = this.or();
      this.eat(')');
      return e;
    }
    if (t.t === 'str' || t.t === 'num') {
      this.i++;
      return { k: 'lit', v: t.v };
    }
    if (t.t === 'ident') {
      this.i++;
      const lower = t.v.toLowerCase();
      if (lower === 'true' || lower === 'false') return { k: 'lit', v: lower === 'true' };
      if (lower === 'null') return { k: 'lit', v: null };
      if (this.peek('(')) {
        this.i++;
        const args: Node[] = [];
        if (!this.peek(')')) {
          args.push(this.or());
          while (this.peek(',')) {
            this.i++;
            args.push(this.or());
          }
        }
        this.eat(')');
        return { k: 'call', name: lower, args };
      }
      const parts: (string | Node | '*')[] = [];
      for (;;) {
        if (this.peek('.')) {
          this.i++;
          const nx = this.toks[this.i];
          if (nx?.t === 'op' && nx.v === '*') parts.push('*');
          else if (nx?.t === 'ident') parts.push(nx.v);
          else throw new Error('expected a property name after "."');
          this.i++;
        } else if (this.peek('[')) {
          this.i++;
          if (this.peek('*')) {
            this.i++;
            parts.push('*');
          } else parts.push(this.or());
          this.eat(']');
        } else break;
      }
      return { k: 'path', root: t.v, parts };
    }
    throw new Error(`unexpected token '${String(t.v)}'`);
  }
}

function truthy(v: Value): boolean {
  return !(v === false || v === 0 || v === '' || v === null || v === undefined || Number.isNaN(v));
}

function toNumber(v: Value): number {
  if (v === null) return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') return v.trim() === '' ? 0 : Number(v);
  return typeof v === 'number' ? v : Number.NaN;
}

// GitHub's loose equality: strings compare case-insensitively, and operands of
// different types are both coerced to numbers (null and '' are 0).
function looseEq(a: Value, b: Value): boolean {
  if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase();
  if (a === null && b === null) return true;
  if (typeof a === typeof b && a !== null && b !== null) return a === b;
  const na = toNumber(a);
  const nb = toNumber(b);
  return !Number.isNaN(na) && na === nb;
}

function evalNode(n: Node, event: GateEvent): Value {
  switch (n.k) {
    case 'lit':
      return n.v;
    case 'not': {
      const v = evalNode(n.e, event);
      return v === UNKNOWN ? UNKNOWN : !truthy(v);
    }
    case 'bin': {
      if (n.op === '&&' || n.op === '||') {
        const l = evalNode(n.l, event);
        const r = evalNode(n.r, event);
        const decisive = n.op === '&&' ? (v: Value) => !truthy(v) : (v: Value) => truthy(v);
        if (l !== UNKNOWN && decisive(l)) return l;
        if (r !== UNKNOWN && decisive(r)) return r;
        if (l === UNKNOWN || r === UNKNOWN) return UNKNOWN;
        return r;
      }
      const l = evalNode(n.l, event);
      const r = evalNode(n.r, event);
      if (l === UNKNOWN || r === UNKNOWN) return UNKNOWN;
      switch (n.op) {
        case '==':
          return looseEq(l, r);
        case '!=':
          return !looseEq(l, r);
        case '<':
          return Number(l) < Number(r);
        case '<=':
          return Number(l) <= Number(r);
        case '>':
          return Number(l) > Number(r);
        default:
          return Number(l) >= Number(r);
      }
    }
    case 'call':
      return evalCall(n.name, n.args, event);
    case 'path':
      return evalPath(n, event);
  }
}

function evalCall(name: string, args: Node[], event: GateEvent): Value {
  switch (name) {
    case 'success':
    case 'always':
      return true;
    case 'failure':
    case 'cancelled':
      return false;
  }
  const vals = args.map((a) => evalNode(a, event));
  if (name === 'contains' && vals[0] === null) return false;
  if (vals.some((v) => v === UNKNOWN)) return UNKNOWN;
  const [a, b] = vals;
  switch (name) {
    case 'contains':
      if (Array.isArray(a)) return a.some((x) => looseEq(x, b));
      return String(a).toLowerCase().includes(String(b).toLowerCase());
    case 'startswith':
      return String(a).toLowerCase().startsWith(String(b).toLowerCase());
    case 'endswith':
      return String(a).toLowerCase().endsWith(String(b).toLowerCase());
    case 'fromjson':
      try {
        return JSON.parse(String(a)) as Value;
      } catch {
        return UNKNOWN;
      }
    default:
      return UNKNOWN;
  }
}

function evalPath(n: Extract<Node, { k: 'path' }>, event: GateEvent): Value {
  const names = n.parts.map((p) => {
    if (p === '*' || typeof p === 'string') return p;
    const v = evalNode(p, event);
    return typeof v === 'string' ? v : UNKNOWN;
  });
  if (n.root !== 'github') return UNKNOWN;
  const [first, second] = names;
  if (typeof first === 'string' && first === 'event_name' && names.length === 1) return event;
  if (first === 'event' && typeof second === 'string') {
    // The payload object for the OTHER event is absent, and every property
    // read through an absent object is null.
    if (second === 'pull_request' && event === 'merge_group') return null;
    if (second === 'merge_group' && event === 'pull_request') return null;
  }
  return UNKNOWN;
}

/**
 * Strip a `${{ … }}` wrapper when the whole condition is one expression.
 *
 * @param raw - The `if:` value as written in the YAML.
 */
export function unwrapExpression(raw: string): string {
  const s = raw.trim();
  const m = /^\$\{\{([\s\S]*)\}\}$/.exec(s);
  return m && !m[1]!.includes('}}') ? m[1]!.trim() : s;
}

/**
 * Evaluate an `if:` condition for one event.
 *
 * @param raw - The condition as written (with or without `${{ }}`); `true`/`false` booleans are accepted.
 * @param event - Which event to fix `github.event_name` to.
 */
export function evaluateCondition(raw: string | boolean, event: GateEvent): Truth {
  if (typeof raw === 'boolean') return raw ? 'true' : 'false';
  let v: Value;
  try {
    v = evalNode(new Parser(tokenize(unwrapExpression(raw))).parse(), event);
  } catch {
    return 'unknown';
  }
  if (v === UNKNOWN) return 'unknown';
  return truthy(v) ? 'true' : 'false';
}

/**
 * True when the condition lets a job run whatever its `needs` concluded.
 *
 * GitHub adds an implicit `success()` to every job condition that names no
 * status function, which makes the job skip when a job it needs was skipped.
 * `always()`, `failure()` and `cancelled()` (including `!cancelled()`) switch
 * that off; an explicit `success()` does not.
 *
 * @param raw - The condition as written, or undefined when the job has none.
 */
export function ignoresNeedsResult(raw: string | boolean | undefined): boolean {
  return typeof raw === 'string' && /\b(?:always|failure|cancelled)\s*\(/i.test(raw);
}

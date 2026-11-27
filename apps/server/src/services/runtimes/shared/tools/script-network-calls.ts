/**
 * How a script file's text reaches the network, by its language (DOR-5240): a web address to
 * another computer, or a call or import of the language's network libraries. Read per language,
 * so the word "requests" in a JavaScript message, or `node:http` in a Python string, is just text.
 *
 * A web address to this computer (`localhost`, `127.0.0.1`, `::1`) or to a name reserved so it
 * never resolves (`.invalid`, `.test`) is not a fetch from outside. One whose host cannot be read
 * (`https://${host}`) is. In JavaScript, a server's `node:http` or `node:net` is not a fetch; a
 * client call (`fetch(`, `http.get(`, `net.connect(`, or `get(` imported from `node:http` under any
 * name) or `node:https` is. In every language, a string that starts with a network program's name
 * (`["gh", …]`, `"curl " + u`) is code that runs it.
 *
 * @module services/runtimes/shared/tools/script-network-calls
 */

import { QUOTED_NETWORK_PROGRAM } from './shell-network-commands.js';

/** The languages a script file is read in; `any` takes every language's calls. */
export type ScriptLanguage = 'python' | 'js' | 'ruby' | 'perl' | 'php' | 'any';

/** Python's network modules. */
const PYTHON_NETWORK =
  'urllib|urllib3|requests|httpx|aiohttp|http\\.client|socket|ftplib|websockets?|pycurl|paramiko';

/** Each language's common ways to reach the network. */
const NETWORK_CALLS: Readonly<Record<Exclude<ScriptLanguage, 'any'>, RegExp>> = {
  // A network module anywhere on an import line (`import os, requests`), a call on one, or a
  // module whose name is built (`__import__(name)`).
  python: new RegExp(
    [
      `^[ \\t]*(?:import|from)[ \\t][^\\n]*?\\b(?:${PYTHON_NETWORK})\\b`,
      '\\burlopen\\s*\\(',
      '\\b(?:requests|httpx)\\.(?:get|post|put|patch|delete|head|options|request|stream|Session|Client|AsyncClient)\\s*\\(',
      `\\b__import__\\s*\\(\\s*(?:[^'"\\s)]|['"](?:${PYTHON_NETWORK})\\b)`,
    ].join('|'),
    'm'
  ),
  js: /\bfetch\s*\(|\bhttps?\.(?:get|request)\s*\(|\b(?:net|tls)\.(?:connect|createConnection)\s*\(|\bnew\s+WebSocket\s*\(|\bXMLHttpRequest\b|['"]node:(?:https|tls)['"]|(?:from\s+|require\s*\(\s*|import\s*\(\s*)['"](?:https|tls|axios|undici|node-fetch|got|ws)['"]/,
  ruby: /\b(?:Net::HTTP|TCPSocket|URI\.open|Faraday|HTTParty|RestClient)\b|\brequire\s*\(?\s*['"](?:net\/http|open-uri|socket|faraday|httparty|rest-client)['"]/,
  perl: /\b(?:LWP|HTTP::Tiny|IO::Socket|Net::(?:HTTP|FTP|SMTP)|Mojo::UserAgent|WWW::Mechanize)\b/,
  php: /\b(?:curl_init|curl_exec|file_get_contents|fsockopen|stream_socket_client)\s*\(/,
};

/** A web address, and its authority (`user@host:port`). */
const ADDRESS = /\b(?:https?|ftp|wss?):\/\/([^\s'"`<>()/?#]*)/gi;

/** The host an authority names: after its last `@`, without its port. */
function hostOf(authority: string): string {
  const host = authority.slice(authority.lastIndexOf('@') + 1).toLowerCase();
  if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1) || host;
  const port = host.indexOf(':');
  return port === -1 ? host : host.slice(0, port);
}
/** The hosts that are this computer. */
const LOOPBACK: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);
/** Names reserved so they never reach another computer (RFC 2606, RFC 6761). */
const RESERVED_NAME = /\.(?:localhost|invalid|test|example)$/;

/** Whether a text names a web address on another computer, or one whose host cannot be read. */
function namesRemoteAddress(text: string): boolean {
  for (const match of text.matchAll(ADDRESS)) {
    const host = hostOf(match[1] ?? '');
    if (!LOOPBACK.has(host) && !RESERVED_NAME.test(host)) return true;
  }
  return false;
}

/** Node's client modules that a server also uses: `node:http`, `node:net`, `node:dgram`. */
const NODE_SOCKETS = `(?:node:)?(http|net|dgram)`;
/** Each one's calls that reach another computer. */
const SOCKET_CALLS: Readonly<Record<string, readonly string[]>> = {
  http: ['get', 'request'],
  net: ['connect', 'createConnection', 'Socket'],
  dgram: ['send'],
};
/** `import … from 'node:http'`, `const h = require('node:http')`, `await import('node:http')`. */
const SOCKET_IMPORT = new RegExp(
  [
    `\\bimport\\s+([^'";]{0,512}?)\\s+from\\s*['"]${NODE_SOCKETS}['"]`,
    `\\b(?:const|let|var)\\s+([^=;]{0,512}?)\\s*=\\s*(?:await\\s+)?(?:require|import)\\s*\\(\\s*['"]${NODE_SOCKETS}['"]`,
    `\\b(?:require|import)\\s*\\(\\s*['"]${NODE_SOCKETS}['"]`,
  ].join('|'),
  'g'
);
/** How many names a script's imports of them may give before any client call's name marks. */
const MAX_SOCKET_NAMES = 32;
/** A JavaScript name. */
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** One import's names: those that stand for the module, and client calls under their own name. */
function importedNames(clause: string, calls: readonly string[]): [string[], string[]] {
  const modules: string[] = [];
  const own: string[] = [];
  const braces = /\{([^}]*)\}/.exec(clause);
  for (const part of braces?.[1]?.split(',') ?? []) {
    const [name, alias] = part.trim().split(/\s+as\s+|\s*:\s*/);
    const local = (alias ?? name ?? '').trim();
    if (name && calls.includes(name) && IDENTIFIER.test(local)) own.push(local);
  }
  const rest = clause.replace(/\{[^}]*\}/, '').replace(/\*\s*as\s+/, '');
  for (const name of rest.split(',').map((part) => part.trim())) {
    if (IDENTIFIER.test(name)) modules.push(name);
  }
  return [modules, own];
}

/** A name, escaped for a regex. */
function escaped(name: string): string {
  return name.replace(/\$/g, '\\$');
}

/**
 * Whether a JavaScript file calls a client function of `node:http`, `node:net` or `node:dgram`
 * under any name it imported it by: `h.get(u)` after `const h = require('node:http')`, `get(u)`
 * after `import { get } from 'node:http'`. A server that only imports `createServer` calls none.
 */
function socketClientCall(text: string): boolean {
  const modules: string[] = [];
  const own: string[] = [];
  const calls = new Set<string>();
  let unnamed = false;
  for (const match of text.matchAll(SOCKET_IMPORT)) {
    const names = SOCKET_CALLS[(match[2] ?? match[4] ?? match[5])!]!;
    for (const call of names) calls.add(call);
    // `require('node:http').get(u)`: the module is used where it is loaded.
    if (match[5] !== undefined) unnamed = true;
    else {
      const [asModule, asOwn] = importedNames((match[1] ?? match[3])!, names);
      modules.push(...asModule);
      own.push(...asOwn);
    }
    if (modules.length + own.length > MAX_SOCKET_NAMES) unnamed = true;
    if (unnamed) break;
  }
  if (calls.size === 0) return false;
  const methods = [...calls].join('|');
  if (unnamed) return new RegExp(`\\b(?:${methods})\\s*\\(`).test(text);
  const patterns = [
    ...modules.map((name) => `\\b${escaped(name)}\\s*\\.\\s*(?:${methods})\\s*\\(`),
    ...own.map((name) => `(?<![.\\w$])${escaped(name)}\\s*\\(`),
  ];
  return patterns.length > 0 && new RegExp(patterns.join('|')).test(text);
}

/**
 * Whether a script file's text, its comments already left out, reaches the network.
 *
 * @param text - The script.
 * @param language - The language it is read in.
 */
export function scriptFileTextFetches(text: string, language: ScriptLanguage): boolean {
  if (namesRemoteAddress(text)) return true;
  // Code that runs a network program: `subprocess.run(["gh", …])`, `execSync('curl …')`.
  if (QUOTED_NETWORK_PROGRAM.test(text)) return true;
  if ((language === 'js' || language === 'any') && socketClientCall(text)) return true;
  if (language !== 'any') return NETWORK_CALLS[language].test(text);
  return Object.values(NETWORK_CALLS).some((calls) => calls.test(text));
}

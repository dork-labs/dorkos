/**
 * How a script file's text reaches the network, by its language (DOR-5240): a web address to
 * another computer, or a call or import of the language's network libraries. Read per language,
 * so the word "requests" in a JavaScript message, or `node:http` in a Python string, is just text.
 *
 * A web address to this computer (`localhost`, `127.0.0.1`, `::1`) or to a name reserved so it
 * never resolves (`.invalid`, `.test`) is not a fetch from outside. One whose host cannot be read
 * (`https://${host}`) is. In JavaScript, a server's `node:http` or `node:net` is not a fetch; a
 * client call (`fetch(`, `http.get(`, `net.connect(`) or `node:https` is.
 *
 * @module services/runtimes/shared/tools/script-network-calls
 */

/** The languages a script file is read in; `any` takes every language's calls. */
export type ScriptLanguage = 'python' | 'js' | 'ruby' | 'perl' | 'php' | 'any';

/** Each language's common ways to reach the network. */
const NETWORK_CALLS: Readonly<Record<Exclude<ScriptLanguage, 'any'>, RegExp>> = {
  python:
    /^[ \t]*(?:import|from)\s+(?:urllib|urllib3|requests|httpx|aiohttp|http\.client|socket|ftplib|websockets?|pycurl|paramiko)\b|\burlopen\s*\(/m,
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

/**
 * Whether a script file's text, its comments already left out, reaches the network.
 *
 * @param text - The script.
 * @param language - The language it is read in.
 */
export function scriptFileTextFetches(text: string, language: ScriptLanguage): boolean {
  if (namesRemoteAddress(text)) return true;
  if (language !== 'any') return NETWORK_CALLS[language].test(text);
  return Object.values(NETWORK_CALLS).some((calls) => calls.test(text));
}

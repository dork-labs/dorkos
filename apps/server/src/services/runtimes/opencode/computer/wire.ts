/** Structural OpenCode directory translation; tool output and prose remain untouched. */
export class ComputerWire {
  constructor(
    readonly anchor: string,
    readonly guestDirectory: string
  ) {}

  toGuest(value: unknown): string {
    if (value !== this.anchor) throw new Error('COMPUTER_DIRECTORY_REFUSED');
    return this.guestDirectory;
  }

  toHost(value: unknown): string {
    if (value !== this.guestDirectory) throw new Error('COMPUTER_DIRECTORY_REFUSED');
    return this.anchor;
  }

  request(
    request: Request,
    allowedMcpUrls: readonly string[],
    mapMcpUrl?: (url: string) => string | undefined,
    generation?: number
  ): Promise<Request> {
    return this.translateRequest(request, allowedMcpUrls, mapMcpUrl, generation);
  }

  private async translateRequest(
    request: Request,
    allowedMcpUrls: readonly string[],
    mapMcpUrl?: (url: string) => string | undefined,
    generation?: number
  ): Promise<Request> {
    const url = new URL(request.url);
    if (url.searchParams.has('directory')) {
      if (url.searchParams.getAll('directory').length !== 1)
        throw new Error('COMPUTER_DIRECTORY_REFUSED');
      url.searchParams.set('directory', this.toGuest(url.searchParams.get('directory')));
    }
    if (url.pathname.startsWith('/auth')) throw new Error('COMPUTER_AUTH_REFUSED');
    if (url.pathname === '/config' && request.method !== 'GET')
      throw new Error('COMPUTER_CONFIG_REFUSED');
    const headers = new Headers(request.headers);
    if (headers.has('x-opencode-directory')) {
      headers.set('x-opencode-directory', this.toGuest(headers.get('x-opencode-directory')));
    } else headers.set('x-opencode-directory', this.guestDirectory);
    let body: string | undefined;
    if (request.body) {
      if (!headers.get('content-type')?.includes('application/json'))
        throw new Error('COMPUTER_BODY_REFUSED');
      const value: unknown = await request.json();
      if (!isRecord(value)) throw new Error('COMPUTER_BODY_REFUSED');
      if ('directory' in value) value.directory = this.toGuest(value.directory);
      if (isRecord(value.model) && value.model.providerID === 'dorkos-credits')
        throw new Error('COMPUTER_CREDITS_REFUSED');
      if (url.pathname === '/mcp') {
        const config = value.config;
        if (
          !isRecord(config) ||
          config.type !== 'remote' ||
          typeof config.url !== 'string' ||
          (!allowedMcpUrls.includes(config.url) && !mapMcpUrl?.(config.url))
        )
          throw new Error('COMPUTER_MCP_REFUSED');
        const mapped = mapMcpUrl?.(config.url as string);
        if (mapped) {
          config.url = mapped;
          config.headers = {
            ...(isRecord(config.headers) ? config.headers : {}),
            'X-DorkOS-Computer-Generation': String(generation),
          };
        }
      }
      // Host-side config mutation could smuggle model credentials or local MCP commands.
      if (url.pathname === '/config' && request.method !== 'GET')
        throw new Error('COMPUTER_CONFIG_REFUSED');
      if (url.pathname.startsWith('/auth/') && request.method !== 'GET')
        throw new Error('COMPUTER_AUTH_REFUSED');
      body = JSON.stringify(value);
    }
    return new Request(url, {
      method: request.method,
      headers,
      body,
      signal: request.signal,
      redirect: 'error',
    });
  }

  session(value: unknown): unknown {
    if (!isRecord(value) || !('directory' in value)) return value;
    return { ...value, directory: this.toHost(value.directory) };
  }

  history(value: unknown): unknown {
    if (!isRecord(value) || !isRecord(value.info) || !isRecord(value.info.path)) return value;
    const path = { ...value.info.path };
    const hostCwd = 'cwd' in path ? this.toHost(path.cwd) : undefined;
    if ('root' in path) {
      // OpenCode uses '/' as its global project root outside a git checkout.
      // Admit that metadata sentinel only beside the exact owned guest cwd.
      path.root = path.root === '/' && hostCwd ? this.anchor : this.toHost(path.root);
    }
    if (hostCwd) path.cwd = hostCwd;
    return { ...value, info: { ...value.info, path } };
  }

  response(path: string, value: unknown): unknown {
    if (/^\/session(?:\/[^/]+)?$/.test(path)) {
      return Array.isArray(value) ? value.map((row) => this.session(row)) : this.session(value);
    }
    if (/^\/session\/[^/]+\/message(?:\/[^/]+)?$/.test(path)) {
      return Array.isArray(value) ? value.map((row) => this.history(row)) : this.history(value);
    }
    return value;
  }

  event(value: unknown): unknown {
    if (!isRecord(value)) throw new Error('COMPUTER_EVENT_REFUSED');
    const result = { ...value };
    if ('directory' in result && result.directory !== 'global')
      result.directory = this.toHost(result.directory);
    if (
      isRecord(result.payload) &&
      typeof result.payload.type === 'string' &&
      ['session.created', 'session.updated', 'session.deleted'].includes(result.payload.type) &&
      isRecord(result.payload.properties)
    ) {
      result.payload = {
        ...result.payload,
        properties: {
          ...result.payload.properties,
          info: this.session(result.payload.properties.info),
        },
      };
    }
    return result;
  }
}

/** Narrow runtime data record guard. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

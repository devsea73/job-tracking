import { Agent, request, type Dispatcher } from 'undici';
import { assertSafeUrlShape, resolvePublicAddresses, systemResolver, UnsafeUrlError, type Resolver } from './ip-guard';

export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

export interface FetchLimits {
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
}

export const DEFAULT_LIMITS: FetchLimits = {
  timeoutMs: 15_000,
  maxBytes: 8 * 1024 * 1024,
  maxRedirects: 6
};

export type FetchFailure = 'unsafe_url' | 'timeout' | 'network' | 'too_large' | 'not_html';

export class FetchError extends Error {
  constructor(
    public readonly reason: FetchFailure,
    message: string
  ) {
    super(message);
    this.name = 'FetchError';
  }
}

export interface FetchResult {
  status: number;
  /** URL of the last hop after redirects. */
  finalUrl: string;
  /** Every URL visited, in order. */
  chain: string[];
  contentType: string;
  body: string;
}

export interface HttpClient {
  fetch(url: string, options?: FetchOptions): Promise<FetchResult>;
}

export interface FetchOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  accept?: 'html' | 'json';
  limits?: Partial<FetchLimits>;
}

const TEXT_CONTENT = /^(text\/|application\/(json|ld\+json|xhtml\+xml|xml|rss\+xml))/i;

/**
 * Fetches public web pages with SSRF protection. Each connection resolves through a
 * checked lookup, so a DNS answer cannot switch to a private address between the check
 * and the connection. Each redirect hop is validated the same way.
 */
export class SafeHttpClient implements HttpClient {
  private readonly dispatcher: Dispatcher;

  constructor(private readonly resolver: Resolver = systemResolver) {
    this.dispatcher = new Agent({
      connect: {
        timeout: 10_000,
        lookup: (hostname, options, callback) => {
          resolvePublicAddresses(hostname, this.resolver)
            .then((addresses) => {
              const wantAll = typeof options === 'object' && options !== null && 'all' in options && options.all;
              if (wantAll) {
                callback(null, addresses as never, undefined as never);
              } else {
                callback(null, addresses[0].address, addresses[0].family);
              }
            })
            .catch((error: NodeJS.ErrnoException) => callback(error, '', 0));
        }
      },
      headersTimeout: DEFAULT_LIMITS.timeoutMs,
      bodyTimeout: DEFAULT_LIMITS.timeoutMs,
      keepAliveTimeout: 2_000
    });
  }

  async fetch(input: string, options: FetchOptions = {}): Promise<FetchResult> {
    const limits = { ...DEFAULT_LIMITS, ...options.limits };
    const signal = AbortSignal.timeout(limits.timeoutMs);
    const chain: string[] = [];
    let current: URL;
    try {
      current = new URL(input);
    } catch {
      throw new FetchError('unsafe_url', 'That link is not a valid URL.');
    }
    let method = options.method ?? 'GET';
    let body = options.body;

    try {
      for (let hop = 0; hop <= limits.maxRedirects; hop += 1) {
        assertSafeUrlShape(current);
        chain.push(current.toString());
        const response = await request(current, {
          method,
          body,
          signal,
          dispatcher: this.dispatcher,
          headers: {
            'user-agent': BROWSER_USER_AGENT,
            accept:
              options.accept === 'json'
                ? 'application/json, text/plain, */*'
                : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'accept-language': 'en-US,en;q=0.9',
            ...options.headers
          }
        });

        const { statusCode, headers } = response;
        if (statusCode >= 300 && statusCode < 400 && headers.location) {
          await response.body.dump();
          const location = Array.isArray(headers.location) ? headers.location[0] : headers.location;
          current = new URL(location, current);
          if (statusCode === 303 || ((statusCode === 301 || statusCode === 302) && method === 'POST')) {
            method = 'GET';
            body = undefined;
          }
          continue;
        }

        const rawType = headers['content-type'];
        const contentType = (Array.isArray(rawType) ? rawType[0] : rawType) ?? '';
        if (contentType && !TEXT_CONTENT.test(contentType)) {
          await response.body.dump();
          throw new FetchError('not_html', `This link returned ${contentType.split(';')[0]} instead of a web page.`);
        }

        const declared = Number(headers['content-length']);
        if (Number.isFinite(declared) && declared > limits.maxBytes) {
          await response.body.dump();
          throw new FetchError('too_large', 'This page is too large to process.');
        }

        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of response.body) {
          size += (chunk as Buffer).length;
          if (size > limits.maxBytes) {
            response.body.destroy();
            throw new FetchError('too_large', 'This page is too large to process.');
          }
          chunks.push(chunk as Buffer);
        }
        return {
          status: statusCode,
          finalUrl: current.toString(),
          chain,
          contentType,
          body: Buffer.concat(chunks).toString('utf8')
        };
      }
      throw new FetchError('network', 'This link redirected too many times.');
    } catch (error) {
      throw toFetchError(error);
    }
  }

  async close(): Promise<void> {
    await this.dispatcher.close();
  }
}

function toFetchError(error: unknown): FetchError {
  if (error instanceof FetchError) return error;
  if (error instanceof UnsafeUrlError) return new FetchError('unsafe_url', error.message);
  const err = error as { name?: string; code?: string; message?: string; cause?: { code?: string } };
  // undici wraps failures from the lookup in the connect error, keep the SSRF message.
  if (err.name === 'UnsafeUrlError' || err.message?.includes('private network')) {
    return new FetchError('unsafe_url', err.message ?? 'This link cannot be fetched.');
  }
  const code = err.code ?? err.cause?.code ?? '';
  if (
    err.name === 'TimeoutError' ||
    err.name === 'AbortError' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_BODY_TIMEOUT'
  ) {
    return new FetchError('timeout', 'The job site took too long to respond.');
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new FetchError('network', 'The job site could not be found. Check the link and your internet connection.');
  }
  return new FetchError('network', 'The job site could not be reached.');
}

import { lookup as dnsLookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';

/**
 * SSRF protection. Job URLs come from users, and the host sits on a private network,
 * so the server must only ever reach public internet addresses on their behalf.
 */

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

/** ipaddr.js range names that are ordinary public unicast space. */
const PUBLIC_RANGES = new Set(['unicast']);

export function isPublicIp(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  let parsed = ipaddr.parse(address);
  // ::ffff:10.0.0.1 and friends must be judged by the IPv4 address they carry.
  if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
    parsed = (parsed as ipaddr.IPv6).toIPv4Address();
  }
  return PUBLIC_RANGES.has(parsed.range());
}

/** Service ports that have no business serving a job posting. */
const BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109,
  110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 445, 465, 512, 513, 514, 515, 526,
  530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1433, 1521, 2049, 3306, 3389, 5060,
  5061, 5432, 5900, 6000, 6379, 6665, 6666, 6667, 6668, 6669, 6697, 9200, 10080, 11211, 27017
]);

const BLOCKED_HOST_SUFFIXES = [
  '.local',
  '.localhost',
  '.internal',
  '.intranet',
  '.lan',
  '.home',
  '.corp',
  '.home.arpa',
  '.test',
  '.invalid',
  '.example'
];

export type Resolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export const systemResolver: Resolver = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/** Checks everything that can be decided without DNS. */
export function assertSafeUrlShape(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeUrlError('Only http and https links can be fetched.');
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError('Links that contain credentials cannot be fetched.');
  }
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (BLOCKED_PORTS.has(port)) {
    throw new UnsafeUrlError(`Port ${port} is not allowed.`);
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (host === 'localhost' || !host) {
    throw new UnsafeUrlError('Links to this computer cannot be fetched.');
  }
  if (ipaddr.isValid(host)) {
    if (!isPublicIp(host)) throw new UnsafeUrlError('Links to private network addresses cannot be fetched.');
    return;
  }
  if (!host.includes('.') || BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new UnsafeUrlError('Links to private network hosts cannot be fetched.');
  }
}

/** Every address a name resolves to must be public, otherwise one record could reach the LAN. */
export async function resolvePublicAddresses(
  hostname: string,
  resolver: Resolver = systemResolver
): Promise<Array<{ address: string; family: number }>> {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (ipaddr.isValid(host)) {
    if (!isPublicIp(host)) throw new UnsafeUrlError('Links to private network addresses cannot be fetched.');
    return [{ address: host, family: host.includes(':') ? 6 : 4 }];
  }
  const addresses = await resolver(host);
  if (addresses.length === 0) throw new Error(`No DNS records for ${host}`);
  for (const { address } of addresses) {
    if (!isPublicIp(address)) {
      throw new UnsafeUrlError('This link resolves to a private network address and cannot be fetched.');
    }
  }
  return addresses;
}

export async function assertSafeUrl(url: URL, resolver: Resolver = systemResolver): Promise<void> {
  assertSafeUrlShape(url);
  await resolvePublicAddresses(url.hostname, resolver);
}

import { networkInterfaces } from 'node:os';
import ipaddr from 'ipaddr.js';

/**
 * Address ranges that cannot come from the public internet. Carrier-grade NAT space is
 * included because overlay networks such as Tailscale use it for private device links.
 */
const LAN_RANGES = new Set(['loopback', 'private', 'linkLocal', 'uniqueLocal', 'carrierGradeNat']);

export function isLanAddress(address: string | undefined): boolean {
  if (!address || !ipaddr.isValid(address)) return false;
  let parsed = ipaddr.parse(address);
  if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
    parsed = (parsed as ipaddr.IPv6).toIPv4Address();
  }
  return LAN_RANGES.has(parsed.range());
}

/** This computer itself. */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address || !ipaddr.isValid(address)) return false;
  let parsed = ipaddr.parse(address);
  if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
    parsed = (parsed as ipaddr.IPv6).toIPv4Address();
  }
  return parsed.range() === 'loopback';
}

/** The addresses other computers can use to reach this one, most likely first. */
export function lanAddresses(): string[] {
  const found: Array<{ address: string; rank: number }> = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const info of addresses ?? []) {
      if (info.internal || info.family !== 'IPv4') continue;
      const range = ipaddr.parse(info.address).range();
      if (range === 'private') found.push({ address: info.address, rank: 0 });
      else if (range === 'carrierGradeNat') found.push({ address: info.address, rank: 1 });
    }
  }
  return found.sort((a, b) => a.rank - b.rank).map((entry) => entry.address);
}

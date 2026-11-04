import { isIP } from 'net';

function ipv6Prefix(address: string): string {
  const hasGap = address.includes('::');
  const [head = '', tail = ''] = address.split('::');
  const front = head ? head.split(':') : [];
  const back = hasGap && tail ? tail.split(':') : [];
  const fill = hasGap ? Math.max(0, 8 - front.length - back.length) : 0;
  const groups = [...front, ...Array<string>(fill).fill('0'), ...back];
  const prefix = groups.slice(0, 4).map((group) => (parseInt(group, 16) || 0).toString(16));
  return `${prefix.join(':')}::/64`;
}

/**
 * Some proxies (Azure App Service among them) put the client's source port in X-Forwarded-For,
 * e.g. "203.0.113.5:61234" or "[2001:db8::1]:61234". Left in, every new connection would count as
 * a different client and per-IP limits would never trigger.
 */
function stripPort(value: string): string {
  const v4 = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(value);
  if (v4?.[1]) {
    return v4[1];
  }
  const v6 = /^\[([0-9a-f:.%a-z]+)\](?::\d{1,5})?$/i.exec(value);
  return v6?.[1] ?? value;
}

/**
 * The identity a rate limit counts a client under.
 * - A trailing source port is dropped, so one client is one identity across connections.
 * - IPv4-mapped IPv6 (::ffff:1.2.3.4) is treated as the plain IPv4 address.
 * - IPv6 clients are grouped by /64 prefix. One subscriber normally controls a whole /64, so
 *   keying on the full address would let a single client rotate through 2^64 addresses and
 *   never reach a limit.
 */
export function rateLimitIdentity(ip: string | undefined): string {
  if (!ip) {
    return 'unknown';
  }
  const unported = stripPort(ip);
  const address = unported.split('%')[0] ?? unported; // drop an IPv6 zone id such as %eth0
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped?.[1]) {
    return mapped[1];
  }
  return isIP(address) === 6 ? ipv6Prefix(address) : address;
}

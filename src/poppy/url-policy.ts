/**
 * Spec section 3: every protocol URL MUST be HTTPS, and parties MUST NOT connect to loopback,
 * private or link-local addresses for a URL the other party gave them "unless they were
 * configured to on purpose". Local development is exactly that case, so it is an explicit flag.
 *
 * Limitation (documented in docs/limitations.md): hostnames are not DNS-resolved before the
 * check, so a public name that resolves to a private address is not caught here.
 */
export type UrlPolicy = {
  /** Allow http:// and loopback hosts. Only for local development and tests. */
  allowInsecureLoopback: boolean;
};

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function isPrivateIpv4(host: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 169 && b === 254) || a === 0;
}

function isPrivateIpv6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80');
}

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK.has(hostname.toLowerCase()) || hostname.endsWith('.localhost');
}

export class UrlPolicyError extends Error {}

export function assertFetchableUrl(raw: string, policy: UrlPolicy): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UrlPolicyError(`not a URL: ${raw}`);
  }
  if (u.username || u.password) throw new UrlPolicyError('URLs with credentials are not allowed');
  const loop = isLoopbackHost(u.hostname);
  if (u.protocol === 'https:' && !loop && !isPrivateIpv4(u.hostname) && !isPrivateIpv6(u.hostname)) return u;
  if (policy.allowInsecureLoopback && loop && (u.protocol === 'http:' || u.protocol === 'https:')) return u;
  if (u.protocol !== 'https:') throw new UrlPolicyError(`URL must be https: ${raw}`);
  throw new UrlPolicyError(`refusing to connect to a loopback or private address: ${raw}`);
}

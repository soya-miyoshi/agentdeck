import { randomBytes, timingSafeEqual } from "node:crypto";

// The tailnet is the boundary; this token is the belt (plan 001).
//
// The alphabet is not a style choice. On the WebSocket upgrade the token travels in
// `Sec-WebSocket-Protocol`, whose values are RFC 7230 tokens: `/`, `+`, `=` and whitespace are
// all illegal there, so ordinary padded base64 is rejected during the handshake - before any
// code of ours runs, with nothing logged, presenting as "the socket just will not open".
//
// The trap is that `randomBytes(32).toString("base64")` produces a working token most of the
// time. 32 bytes always ends in `=` padding, but a developer testing with a token that happens
// to contain no `/` or `+` in its body sees only the padding problem, strips it, and ships
// something that fails for roughly one user in four. base64url avoids the whole question: its
// alphabet is A-Z a-z 0-9 `-` `_`, every character of which is a valid RFC 7230 token char.
const TOKEN_BYTES = 32;

export const generateToken = (): string => randomBytes(TOKEN_BYTES).toString("base64url");

// Characters RFC 7230 permits in a token. Used to assert what we generate, so a future change of
// encoding fails a test here rather than a handshake on someone's phone.
const RFC7230_TOKEN = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;

export const isWireSafe = (token: string): boolean => RFC7230_TOKEN.test(token);

/**
 * Constant-time comparison. Length is not secret here - the token is fixed-width - but bailing
 * out early on a length mismatch keeps `timingSafeEqual` from throwing, which it does on unequal
 * buffers.
 */
export const tokenMatches = (presented: string, expected: string): boolean => {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};

/**
 * Pull the bearer token out of an Authorization header.
 *
 * Deliberately not accepting it from a query string: a URL lands in proxy logs, browser history
 * and referrer headers, and this token starts processes.
 */
export const bearerFrom = (header: string | undefined): string | undefined => {
  if (header === undefined) return undefined;
  const match = /^Bearer (\S+)$/.exec(header);
  return match?.[1];
};

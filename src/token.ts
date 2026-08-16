import { randomBytes, timingSafeEqual } from "node:crypto";

// The tailnet is the boundary; this token is the belt (plan 001). base64url, because the upgrade
// carries it in `Sec-WebSocket-Protocol` where `/`, `+` and `=` are illegal - base64 usually works.
const TOKEN_BYTES = 32;

export const generateToken = (): string => randomBytes(TOKEN_BYTES).toString("base64url");

// Characters RFC 7230 permits in a token. Used to assert what we generate, so a future change of
// encoding fails a test here rather than a handshake on someone's phone.
const RFC7230_TOKEN = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;

export const isWireSafe = (token: string): boolean => RFC7230_TOKEN.test(token);

/**
 * Constant-time comparison. Length is not secret - the token is fixed-width - and bailing out on a
 * mismatch keeps `timingSafeEqual` from throwing, which it does on unequal buffers.
 */
export const tokenMatches = (presented: string, expected: string): boolean => {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};

/**
 * Pull the bearer token out of an Authorization header. Deliberately never from a query string:
 * a URL lands in proxy logs, browser history and referrer headers, and this token starts processes.
 */
export const bearerFrom = (header: string | undefined): string | undefined => {
  if (header === undefined) return undefined;
  const match = /^Bearer (\S+)$/.exec(header);
  return match?.[1];
};

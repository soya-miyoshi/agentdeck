// The token lives in localStorage. A token that has to be re-entered after every backgrounding is
// a token that gets pasted into a note instead, and the note is not 0600.

const KEY = "agentdeck.token";

/** Storage is behind an interface so this is testable, and because private browsing throws. */
export interface TokenStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

/**
 * Trim and reject the empty string.
 *
 * A pasted token arrives with whatever whitespace came with it - a trailing newline from a
 * terminal, a leading space from a keyboard - and the subprotocol header this ends up in cannot
 * carry either. The failure would be at the socket layer, before any code of ours runs, and would
 * present as "the socket just will not open" with nothing logged.
 */
export const normaliseToken = (raw: string): string | undefined => {
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
};

export const loadToken = (storage: TokenStorage): string | undefined => {
  try {
    const stored = storage.getItem(KEY);
    return stored === null ? undefined : normaliseToken(stored);
  } catch {
    return undefined;
  }
};

export const saveToken = (storage: TokenStorage, token: string): void => {
  try {
    storage.setItem(KEY, token);
  } catch {
    // A browser that refuses to store it still runs this session. Losing the token on reload is
    // worse than losing the session too.
  }
};

export const clearToken = (storage: TokenStorage): void => {
  try {
    storage.removeItem(KEY);
  } catch {
    // Nothing to do about it, and nothing depends on it having worked.
  }
};

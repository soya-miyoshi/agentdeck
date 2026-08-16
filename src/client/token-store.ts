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
 * Trim and reject the empty string: a pasted token carries whatever whitespace came with it, and
 * the subprotocol header cannot. That failure is below our code, with nothing logged.
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

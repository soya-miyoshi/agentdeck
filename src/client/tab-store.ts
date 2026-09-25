import type { TokenStorage } from "./token-store.ts";

// The last tab looked at, kept across reloads so a phone that dropped the page reopens on it.

const KEY = "agentdeck.activeTab";

/** The remembered tab id, or undefined. Storage that throws (private browsing) remembers nothing. */
export const loadTab = (storage: TokenStorage): string | undefined => {
  try {
    const stored = storage.getItem(KEY);
    return stored === null || stored === "" ? undefined : stored;
  } catch {
    return undefined;
  }
};

export const saveTab = (storage: TokenStorage, id: string): void => {
  try {
    storage.setItem(KEY, id);
  } catch {
    // Forgetting the tab on reload is the whole cost.
  }
};

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { loadTab, saveTab } from "./tab-store.ts";
import { selectTab, type Tab } from "./tabs.ts";
import type { TokenStorage } from "./token-store.ts";

const memory = (): TokenStorage => {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
  };
};

const throwing: TokenStorage = {
  getItem: () => {
    throw new Error("storage is disabled");
  },
  setItem: () => {
    throw new Error("storage is disabled");
  },
  removeItem: () => {
    throw new Error("storage is disabled");
  },
};

const tab = (id: string): Tab => ({
  id,
  name: id,
  agent: "shell",
  state: "working",
  status: "working",
  needsYou: false,
  waitingDetectionLost: false,
});

void describe("the remembered tab", () => {
  void test("a saved tab is the one reopened, when it still exists", () => {
    const storage = memory();
    saveTab(storage, "b");
    assert.equal(selectTab([tab("a"), tab("b")], loadTab(storage)), "b");
  });

  void test("a remembered tab that is gone falls back to the first", () => {
    const storage = memory();
    saveTab(storage, "gone");
    assert.equal(selectTab([tab("a"), tab("b")], loadTab(storage)), "a");
  });

  void test("nothing saved remembers nothing", () => {
    assert.equal(loadTab(memory()), undefined);
  });

  void test("storage that throws neither breaks loading nor saving", () => {
    assert.doesNotThrow(() => {
      saveTab(throwing, "a");
    });
    assert.equal(loadTab(throwing), undefined);
  });
});

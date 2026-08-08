<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";

import type { AgentSummary } from "../agent-profiles.ts";
import type { Session } from "../registry.ts";
import { fetchAgents, fetchSessions, UnauthorizedError, verifyToken } from "./api.ts";
import { browserSocket } from "./browser-socket.ts";
import { Connection, type ConnectionStatus } from "./connection.ts";
import { type KeyName, keyBytes, spendable, withCtrl } from "./key-row.ts";
import KeyRow from "./KeyRow.vue";
import TabStrip from "./TabStrip.vue";
import TerminalPane from "./TerminalPane.vue";
import type { TerminalHandle } from "./terminal-handle.ts";
import { selectTab, toTabs } from "./tabs.ts";
import { clearToken, loadToken, saveToken } from "./token-store.ts";
import TokenGate from "./TokenGate.vue";

const token = ref(loadToken(window.localStorage));
const gateMessage = ref<string>();
const sessions = ref<Session[]>([]);
const agents = ref<AgentSummary[]>([]);
const active = ref<string>();
const status = ref<ConnectionStatus>("closed");
const errors = ref<string[]>([]);
const connection = shallowRef<Connection>();

// Terminals are created for a tab the first time it is looked at, and kept afterwards. Eagerly
// attaching every session would make an unlooked-at tab's default 80x24 the minimum the server
// applies to every attached client's pane.
const opened = ref(new Set<string>());
const handles = new Map<string, TerminalHandle>();

const tabs = computed(() => toTabs(sessions.value, agents.value));
const reconnecting = computed(() => status.value === "reconnecting");

const note = (message: string): void => {
  // Newest first, and bounded: an error surface that grows without limit becomes the page.
  errors.value = [message, ...errors.value].slice(0, 3);
};

const signOut = (message: string): void => {
  connection.value?.stop();
  connection.value = undefined;
  handles.clear();
  opened.value = new Set();
  sessions.value = [];
  clearToken(window.localStorage);
  token.value = undefined;
  gateMessage.value = message;
};

/**
 * Reconcile the selection and the mounted terminals with the list the server just sent.
 *
 * A session that has gone takes its terminal with it, because a pane attached to nothing renders
 * a screen that will never change again while looking exactly like one that might.
 */
const settle = (): void => {
  active.value = selectTab(tabs.value, active.value);
  const live = new Set(tabs.value.map((tab) => tab.id));
  const kept = [...opened.value].filter((id) => live.has(id));
  if (active.value !== undefined) kept.push(active.value);
  opened.value = new Set(kept);
};

const refresh = async (current: string): Promise<void> => {
  try {
    const [list, profiles] = await Promise.all([fetchSessions(current), fetchAgents(current)]);
    sessions.value = list;
    agents.value = profiles;
    settle();
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      signOut("That token was rejected. Paste the current one.");
      return;
    }
    note(error instanceof Error ? error.message : "could not load sessions");
  }
};

const start = (current: string): void => {
  const conn = new Connection(
    {
      token: current,
      connect: browserSocket,
      verifyToken: async () => await verifyToken(current),
    },
    {
      render: (sessionId, action) => {
        const handle = handles.get(sessionId);
        if (handle === undefined) return;
        // A snapshot supersedes everything before it: clear, then history, then the live screen.
        // This is what makes reconnect uneventful.
        if (action.kind === "repaint") {
          handle.clear();
          if (action.history !== undefined) handle.write(action.history);
        }
        handle.write(action.data);
      },
      state: (sessionId, state, exitCode) => {
        // Pushed, not polled. Polling would reintroduce the latency this design exists to remove.
        sessions.value = sessions.value.map((session) =>
          session.id === sessionId
            ? { ...session, state, ...(exitCode === undefined ? {} : { exitCode }) }
            : session,
        );
      },
      sessions: (list) => {
        sessions.value = list;
        settle();
      },
      error: (_sessionId, message) => {
        note(message);
      },
      status: (next) => {
        status.value = next;
      },
      unauthorized: () => {
        signOut("That token was rejected. Paste the current one.");
      },
    },
  );
  connection.value = conn;
  conn.start();
  void refresh(current);
};

const accept = (pasted: string): void => {
  saveToken(window.localStorage, pasted);
  token.value = pasted;
  gateMessage.value = undefined;
  errors.value = [];
  start(pasted);
};

const select = (id: string): void => {
  active.value = id;
  opened.value = new Set([...opened.value, id]);
  handles.get(id)?.focus();
};

// Ctrl latches rather than being held: there is one thumb, and the second press is a separate
// event. The latch is spent by the next single character sent from this tab, whether that comes
// from a cap on the row or from a character typed on the soft keyboard - which is what makes
// Ctrl+C reachable by pressing Ctrl and then `c`.
const ctrlLatched = ref(false);

// The latch belongs to the tab it was armed on. It is one app-wide ref while `send` reads
// `active.value` at SPEND time, and the active tab can move on its own - the session list settling
// after a sync, or a tab exiting - so an armed Ctrl could be spent on a session the user was not
// looking at when they armed it. Ctrl+C to the wrong agent is the confidently-wrong output this
// design refuses, and the person would have no way to know it happened. Disarming on any change of
// tab costs one extra tap in the case where they meant it.
watch(active, () => {
  ctrlLatched.value = false;
});

const send = (data: string): void => {
  const id = active.value;
  if (id === undefined || data === "") return;
  const spend = ctrlLatched.value && spendable(data);
  const bytes = spend ? withCtrl(data) : data;
  if (spend) ctrlLatched.value = false;
  // Straight through `Connection.input`, which chunks and paces: the key row is not a side channel.
  connection.value?.input(id, bytes);
};

const pressKey = (key: KeyName): void => {
  if (key === "ctrl") {
    ctrlLatched.value = !ctrlLatched.value;
    return;
  }
  const id = active.value;
  if (id === undefined) return;
  send(keyBytes(key, handles.get(id)?.applicationCursorKeys() ?? false));
};

const typed = (sessionId: string, data: string): void => {
  if (sessionId !== active.value) {
    connection.value?.input(sessionId, data);
    return;
  }
  send(data);
};

const ready = (sessionId: string, handle: TerminalHandle): void => {
  handles.set(sessionId, handle);
  const size = handle.size();
  connection.value?.attach(sessionId, size.cols, size.rows);
};

const gone = (sessionId: string): void => {
  handles.delete(sessionId);
  connection.value?.detach(sessionId);
};

const wake = (): void => {
  if (document.visibilityState === "visible") connection.value?.poke();
};
document.addEventListener("visibilitychange", wake);
window.addEventListener("online", wake);
onBeforeUnmount(() => {
  document.removeEventListener("visibilitychange", wake);
  window.removeEventListener("online", wake);
  connection.value?.stop();
});

if (token.value !== undefined) start(token.value);
</script>

<template>
  <TokenGate v-if="token === undefined" :message="gateMessage" @token="accept" />
  <div v-else class="app">
    <TabStrip :tabs="tabs" :active="active" @select="select" />
    <!-- Only after the FIRST retry fails, so a normal half-second reconnect does not flash UI. -->
    <p v-if="reconnecting" class="banner">Reconnecting…</p>
    <p v-for="message in errors" :key="message" class="banner error">{{ message }}</p>
    <main class="panes">
      <TerminalPane
        v-for="id in [...opened]"
        :key="id"
        :session-id="id"
        :visible="id === active"
        @ready="ready"
        @gone="gone"
        @input="typed"
        @resize="(sessionId, cols, rows) => connection?.resize(sessionId, cols, rows)"
      />
    </main>
    <!-- The keys a soft keyboard does not have, which are exactly the ones a permission prompt
         needs. Without it the deck is a window onto a process waiting for an answer. -->
    <KeyRow :ctrl-latched="ctrlLatched" @key="pressKey" />
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.panes {
  position: relative;
  flex: 1;
  min-height: 0;
  /* The key row is the bottom edge of the app now, and it carries the bottom inset - the last rows
     of the terminal, which is where a permission prompt and the cursor are, sit above the row and
     the row sits above the home indicator. Insetting here as well would leave a band of the pane's
     background between the two. */
  padding: 0 var(--safe-right) 0 var(--safe-left);
  box-sizing: border-box;
}
.banner {
  margin: 0;
  padding: 0.4rem 0.75rem;
  background: #232833;
  color: #d7dae0;
  font-size: 0.85rem;
}
.banner.error {
  background: #3a2226;
}
</style>

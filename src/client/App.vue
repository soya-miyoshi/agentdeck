<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";

import type { AgentSummary } from "../agent-profiles.ts";
import type { Cwd } from "../cwds.ts";
import { PANE_COLS } from "../protocol.ts";
import type { Session } from "../registry.ts";
import {
  closeSession,
  createSession,
  fetchAgents,
  fetchCwds,
  fetchSessions,
  UnauthorizedError,
  uploadImage,
  verifyToken,
} from "./api.ts";
import { browserSocket } from "./browser-socket.ts";
import Composer from "./Composer.vue";
import { spendsCtrl, submitBytes, type SubmitMode } from "./composer.ts";
import { Connection, type ConnectionStatus } from "./connection.ts";
import { downscale } from "./image.ts";
import { type KeyName, keyBytes, spendable, withCtrl } from "./key-row.ts";
import KeyRow from "./KeyRow.vue";
import NewSession from "./NewSession.vue";
import ProcessList from "./ProcessList.vue";
import TabStrip from "./TabStrip.vue";
import TerminalPane from "./TerminalPane.vue";
import type { TerminalHandle } from "./terminal-handle.ts";
import { selectTab, toTabs } from "./tabs.ts";
import { clearToken, loadToken, saveToken } from "./token-store.ts";
import TokenGate from "./TokenGate.vue";
import UploadImage from "./UploadImage.vue";
import { followVisualViewport } from "./viewport.ts";

const token = ref(loadToken(window.localStorage));
const gateMessage = ref<string>();
const sessions = ref<Session[]>([]);
const agents = ref<AgentSummary[]>([]);
const cwds = ref<Cwd[]>([]);
const starting = ref(false);
const active = ref<string>();
const status = ref<ConnectionStatus>("closed");
const errors = ref<string[]>([]);
const connection = shallowRef<Connection>();

// The width every pane renders at. This bundle's own constant only until a socket says otherwise:
// the pane is wrapped by the server's PTY, and the two halves are built and restarted separately,
// so the compiled number is a guess that goes stale between `pnpm build` and `make restart`.
const paneCols = ref(PANE_COLS);

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
  cwds.value = [];
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

/** The allowlist, reread each time the picker opens: PATH and the session set both move. */
const loadCwds = async (): Promise<void> => {
  const current = token.value;
  if (current === undefined) return;
  try {
    const [list, profiles] = await Promise.all([fetchCwds(current), fetchAgents(current)]);
    cwds.value = list;
    agents.value = profiles;
  } catch (error) {
    note(error instanceof Error ? error.message : "could not load directories");
  }
};

/**
 * Create the session the picker chose. The 201's `warning` and a refusal are both shown in the
 * server's own words; swallowing either is what makes a second agent in one tree invisible.
 */
const startSession = async (cwd: string, agent: string): Promise<void> => {
  const current = token.value;
  if (current === undefined) return;
  starting.value = true;
  try {
    const { session, warning } = await createSession(current, cwd, agent);
    sessions.value = [...sessions.value.filter((s) => s.id !== session.id), session];
    if (warning !== undefined) note(warning);
    select(session.id);
    settle();
    void loadCwds();
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      signOut("That token was rejected. Paste the current one.");
      return;
    }
    note(error instanceof Error ? error.message : "could not start a session");
  } finally {
    starting.value = false;
  }
};

/**
 * Kill a session and its agent. Removed from the list here rather than waiting for the next sync,
 * so the tab does not linger as something that can still be typed into after it is gone.
 */
const endSession = async (id: string): Promise<void> => {
  const current = token.value;
  if (current === undefined) return;
  try {
    await closeSession(current, id);
    sessions.value = sessions.value.filter((session) => session.id !== id);
    settle();
    void loadCwds();
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      signOut("That token was rejected. Paste the current one.");
      return;
    }
    note(error instanceof Error ? error.message : "could not close that session");
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
      paneCols: (cols) => {
        paneCols.value = cols;
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
  void loadCwds();
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
};

// Ctrl latches rather than being held: there is one thumb, and the second press is a separate
// event. The latch is spent by the next single character from a cap on the row, or by a submit
// from the composer, which applies it to the first character in the box - which is what makes
// Ctrl+C reachable by pressing Ctrl, typing `c` and pressing Send.
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

// What still reaches this is the terminal's own answers to escape sequences the AGENT wrote, not
// keystrokes: the pane's textarea is read-only. `spendable` is what keeps those replies from
// spending a Ctrl latch, and it is the reason this does not go straight to `connection.input`.
const typed = (sessionId: string, data: string): void => {
  if (sessionId !== active.value) {
    connection.value?.input(sessionId, data);
    return;
  }
  send(data);
};

const composer = ref<InstanceType<typeof Composer>>();

/**
 * What the composer submitted, as bytes, with any armed Ctrl applied to the first character.
 *
 * Not through `send`: that spends the latch on a SINGLE character, which is the rule guarding
 * against the terminal's replies eating it, and a submit is a whole line.
 */
const submitted = (text: string, mode: SubmitMode): void => {
  const id = active.value;
  if (id === undefined) return;
  const bytes = submitBytes(text, mode, ctrlLatched.value);
  if (spendsCtrl(text)) ctrlLatched.value = false;
  connection.value?.input(id, bytes);
};

// "Copied", briefly, on the button itself. An error banner for a success is the wrong surface, and
// a clipboard write that silently did nothing is indistinguishable from one that worked.
const copyLabel = ref("Copy");
let copyTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Put the pane's text on the clipboard - the selection if there is one, the visible screen if not.
 *
 * The phone cannot select inside the terminal at all: the pane claims every touch gesture so that
 * dragging scrolls it, and that is the gesture iOS would have used to select. So this button is
 * the only way anything on that screen leaves the phone.
 */
const copyScreen = async (): Promise<void> => {
  const id = active.value;
  const text = id === undefined ? undefined : handles.get(id)?.copyText();
  if (text === undefined || text === "") return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Refused rather than failed: a browser only allows this from a user gesture and a secure
    // origin, and saying "copied" when it did not is the confidently-wrong result this app refuses.
    note("the browser refused the clipboard - copy needs an https address, which the tailnet gives");
    return;
  }
  copyLabel.value = "Copied";
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => {
    copyLabel.value = "Copy";
  }, 1500);
};

// Open state lives here rather than in ProcessList, because the control that opens it sits in the
// New session bar and the list it opens hangs below that bar. Unmounted while closed, which is what
// keeps the `ps` of the whole machine to the moments someone is asking for it.
const processesOpen = ref(false);

const uploading = ref(false);

/**
 * Put an image where the agent can read it, then put its path in the composer.
 *
 * In the box and NOT on the wire, deliberately: an image with no question attached is a turn spent
 * on "what am I looking at". The person writes the sentence beside the path and presses Send.
 */
const sendImage = async (file: File): Promise<void> => {
  const id = active.value;
  const current = token.value;
  if (id === undefined || current === undefined) return;
  uploading.value = true;
  try {
    const path = await uploadImage(current, id, await downscale(file));
    composer.value?.insert(`${path} `);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      signOut("That token was rejected. Paste the current one.");
      return;
    }
    note(error instanceof Error ? error.message : "could not send that image");
  } finally {
    uploading.value = false;
  }
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

// Pinned to the visual viewport, so "the window" means the part of it the soft keyboard is not
// covering. The pane's ResizeObserver refits the terminal from there.
const shell = ref<HTMLDivElement>();
let unfollow: (() => void) | undefined;
watch(shell, (element) => {
  unfollow?.();
  unfollow = element === undefined ? undefined : followVisualViewport(element, window);
});

const wake = (): void => {
  if (document.visibilityState === "visible") connection.value?.poke();
};
document.addEventListener("visibilitychange", wake);
window.addEventListener("online", wake);
onBeforeUnmount(() => {
  clearTimeout(copyTimer);
  document.removeEventListener("visibilitychange", wake);
  window.removeEventListener("online", wake);
  unfollow?.();
  connection.value?.stop();
});

if (token.value !== undefined) start(token.value);
</script>

<template>
  <TokenGate v-if="token === undefined" :message="gateMessage" @token="accept" />
  <div v-else ref="shell" class="app">
    <TabStrip :tabs="tabs" :active="active" @select="select" @close="(id) => void endSession(id)" />
    <!-- Without this the deck can drive sessions but never start one. Image rides in the same bar
         because it is the other thing done TO a session, not a mode of the terminal below. -->
    <NewSession
      :cwds="cwds"
      :agents="agents"
      :busy="starting"
      @open="loadCwds"
      @start="(cwd, agent) => void startSession(cwd, agent)"
    >
      <template #beside>
        <!-- What each session has left running. In the bar because it is a question about the
             machine the sessions run on, at the same level as starting one. -->
        <button
          class="beside"
          type="button"
          :aria-expanded="processesOpen"
          @click="processesOpen = !processesOpen"
        >
          Processes
        </button>
        <!-- The only way text on that screen leaves the phone: the pane owns every touch gesture,
             so there is nothing to long-press and select. -->
        <button
          v-if="active !== undefined"
          class="beside"
          type="button"
          @click="() => void copyScreen()"
        >
          {{ copyLabel }}
        </button>
        <!-- Only with a session to send it to: an upload needs a session directory to land in. -->
        <UploadImage
          v-if="active !== undefined"
          :busy="uploading"
          @pick="(file) => void sendImage(file)"
        />
      </template>
    </NewSession>
    <ProcessList v-if="processesOpen" :token="token" />
    <!-- Only after the FIRST retry fails, so a normal half-second reconnect does not flash UI. -->
    <p v-if="reconnecting" class="banner">Reconnecting…</p>
    <p v-for="message in errors" :key="message" class="banner error">{{ message }}</p>
    <main class="panes">
      <TerminalPane
        v-for="id in [...opened]"
        :key="id"
        :session-id="id"
        :visible="id === active"
        :cols="paneCols"
        @ready="ready"
        @gone="gone"
        @input="typed"
        @resize="(sessionId, cols, rows) => connection?.resize(sessionId, cols, rows)"
      />
    </main>
    <!-- The input path. The pane above takes no keystrokes: a character typed into it costs a
         round trip before it appears, and an IME's half-composed text goes to the agent as it is
         being composed. Here it is edited locally, pasted with the OS's own paste, and sent once. -->
    <Composer
      ref="composer"
      :ctrl-latched="ctrlLatched"
      :disabled="active === undefined"
      @submit="submitted"
    />
    <!-- The keys a soft keyboard does not have, which are exactly the ones a permission prompt
         needs. Without it the deck is a window onto a process waiting for an answer. -->
    <KeyRow :ctrl-latched="ctrlLatched" @key="pressKey" />
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  /* Fixed, and the height/translate are written by followVisualViewport. `100%` is only the
     fallback for a browser with no visualViewport; on iOS it is the height that hides the key row
     behind the keyboard. */
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
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
/* Flush with the New session bar rather than a chip floating on it, same as UploadImage's button. */
.beside {
  flex: 0 0 auto;
  min-height: var(--touch-target);
  padding: 0 0.9rem;
  border: 0;
  border-left: 1px solid #2a2e35;
  background: #1b1e24;
  color: #d7dae0;
  font: inherit;
  font-size: 0.85rem;
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

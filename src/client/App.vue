<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";

import { PANE_COLS, type AgentSummary, type Cwd, type Session } from "./wire.ts";
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
import { loginUrl } from "./login.ts";
import LoginPanel from "./LoginPanel.vue";
import NewSession from "./NewSession.vue";
import ProcessList from "./ProcessList.vue";
import { historyBytes } from "./repaint.ts";
import SelectText from "./SelectText.vue";
import SessionBar from "./SessionBar.vue";
import TabStrip from "./TabStrip.vue";
import TerminalPane from "./TerminalPane.vue";
import type { TerminalHandle } from "./terminal-handle.ts";
import { loadTab, saveTab } from "./tab-store.ts";
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
const errors = ref<{ sessionId?: string; message: string }[]>([]);
const connection = shallowRef<Connection>();

// The width every pane renders at: this bundle's constant only until a socket says otherwise. The
// two halves are built and restarted separately, so the compiled number goes stale.
const paneCols = ref(PANE_COLS);

// Terminals are created the first time a tab is looked at, and kept. Attaching eagerly would make an
// unlooked-at tab's default 80x24 the minimum applied to every pane.
const opened = ref(new Set<string>());
const handles = new Map<string, TerminalHandle>();

const tabs = computed(() => toTabs(sessions.value, agents.value));
const reconnecting = computed(() => status.value === "reconnecting");

const note = (message: string, sessionId?: string): void => {
  // Newest first, and bounded: an error surface that grows without limit becomes the page.
  const entry = sessionId === undefined ? { message } : { sessionId, message };
  errors.value = [entry, ...errors.value].slice(0, 3);
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
 * Reconcile the selection and the mounted terminals with the list the server just sent. A gone
 * session takes its terminal: a pane attached to nothing looks exactly like one that might change.
 */
const settle = (): void => {
  // With nothing selected yet, the tab remembered from the last page load is the one to prefer.
  active.value = selectTab(tabs.value, active.value ?? loadTab(window.localStorage));
  const live = new Set(tabs.value.map((tab) => tab.id));
  const kept = [...opened.value].filter((id) => live.has(id));
  if (active.value !== undefined) kept.push(active.value);
  opened.value = new Set(kept);
  // An error about a session that no longer exists has nothing left to act on, so it goes with it.
  errors.value = errors.value.filter((e) => e.sessionId === undefined || live.has(e.sessionId));
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
 * server's own words - swallowing either makes a second agent in one tree invisible.
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
          // Modes first: they decide which buffer the screen below lands in.
          if (action.modes !== undefined) handle.write(action.modes);
          if (action.history !== undefined) {
            handle.write(historyBytes(action.history, handle.size().rows));
          }
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
      error: (sessionId, message) => {
        // A closed tab's pane detaches after the server already dropped it, and earns `no session`.
        if (sessionId !== undefined && !sessions.value.some((s) => s.id === sessionId)) return;
        note(message, sessionId);
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

/** A session picked from the list: shown, and the list gets out of the way. */
const pick = (id: string): void => {
  select(id);
  panel.value = undefined;
};

/**
 * Whether the soft keyboard is up: something editable has focus and the visible height is short.
 * The top row hides then, so the composer and the key row keep their room on a small phone.
 */
const editing = ref(false);
const shortView = ref(false);
const typing = computed(() => editing.value && shortView.value);
const noteFocus = (): void => {
  const el = document.activeElement;
  editing.value = el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement;
};
const noteHeight = (): void => {
  shortView.value = (window.visualViewport?.height ?? window.innerHeight) < 520;
};
document.addEventListener("focusin", noteFocus);
document.addEventListener("focusout", () => {
  // Focus moves to the next element after `focusout`, so read it once that has happened.
  setTimeout(noteFocus, 0);
});
window.visualViewport?.addEventListener("resize", noteHeight);
window.addEventListener("resize", noteHeight);
noteHeight();

const select = (id: string): void => {
  active.value = id;
  opened.value = new Set([...opened.value, id]);
};

// Ctrl latches rather than being held: one thumb, so the second press is a separate event. Spent by
// the next single character, or by a submit - which is what makes Ctrl, `c`, Send an interrupt.
const ctrlLatched = ref(false);

// The latch belongs to the tab it was armed on: the active tab can move on its own, and Ctrl+C to
// the wrong agent is unnoticeable. Disarming on any tab change costs one tap when it was meant.
watch(active, () => {
  ctrlLatched.value = false;
});

// Remember the selection for the next page load. An empty strip keeps the last one: nothing replaced it.
watch(active, (id) => {
  if (id !== undefined) saveTab(window.localStorage, id);
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

// What reaches this is the terminal's own replies rather than keystrokes - the textarea is
// read-only - and `spendable` is what stops those replies spending a Ctrl latch.
const typed = (sessionId: string, data: string): void => {
  if (sessionId !== active.value) {
    connection.value?.input(sessionId, data);
    return;
  }
  send(data);
};

const composer = ref<InstanceType<typeof Composer>>();

/**
 * What the composer submitted, as bytes, with any armed Ctrl applied to the first character. Not
 * through `send`, which spends a latch only on a single character - a submit is a whole line.
 */
const submitted = (text: string, mode: SubmitMode): void => {
  const id = active.value;
  if (id === undefined) return;
  const bytes = submitBytes(text, mode, ctrlLatched.value);
  if (spendsCtrl(text)) ctrlLatched.value = false;
  connection.value?.input(id, bytes);
};

// How much history the select view carries: enough to find what scrolled away, small enough to be
// a page a thumb can still get through.
const SELECT_LINES = 400;

/**
 * The one panel below the bar, if any. One value rather than a flag each: three could be open at
 * once, which squeezed the terminal to nothing and pushed the tabs and keys off the screen.
 * Processes is unmounted while closed, so the `ps` of the whole machine runs only when asked.
 */
type Panel = "sessions" | "new" | "more" | "processes" | "login" | "select";
const panel = ref<Panel>();
const toggle = (which: Panel): void => {
  panel.value = panel.value === which ? undefined : which;
};
// The sign-in helper and the select view belong to one session's pane.
watch(active, () => {
  if (panel.value === "login" || panel.value === "select") panel.value = undefined;
});

/**
 * The pane's text as plain text over the pane, where iOS's own selection works. The terminal claims
 * every touch for scrolling, so there is nothing to long-press on in the terminal itself.
 */
const selectText = ref("");
const openSelect = (): void => {
  const id = active.value;
  const text = id === undefined ? undefined : handles.get(id)?.text(SELECT_LINES);
  if (text === undefined) return;
  selectText.value = text;
  toggle("select");
};

const closePanel = (event: KeyboardEvent): void => {
  if (event.key === "Escape" && panel.value !== undefined) panel.value = undefined;
};
window.addEventListener("keydown", closePanel);

const findLoginUrl = (): string | undefined => {
  const id = active.value;
  const screen = id === undefined ? undefined : handles.get(id)?.rows();
  return screen === undefined ? undefined : loginUrl(screen.rows, screen.cols);
};

const uploading = ref(false);
const uploadProgress = ref<string>();

/**
 * Put images where the agent can read them, then put their paths in the composer - in the box and
 * NOT on the wire, because an image with no question is a turn spent on "what am I looking at".
 * One at a time, so a failure names its image and the rest still land.
 */
const sendImages = async (files: File[]): Promise<void> => {
  const id = active.value;
  const current = token.value;
  if (id === undefined || current === undefined) return;
  uploading.value = true;
  const failed: string[] = [];
  try {
    for (const [index, file] of files.entries()) {
      uploadProgress.value =
        files.length > 1 ? `${String(index + 1)}/${String(files.length)}` : undefined;
      try {
        const path = await uploadImage(current, id, await downscale(file));
        composer.value?.insert(`${path} `);
      } catch (error) {
        if (error instanceof UnauthorizedError) {
          signOut("That token was rejected. Paste the current one.");
          return;
        }
        failed.push(
          `${file.name}: ${error instanceof Error ? error.message : "could not send it"}`,
        );
      }
    }
    if (failed.length > 0) note(failed.join("; "));
  } finally {
    uploading.value = false;
    uploadProgress.value = undefined;
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
  window.removeEventListener("keydown", closePanel);
  document.removeEventListener("focusin", noteFocus);
  window.visualViewport?.removeEventListener("resize", noteHeight);
  window.removeEventListener("resize", noteHeight);
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
    <!-- One row: which session this is, Select, and More. A strip of tabs ran off the side of a
         phone at three sessions, and the action bar beside it scrolled sideways on a small one. -->
    <SessionBar
      v-show="!typing"
      :tabs="tabs"
      :active="active"
      :panel="panel"
      @sessions="toggle('sessions')"
      @select="openSelect"
      @more="toggle('more')"
    />
    <TabStrip
      v-if="panel === 'sessions'"
      :tabs="tabs"
      :active="active"
      @select="pick"
      @close="(id) => void endSession(id)"
      @new="panel = 'new'"
    />
    <NewSession
      :cwds="cwds"
      :agents="agents"
      :busy="starting"
      :open="panel === 'new'"
      @open="loadCwds"
      @close="panel = undefined"
      @start="(cwd, agent) => void startSession(cwd, agent)"
    />
    <!-- The rarer things done to a session or the machine, a tap further away than the common ones. -->
    <nav v-if="panel === 'more'" class="more">
      <button class="row" type="button" @click="panel = 'processes'">Processes</button>
      <button v-if="active !== undefined" class="row" type="button" @click="panel = 'login'">
        Login
      </button>
      <!-- Only with a session to send it to: an upload needs a session directory to land in. -->
      <UploadImage
        v-if="active !== undefined"
        :busy="uploading"
        :progress="uploadProgress"
        @pick="(files) => void sendImages(files)"
      />
      <button class="row" type="button" @click="panel = undefined">Close</button>
    </nav>
    <ProcessList v-if="panel === 'processes'" :token="token" @close="panel = undefined" />
    <LoginPanel
      v-if="panel === 'login' && active !== undefined"
      :find="findLoginUrl"
      @send="(bytes) => active !== undefined && connection?.input(active, bytes)"
      @close="panel = undefined"
    />
    <!-- Only after the FIRST retry fails, so a normal half-second reconnect does not flash UI. -->
    <p v-if="reconnecting" class="banner">Reconnecting…</p>
    <p v-for="error in errors" :key="error.message" class="banner error">{{ error.message }}</p>
    <main class="panes">
      <TerminalPane
        v-for="id in [...opened]"
        :key="id"
        :session-id="id"
        :visible="id === active"
        :cols="paneCols"
        :fit-rows="!typing"
        @ready="ready"
        @gone="gone"
        @input="typed"
        @resize="(sessionId, cols, rows) => connection?.resize(sessionId, cols, rows)"
      />
      <SelectText
        v-if="panel === 'select'"
        :text="selectText"
        @close="panel = undefined"
        @refused="
          note(
            'the browser refused the clipboard - copy needs an https address, which the tailnet gives',
          )
        "
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
/* The rows a thumb needs - the bar, the composer and the keys - keep their height; a panel is what
   gives way on a short screen, scrolling inside itself, then the terminal down to its floor. */
.app > * {
  flex-shrink: 0;
}
.app > .strip,
.app > .picker,
.app > .processes,
.app > .login,
.app > .more {
  flex-shrink: 1;
  min-height: 0;
  overflow-y: auto;
}
.panes {
  position: relative;
  flex: 1 1 0;
  /* The terminal keeps a few readable rows whatever is open above it: the panels scroll inside
     themselves, so they are what gives way, not the thing they are about. */
  min-height: 8rem;
  /* The key row is the bottom edge of the app now, and it carries the bottom inset - the last rows
     of the terminal, which is where a permission prompt and the cursor are, sit above the row and
     the row sits above the home indicator. Insetting here as well would leave a band of the pane's
     background between the two. */
  padding: 0 var(--safe-right) 0 var(--safe-left);
  box-sizing: border-box;
}
.more {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  padding: 0.5rem calc(0.5rem + var(--safe-right)) 0.5rem calc(0.5rem + var(--safe-left));
  background: #14161a;
  border-bottom: 1px solid #2a2e35;
}
.more .row,
.more :deep(.upload) {
  min-height: var(--touch-target);
  padding: 0 0.75rem;
  border: 1px solid #2a2e35;
  border-radius: 6px;
  background: #1b1e24;
  color: #d7dae0;
  font: inherit;
  text-align: left;
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

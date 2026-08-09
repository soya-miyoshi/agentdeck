<script setup lang="ts">
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

import type { TerminalHandle } from "./terminal-handle.ts";

const props = defineProps<{ sessionId: string; visible: boolean }>();
const emit = defineEmits<{
  ready: [sessionId: string, handle: TerminalHandle];
  gone: [sessionId: string];
  input: [sessionId: string, data: string];
  resize: [sessionId: string, cols: number, rows: number];
}>();

const host = ref<HTMLDivElement>();
let terminal: Terminal | undefined;
let fit: FitAddon | undefined;
let observer: ResizeObserver | undefined;

// One finger's position and the fraction of a row it has not yet paid for. xterm has no touch
// scrolling of its own - `.xterm-screen` sits over `.xterm-viewport`, so a drag on the text reaches
// an element that does not scroll - and on iOS the page rubber-bands instead.
let touchY: number | undefined;
let carry = 0;

const rowHeight = (): number => {
  const term = terminal;
  if (term === undefined || host.value === undefined || term.rows === 0) return 0;
  return host.value.clientHeight / term.rows;
};

const onTouchStart = (event: TouchEvent): void => {
  const point = event.touches[0];
  // Never preventDefault here: that is what makes a tap dead, keyboard and all.
  touchY = event.touches.length === 1 && point !== undefined ? point.clientY : undefined;
  carry = 0;
};

const onTouchMove = (event: TouchEvent): void => {
  const term = terminal;
  const point = event.touches[0];
  if (term === undefined || touchY === undefined || point === undefined) return;
  const height = rowHeight();
  if (height <= 0) return;
  const moved = point.clientY - touchY;
  touchY = point.clientY;
  carry += moved / height;
  const lines = Math.trunc(carry);
  carry -= lines;
  // Dragging down shows earlier output, which is a negative line delta.
  if (lines !== 0) term.scrollLines(-lines);
  event.preventDefault();
};

const onTouchEnd = (): void => {
  touchY = undefined;
  carry = 0;
};

const refit = (): void => {
  // A hidden pane has no size, and fitting it would report 0x0 as this client's constraint - which
  // the server takes as the minimum over attached clients and applies to everybody's pane.
  if (!props.visible || terminal === undefined || fit === undefined) return;
  fit.fit();
  emit("resize", props.sessionId, terminal.cols, terminal.rows);
};

onMounted(() => {
  const term = new Terminal({
    convertEol: false,
    cursorBlink: true,
    fontSize: 13,
    // An agent writes far more than a screen at a time, and scrollback is the only copy of it.
    scrollback: 5000,
    theme: { background: "#0f1115" },
  });
  const addon = new FitAddon();
  term.loadAddon(addon);
  if (host.value !== undefined) term.open(host.value);
  // Never rendered locally. Input comes back as ordinary output because that is what a PTY does,
  // and the agent may be in a mode that transforms or refuses it.
  term.onData((data) => {
    emit("input", props.sessionId, data);
  });
  terminal = term;
  fit = addon;
  observer = new ResizeObserver(() => {
    refit();
  });
  if (host.value !== undefined) {
    observer.observe(host.value);
    // Non-passive, because the move handler has to refuse the page's own scroll to keep the drag
    // inside the terminal.
    host.value.addEventListener("touchstart", onTouchStart, { passive: true });
    host.value.addEventListener("touchmove", onTouchMove, { passive: false });
    host.value.addEventListener("touchend", onTouchEnd, { passive: true });
    host.value.addEventListener("touchcancel", onTouchEnd, { passive: true });
  }
  emit("ready", props.sessionId, {
    write: (data) => {
      term.write(data);
    },
    clear: () => {
      // reset(), not clear(): a snapshot supersedes everything before it, including the modes and
      // scroll region the previous epoch left set.
      term.reset();
    },
    size: () => ({ cols: term.cols, rows: term.rows }),
    focus: () => {
      term.focus();
    },
    // xterm tracks DECCKM as the application sets and clears it, so the key row's arrows take
    // their form from the terminal rather than from a guess about what is running.
    applicationCursorKeys: () => term.modes.applicationCursorKeysMode,
  });
  refit();
});

watch(
  () => props.visible,
  (visible) => {
    if (visible) refit();
  },
);

onBeforeUnmount(() => {
  observer?.disconnect();
  host.value?.removeEventListener("touchstart", onTouchStart);
  host.value?.removeEventListener("touchmove", onTouchMove);
  host.value?.removeEventListener("touchend", onTouchEnd);
  host.value?.removeEventListener("touchcancel", onTouchEnd);
  emit("gone", props.sessionId);
  terminal?.dispose();
  terminal = undefined;
});
</script>

<template>
  <div v-show="visible" ref="host" class="pane"></div>
</template>

<style scoped>
.pane {
  position: absolute;
  inset: 0;
  background: #0f1115;
  /* The pane owns every touch gesture in it, so the browser never claims the drag for the page.
     Without this Safari scrolls the whole app and the terminal never moves. */
  touch-action: none;
}
</style>

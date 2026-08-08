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
  if (host.value !== undefined) observer.observe(host.value);
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
}
</style>

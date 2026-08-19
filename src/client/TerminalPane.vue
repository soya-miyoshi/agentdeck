<script setup lang="ts">
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

import { cellRatio, fontSizeFor, MIN_FONT_SIZE } from "./pane-fit.ts";
import type { TerminalHandle } from "./terminal-handle.ts";
import { scrollTarget, wheelDrag } from "./wheel.ts";

// The deck's width is the SERVER's number, arriving as a prop: the agent lays its output out at the
// width the PTY reports, and rendering at another leaves the difference as dead margin.
const BASE_FONT_SIZE = 13;

/**
 * What FitAddon silently subtracts before dividing: 14px for an overview ruler this deck does not
 * draw, and `|| 14` means zero cannot turn it off. Added back - it is 1.5 columns on a phone.
 */
const RULER_RESERVE = 14;

/**
 * The font size the cell width is measured at, once. `proposeDimensions` reports WHOLE columns, so
 * the smallest font spreads that floor over the most columns and the ratio is best there.
 */
const PROBE_FONT_SIZE = MIN_FONT_SIZE;

const props = defineProps<{ sessionId: string; visible: boolean; cols: number }>();
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
// Font passes left before the size in hand is accepted as good enough, so a pane that cannot
// settle renders something rather than re-measuring forever.
let passes = 0;
let pending: number | undefined;
// CSS pixels of cell width per pixel of font size. A property of the font, which never changes, so
// it is measured once: every later rotation and keyboard open sizes in a single pass off this.
let cellPerFontPx: number | undefined;

// One finger's position and the fraction of a row it has not paid for. xterm has no touch scrolling:
// `.xterm-screen` sits over the viewport, so a drag on the text rubber-bands the page instead.
let touchY: number | undefined;
let carry = 0;

/**
 * The text a copy takes: the selection, or the visible screen. A phone has no selection to offer -
 * the pane claims the gesture iOS would have used to make one - so that branch is the desktop's.
 */
const copyableText = (term: Terminal): string => {
  const selected = term.getSelection();
  if (selected !== "") return selected;
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let row = 0; row < term.rows; row += 1) {
    lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "");
  }
  // Trailing blanks are the unused part of the screen, not content someone wanted copied.
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
};

const rowHeight = (): number => {
  const term = terminal;
  if (term === undefined || host.value === undefined || term.rows === 0) return 0;
  return host.value.clientHeight / term.rows;
};

/** The cell a touch is over, 1-based, for a wheel report the application can place. */
const cellAt = (clientX: number, clientY: number): { col: number; row: number } => {
  const term = terminal;
  const box = host.value?.getBoundingClientRect();
  if (term === undefined || box === undefined || term.cols === 0 || term.rows === 0) {
    return { col: 1, row: 1 };
  }
  const col = Math.trunc(((clientX - box.left) / box.width) * term.cols) + 1;
  const row = Math.trunc(((clientY - box.top) / box.height) * term.rows) + 1;
  return {
    col: Math.min(term.cols, Math.max(1, col)),
    row: Math.min(term.rows, Math.max(1, row)),
  };
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
  // Dragging down shows earlier output, which is a negative line delta. An app tracking the mouse
  // owns its own transcript - Claude Code holds all of it on the alternate screen, where the
  // terminal has no scrollback - so the drag goes to it as wheel reports rather than scrolling here.
  if (lines !== 0) {
    if (scrollTarget(term.modes.mouseTrackingMode) === "application") {
      const cell = cellAt(point.clientX, point.clientY);
      emit("input", props.sessionId, wheelDrag(-lines, cell.col, cell.row));
    } else {
      term.scrollLines(-lines);
    }
  }
  event.preventDefault();
};

const onTouchEnd = (): void => {
  touchY = undefined;
  carry = 0;
};

// Two passes, because the addon measures the font IN EFFECT: rows for a size just assigned are
// still the previous font's. The size is not rounded - a floored font is narrow on every column.
const refit = (): void => {
  // A hidden pane has no size, and fitting it would report 0 rows as this client's constraint -
  // which the server takes as the minimum over attached clients and applies to everybody's pane.
  if (!props.visible || terminal === undefined || fit === undefined) return;
  const width = host.value?.clientWidth ?? 0;
  if (width <= RULER_RESERVE) return;
  const proposed = fit.proposeDimensions();
  if (proposed === undefined || proposed.cols <= 0 || proposed.rows <= 0) return;
  const current = terminal.options.fontSize ?? BASE_FONT_SIZE;

  // Measure the font, at the size where the addon's whole-column floor costs least.
  if (cellPerFontPx === undefined) {
    // Through `passes` like every other re-measure: a font size that would not take would other-
    // wise leave a requestAnimationFrame loop running for the life of the pane.
    if (current !== PROBE_FONT_SIZE && passes > 0) {
      passes -= 1;
      terminal.options.fontSize = PROBE_FONT_SIZE;
      pending = requestAnimationFrame(refit);
      return;
    }
    if (current !== PROBE_FONT_SIZE) return;
    // Too few columns to divide by means the pane is not laid out yet; measuring here would fix a
    // wrong ratio forever, since this is the only time it is read.
    cellPerFontPx = cellRatio(width, RULER_RESERVE, proposed.cols, PROBE_FONT_SIZE, props.cols);
    if (cellPerFontPx === undefined) return;
  }

  const size = fontSizeFor(width, props.cols, cellPerFontPx);
  if (Math.abs(size - current) > 0.05 && passes > 0) {
    passes -= 1;
    terminal.options.fontSize = size;
    // Measure again once the new font is in effect, rather than sizing to the old one's rows.
    pending = requestAnimationFrame(refit);
    return;
  }
  terminal.resize(props.cols, Math.max(1, proposed.rows));
  emit("resize", props.sessionId, props.cols, terminal.rows);
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
  // The pane is a VIEW; everything typed arrives from the composer. NOT `disableStdin`, which gates
  // `triggerDataEvent` and would swallow the terminal's own DSR replies - read-only textarea instead.
  if (term.textarea !== undefined) {
    term.textarea.readOnly = true;
    term.textarea.inputMode = "none";
  }
  term.attachCustomKeyEventHandler(() => false);
  // Never rendered locally: the pty echoes, and the agent may transform or refuse it. What still
  // reaches this past the read-only textarea is the terminal's own replies.
  term.onData((data) => {
    emit("input", props.sessionId, data);
  });
  terminal = term;
  fit = addon;
  observer = new ResizeObserver(() => {
    passes = 4;
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
    copyText: () => copyableText(term),
    // xterm tracks DECCKM as the application sets and clears it, so the key row's arrows take
    // their form from the terminal rather than from a guess about what is running.
    applicationCursorKeys: () => term.modes.applicationCursorKeysMode,
  });
  passes = 4;
  refit();
});

watch(
  () => props.visible,
  (visible) => {
    if (visible) {
      passes = 4;
      refit();
    }
  },
);

// The socket states the width after this pane may already be mounted, and again on every reconnect,
// so a restarted server corrects a live pane. `cellPerFontPx` survives, so it is one font pass.
watch(
  () => props.cols,
  () => {
    passes = 4;
    refit();
  },
);

onBeforeUnmount(() => {
  if (pending !== undefined) cancelAnimationFrame(pending);
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

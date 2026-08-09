<script setup lang="ts">
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

import { cellRatio, fontSizeFor, MIN_FONT_SIZE } from "./pane-fit.ts";
import type { TerminalHandle } from "./terminal-handle.ts";

// The deck is 40 columns wide, always. An agent's output is laid out by the agent at the width the
// PTY reports, and a width that moves with the device wraps the same paragraph differently on each.
const COLUMNS = 40;
const BASE_FONT_SIZE = 13;

/**
 * What FitAddon subtracts from the width before it divides, and does not tell anyone about.
 *
 * With `scrollback` non-zero it reserves `options.overviewRuler?.width || 14` for a ruler this deck
 * does not draw, and 0 is falsy, so configuring the width to zero yields 14 again - the reserve
 * cannot be turned off. It is added back here because 14 of a phone's 393 CSS pixels is a blank
 * column and a half at the right-hand edge.
 */
const RULER_RESERVE = 14;

/**
 * The font size the cell width is measured at, once.
 *
 * `proposeDimensions` reports whole columns, so the cell width read back from it carries the error
 * of that floor - and at a font that nearly fills the pane, 40 columns is all the resolution there
 * is and the error is a percent and a half. Measured at the smallest font instead, the same floor
 * lands across a hundred-odd columns and the ratio is good to well under one percent.
 */
const PROBE_FONT_SIZE = MIN_FONT_SIZE;

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
// Font passes left before the size in hand is accepted as good enough, so a pane that cannot
// settle renders something rather than re-measuring forever.
let passes = 0;
let pending: number | undefined;
// CSS pixels of cell width per pixel of font size. A property of the font, which never changes, so
// it is measured once: every later rotation and keyboard open sizes in a single pass off this.
let cellPerFontPx: number | undefined;

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

// Bring the font to the size at which COLUMNS fills the width, then take the rows from what that
// font actually measures. One pass cannot do both: the addon measures the font in effect, so the
// rows for a font size just assigned are still the previous font's until it has been applied.
//
// The size is NOT rounded to a whole pixel. It was, and a floored font is up to a whole step of
// cell width narrower than the pane on every one of 40 columns - 19 CSS pixels of dead margin,
// measured off a phone, on top of the 14 the addon reserves.
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
    cellPerFontPx = cellRatio(width, RULER_RESERVE, proposed.cols, PROBE_FONT_SIZE, COLUMNS);
    if (cellPerFontPx === undefined) return;
  }

  const size = fontSizeFor(width, COLUMNS, cellPerFontPx);
  if (Math.abs(size - current) > 0.05 && passes > 0) {
    passes -= 1;
    terminal.options.fontSize = size;
    // Measure again once the new font is in effect, rather than sizing to the old one's rows.
    pending = requestAnimationFrame(refit);
    return;
  }
  terminal.resize(COLUMNS, Math.max(1, proposed.rows));
  emit("resize", props.sessionId, COLUMNS, terminal.rows);
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
    focus: () => {
      term.focus();
    },
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

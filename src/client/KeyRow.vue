<script setup lang="ts">
import type { KeyName } from "./key-row.ts";

// Text labels, never glyphs: an arrow drawn as an emoji is a different height in every font on
// every phone, and the caps are the one row that has to stay legible with a thumb over half of it.
const caps: { key: KeyName; label: string }[] = [
  { key: "esc", label: "Esc" },
  { key: "tab", label: "Tab" },
  { key: "left", label: "Left" },
  { key: "down", label: "Down" },
  { key: "up", label: "Up" },
  { key: "right", label: "Right" },
  { key: "enter", label: "Enter" },
];

defineProps<{ ctrlLatched: boolean }>();
defineEmits<{ key: [key: KeyName] }>();
</script>

<template>
  <!-- `mousedown.prevent` / `touchstart.prevent`: the terminal must keep focus, or the soft
       keyboard closes under the user every time they reach for Esc. -->
  <div class="row">
    <button
      v-for="cap in caps"
      :key="cap.key"
      class="cap"
      type="button"
      @mousedown.prevent
      @touchstart.prevent
      @click="$emit('key', cap.key)"
    >
      {{ cap.label }}
    </button>
    <button
      class="cap"
      :class="{ latched: ctrlLatched }"
      type="button"
      :aria-pressed="ctrlLatched"
      @mousedown.prevent
      @touchstart.prevent
      @click="$emit('key', 'ctrl')"
    >
      Ctrl
    </button>
  </div>
</template>

<style scoped>
.row {
  display: flex;
  gap: 0.25rem;
  overflow-x: auto;
  /* Bottom edge of the app. The row's own background runs under the home indicator while the caps
     sit clear of it, so a thumb reaching for Enter does not hit the system's swipe area. */
  padding: 0.25rem calc(0.25rem + var(--safe-right)) calc(0.25rem + var(--safe-bottom))
    calc(0.25rem + var(--safe-left));
  background: #14161a;
  border-top: 1px solid #2a2e35;
}
.cap {
  flex: 1 0 auto;
  /* One-handed, in a hurry, with a process waiting on the answer. */
  min-height: var(--touch-target);
  min-width: var(--touch-target);
  padding: 0 0.5rem;
  border: 1px solid #2a2e35;
  border-radius: 6px;
  background: #1b1e24;
  color: #d7dae0;
  font: inherit;
  font-size: 0.85rem;
}
.cap.latched {
  border-color: #ffb454;
  background: #3a2f1c;
  color: #ffb454;
}
</style>

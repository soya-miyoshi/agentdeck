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
  <!-- Emitted on `pointerdown`, not `click`. `preventDefault` on a touch event suppresses the
       synthetic click iOS would have sent, so a `@click` handler behind `@touchstart.prevent`
       never fires on a phone - which is where this row is the whole point. Reported from a real
       device: every cap dead. `.prevent` still has to be here or the terminal loses focus and the
       soft keyboard closes under the thumb reaching for Esc. -->
  <div class="row">
    <button
      v-for="cap in caps"
      :key="cap.key"
      class="cap"
      type="button"
      @pointerdown.prevent="$emit('key', cap.key)"
    >
      {{ cap.label }}
    </button>
    <button
      class="cap"
      :class="{ latched: ctrlLatched }"
      type="button"
      :aria-pressed="ctrlLatched"
      @pointerdown.prevent="$emit('key', 'ctrl')"
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
  /* Eight caps share the row equally and SHRINK. A 44px min-width needs 388px for eight of them
     plus the gaps, which no phone has once the safe insets are off, so the row scrolled and Ctrl -
     the last cap, and the one Ctrl+C is on - was off the screen with nothing to say so. Height is
     the touch target that survives; a full-width row means every cap is under the thumb already. */
  flex: 1 1 0;
  min-width: 0;
  /* One-handed, in a hurry, with a process waiting on the answer. */
  min-height: var(--touch-target);
  padding: 0 0.125rem;
  border: 1px solid #2a2e35;
  border-radius: 6px;
  background: #1b1e24;
  color: #d7dae0;
  font: inherit;
  font-size: 0.8rem;
  /* `Right` and `Enter` are the widest labels; wrapping one to two lines is how a shrinking cap
     fails, and a two-line cap makes the row taller than the one beside it. */
  white-space: nowrap;
}
.cap.latched {
  border-color: #ffb454;
  background: #3a2f1c;
  color: #ffb454;
}
</style>

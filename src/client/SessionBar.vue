<script setup lang="ts">
import { computed } from "vue";

import type { Tab } from "./tabs.ts";

// The one row at the top: which session this is, and the two other things done from up here. A
// strip of tabs ran off the side of a phone at three sessions; the list lives in a panel instead.

const props = defineProps<{ tabs: Tab[]; active: string | undefined; panel: string | undefined }>();
defineEmits<{ sessions: []; select: []; more: [] }>();

const current = computed(() => props.tabs.find((tab) => tab.id === props.active));

/** Other sessions asking for you: the reason to open the list without having to open it. */
const waiting = computed(
  () => props.tabs.filter((tab) => tab.id !== props.active && tab.needsYou).length,
);
</script>

<template>
  <header class="bar">
    <button
      class="switcher"
      type="button"
      :aria-expanded="panel === 'sessions'"
      aria-label="Sessions"
      @click="$emit('sessions')"
    >
      <span v-if="current?.needsYou" class="dot" aria-label="needs you"></span>
      <span class="name">{{ current?.name ?? "No session" }}</span>
      <span v-if="current" class="status" :class="current.state">{{ current.status }}</span>
      <span v-if="waiting > 0" class="waiting">+{{ waiting }} waiting</span>
      <span class="count">{{ tabs.length }}</span>
    </button>
    <button
      v-if="active !== undefined"
      class="act"
      type="button"
      :aria-expanded="panel === 'select'"
      @click="$emit('select')"
    >
      Select
    </button>
    <button class="act" type="button" :aria-expanded="panel === 'more'" @click="$emit('more')">
      More
    </button>
  </header>
</template>

<style scoped>
.bar {
  display: flex;
  align-items: stretch;
  /* Top edge of the app: clear of the notch and status bar, with the background running under. */
  padding: var(--safe-top) var(--safe-right) 0 var(--safe-left);
  background: #14161a;
  border-bottom: 1px solid #2a2e35;
}
.switcher,
.act {
  min-height: var(--touch-target);
  border: 0;
  background: #1b1e24;
  color: #d7dae0;
  font: inherit;
}
.switcher {
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0 0.75rem;
  text-align: left;
}
.switcher[aria-expanded="true"],
.act[aria-expanded="true"] {
  background: #232833;
  box-shadow: inset 0 -2px 0 #6aa2ff;
}
.act {
  flex: 0 0 auto;
  padding: 0 0.9rem;
  border-left: 1px solid #2a2e35;
  font-size: 0.9rem;
}
.name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}
.status {
  flex: 0 0 auto;
  font-size: 0.8rem;
  color: #8b9099;
}
.status.working {
  color: #6aa2ff;
}
.status.waiting {
  color: #ffb454;
}
.waiting {
  flex: 0 0 auto;
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
  background: #3a2f1c;
  color: #ffb454;
  font-size: 0.8rem;
}
.count {
  margin-left: auto;
  flex: 0 0 auto;
  min-width: 1.5rem;
  padding: 0.1rem 0.35rem;
  border: 1px solid #2a2e35;
  border-radius: 4px;
  color: #8b9099;
  font-size: 0.8rem;
  text-align: center;
}
.dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #ffb454;
}
</style>

<script setup lang="ts">
import type { Tab } from "./tabs.ts";

defineProps<{ tabs: Tab[]; active: string | undefined }>();
defineEmits<{ select: [id: string] }>();
</script>

<template>
  <nav class="strip">
    <button
      v-for="tab in tabs"
      :key="tab.id"
      class="tab"
      :class="{ active: tab.id === active, exited: tab.state === 'exited' }"
      type="button"
      @click="$emit('select', tab.id)"
    >
      <!-- The dot is drawn only for an agent that can actually detect waiting. An agent with
           detectsWaiting false reports working/idle/exited and never claims waiting, and the
           client shows its tab without a needs-you indicator rather than inventing one. -->
      <span v-if="tab.needsYou" class="dot" aria-label="needs you"></span>
      <span class="name">{{ tab.name }}</span>
      <span class="status" :class="tab.state">{{ tab.status }}</span>
    </button>
    <p v-if="tabs.length === 0" class="empty">No sessions.</p>
  </nav>
</template>

<style scoped>
.strip {
  display: flex;
  gap: 0.25rem;
  overflow-x: auto;
  padding: 0.25rem;
  background: #14161a;
  border-bottom: 1px solid #2a2e35;
}
.tab {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex: 0 0 auto;
  /* Touch target rather than a pointer target: this is driven from a phone. */
  min-height: 44px;
  padding: 0 0.75rem;
  border: 1px solid #2a2e35;
  border-radius: 6px;
  background: #1b1e24;
  color: #d7dae0;
  font: inherit;
}
.tab.active {
  border-color: #6aa2ff;
  background: #232833;
}
.tab.exited {
  opacity: 0.7;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #ffb454;
}
.status {
  font-size: 0.75rem;
  color: #8b9099;
}
.status.working {
  color: #6aa2ff;
}
.status.waiting {
  color: #ffb454;
}
.empty {
  margin: 0;
  padding: 0.75rem;
  color: #8b9099;
}
</style>

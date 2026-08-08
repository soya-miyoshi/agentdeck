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
      :class="{
        active: tab.id === active,
        exited: tab.state === 'exited',
        deaf: tab.waitingDetectionLost,
      }"
      type="button"
      @click="$emit('select', tab.id)"
    >
      <!-- The dot is drawn only for an agent that can actually detect waiting. An agent with
           detectsWaiting false reports working/idle/exited and never claims waiting, and the
           client shows its tab without a needs-you indicator rather than inventing one. -->
      <span v-if="tab.needsYou" class="dot" aria-label="needs you"></span>
      <span class="name">{{ tab.name }}</span>
      <span class="status" :class="tab.state">{{ tab.status }}</span>
      <!-- The session outlived the server, so its hook secret is gone and it can never report
           waiting again until its agent is restarted (plan 002). It is said in WORDS and on the
           tab itself rather than as a colour or an icon: this is a tab that will look healthy and
           quietly never ask for you, and a person cannot infer that from a shade of grey. The
           sentence says what will not happen rather than what went wrong, because what will not
           happen is the part that changes what the user does - this tab has to be opened and
           looked at. The fix is in the title for the person who wants it. -->
      <span
        v-if="tab.waitingDetectionLost"
        class="lost"
        title="This session outlived the server, so it can no longer tell you when it needs you. Restart the agent in this tab to get it back."
        >no waiting alerts</span
      >
    </button>
    <p v-if="tabs.length === 0" class="empty">No sessions.</p>
  </nav>
</template>

<style scoped>
.strip {
  display: flex;
  gap: 0.25rem;
  overflow-x: auto;
  /* Top edge of the app: the row is pushed clear of the notch and the status bar, while the
     strip's own background still runs underneath them. */
  padding: calc(0.25rem + var(--safe-top)) calc(0.25rem + var(--safe-right)) 0.25rem
    calc(0.25rem + var(--safe-left));
  background: #14161a;
  border-bottom: 1px solid #2a2e35;
}
.tab {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex: 0 0 auto;
  /* Touch target rather than a pointer target: this is driven from a phone, one-handed, and a
     mis-hit here switches which agent's terminal the next keystroke goes to. */
  min-height: var(--touch-target);
  min-width: var(--touch-target);
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
.tab.deaf {
  /* Dashed, so the difference survives a glance and does not depend on reading the pill. */
  border-style: dashed;
}
.lost {
  font-size: 0.75rem;
  color: #c9a227;
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

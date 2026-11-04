<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from "vue";

import { nextArm } from "./close-arm.ts";
import type { Tab } from "./tabs.ts";

const props = defineProps<{ tabs: Tab[]; active: string | undefined }>();
const emit = defineEmits<{ select: [id: string]; close: [id: string]; new: [] }>();

// Closing kills the agent, so it takes two taps rather than one: the first arms the cap and the
// second acts. A single X beside a tab is a thumb's width from the control that switches tabs.
const armed = ref<string>();
const strip = ref<HTMLElement>();

/** How long an armed cap stays armed. A live kill switch that outlasts the thought is a trap. */
const ARM_MS = 3000;
let disarm: ReturnType<typeof setTimeout> | undefined;

/** First tap arms this tab's end cap, second tap ends it. It disarms itself after ARM_MS. */
const press = (id: string): void => {
  const next = nextArm(armed.value, id);
  armed.value = next.armed;
  clearTimeout(disarm);
  if (next.armed !== undefined) {
    disarm = setTimeout(() => {
      armed.value = undefined;
    }, ARM_MS);
  }
  if (next.close) emit("close", id);
};

watch(
  () => props.active,
  () => {
    armed.value = undefined;
    void nextTick(() => {
      strip.value?.querySelector(".tab.active")?.scrollIntoView({ block: "nearest" });
    });
  },
);

onBeforeUnmount(() => {
  clearTimeout(disarm);
});
</script>

<template>
  <nav ref="strip" class="strip">
    <div
      v-for="tab in tabs"
      :key="tab.id"
      class="tab"
      :class="{
        active: tab.id === active,
        exited: tab.state === 'exited',
        deaf: tab.waitingDetectionLost,
      }"
    >
      <button class="pick" type="button" @click="$emit('select', tab.id)">
        <!-- The dot is drawn only for an agent that can actually detect waiting. An agent with
           detectsWaiting false reports working/idle/exited and never claims waiting, and the
           client shows its tab without a needs-you indicator rather than inventing one. -->
        <span v-if="tab.needsYou" class="dot" aria-label="needs you"></span>
        <span class="name">{{ tab.name }}</span>
        <span class="status" :class="tab.state">{{ tab.status }}</span>
        <!-- The session outlived the server, so its hook secret is gone and it can never report
           waiting again until its agent is restarted (plan 002). It stays a WORD rather than
           becoming a colour or an icon: this is a tab that will look healthy and quietly never ask
           for you, and a person cannot infer that from a shade of grey. One word rather than the
           sentence it used to be, because at 40 columns the sentence was most of the tab - the
           sentence is in the title and the aria-label, which is where a person who wants it looks
           and where a screen reader takes it from. -->
        <span
          v-if="tab.waitingDetectionLost"
          class="lost"
          aria-label="waiting alerts are muted for this session"
          title="This session outlived the server, so it can no longer tell you when it needs you. Restart the agent in this tab to get it back."
          >muted</span
        >
      </button>
      <!-- Only on the tab being looked at, so a mis-hit cannot arm the close cap of an agent the
           operator is not watching. The armed word says what the next tap does. -->
      <button
        v-if="tab.id === active"
        class="close"
        :class="{ armed: armed === tab.id }"
        type="button"
        :aria-label="armed === tab.id ? `confirm ending ${tab.name}` : `end ${tab.name}`"
        @click="press(tab.id)"
      >
        {{ armed === tab.id ? "End?" : "End" }}
      </button>
    </div>
    <p v-if="tabs.length === 0" class="empty">No sessions.</p>
    <button class="new" type="button" @click="$emit('new')">New session</button>
  </nav>
</template>

<style scoped>
/* The sessions as a list in a panel, one full-width row each: a strip of tabs ran off the side of a
   phone at three sessions, and the off-screen one was the one waiting. */
.strip {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  flex: 0 1 auto;
  min-height: 0;
  max-height: 55vh;
  overflow-y: auto;
  padding: 0.5rem calc(0.5rem + var(--safe-right)) 0.5rem calc(0.5rem + var(--safe-left));
  background: #14161a;
  border-bottom: 1px solid #2a2e35;
}
.tab {
  display: flex;
  align-items: stretch;
  flex: 0 0 auto;
  border: 1px solid #2a2e35;
  border-radius: 6px;
  background: #1b1e24;
}
.pick,
.close,
.new {
  /* Touch target rather than a pointer target: a mis-hit here switches which agent's terminal the
     next keystroke goes to. */
  min-height: var(--touch-target);
  min-width: var(--touch-target);
  border: 0;
  background: none;
  color: #d7dae0;
  font: inherit;
}
.pick {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  text-align: left;
}
.close {
  padding: 0 0.9rem;
  border-left: 1px solid #2a2e35;
  color: #8b9099;
  font-size: 0.85rem;
}
.close.armed {
  /* The only red in the app, on the one control that destroys something. */
  background: #3a2226;
  color: #ff9d9d;
}
.new {
  flex: 0 0 auto;
  border: 1px dashed #3b4a63;
  border-radius: 6px;
  color: #a9c4ff;
}
.tab.active {
  border-color: #6aa2ff;
  background: #232833;
}
.tab.exited {
  opacity: 0.7;
}
.dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #ffb454;
}
.tab.deaf {
  /* Dashed, so the difference survives a glance and does not depend on reading the word. */
  border-style: dashed;
}
.name {
  /* The full name, wrapped: in a list there is room, and two sessions differing only in a suffix
     must be told apart. */
  overflow-wrap: anywhere;
  font-weight: 600;
}
.lost {
  font-size: 0.8rem;
  color: #c9a227;
}
.status {
  margin-left: auto;
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
.empty {
  margin: 0;
  padding: 0.75rem;
  color: #8b9099;
}
</style>

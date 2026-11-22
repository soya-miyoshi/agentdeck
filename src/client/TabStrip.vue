<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from "vue";

import { nextArm } from "./close-arm.ts";
import type { Tab } from "./tabs.ts";

const props = defineProps<{ tabs: Tab[]; active: string | undefined }>();
const emit = defineEmits<{
  select: [id: string];
  close: [id: string];
  new: [];
  rename: [id: string, title: string];
}>();

// Inline rename of the active tab: one field, Save writes it, empty clears back to the repo name.
const renaming = ref<string>();
const draft = ref("");
const field = ref<HTMLInputElement>();

const startRename = (tab: Tab): void => {
  armed.value = undefined;
  renaming.value = tab.id;
  draft.value = tab.title;
  void nextTick(() => field.value?.focus());
};

const saveRename = (id: string): void => {
  emit("rename", id, draft.value.trim());
  renaming.value = undefined;
};

const cancelRename = (): void => {
  renaming.value = undefined;
};

// Closing kills the agent, so it takes two taps rather than one: the first arms the cap and the
// second acts. A single X beside a tab is a thumb's width from the control that switches tabs.
const armed = ref<string>();
const strip = ref<HTMLElement>();

// Swipe-to-end: a left swipe on a row uncovers a red End cap; a tap on that cap ends the session.
// The swipe is the first deliberate act, the tap the second, so it is as hard to trigger by accident
// as the two-tap cap. Only one row is uncovered at a time.
const revealed = ref<string>();

/** How far a horizontal drag must travel to count as a swipe rather than a tap or a vertical scroll. */
const SWIPE_PX = 45;
let gesture: { x: number; y: number; id: string } | undefined;

const onTouchStart = (id: string, event: TouchEvent): void => {
  const touch = event.changedTouches[0];
  gesture = touch === undefined ? undefined : { x: touch.clientX, y: touch.clientY, id };
};

/** A mostly-horizontal drag past the threshold reveals (leftward) or hides (rightward) the End cap;
 *  anything shorter or more vertical is left alone, so a tap and a vertical scroll both still work.
 *  On a swipe it cancels the click the browser would synthesise, so the gesture does not also fire
 *  the row's tap handler - more reliable than a flag, since a swipe may emit no click at all. */
const onTouchEnd = (id: string, event: TouchEvent): void => {
  const start = gesture;
  gesture = undefined;
  const touch = event.changedTouches[0];
  if (start === undefined || touch === undefined || start.id !== id) return;
  const dx = touch.clientX - start.x;
  const dy = touch.clientY - start.y;
  if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) <= Math.abs(dy)) return;
  event.preventDefault();
  revealed.value = dx < 0 ? id : undefined;
};

/** A tap on a row: dismiss this row's uncovered cap, else select the tab and clear any other cap. */
const pickTab = (id: string): void => {
  if (revealed.value === id) {
    revealed.value = undefined;
    return;
  }
  revealed.value = undefined;
  emit("select", id);
};

const confirmSwipeEnd = (id: string): void => {
  revealed.value = undefined;
  emit("close", id);
};

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
    renaming.value = undefined;
    revealed.value = undefined;
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
      <!-- The row content. It stays put on a swipe so the name is still readable while deciding to
           end it; the End cap slides in over the status pill at the right instead. -->
      <div
        class="swipebody"
        @touchstart.passive="onTouchStart(tab.id, $event)"
        @touchend="onTouchEnd(tab.id, $event)"
      >
      <button class="pick" type="button" @click="pickTab(tab.id)">
        <!-- The dot is drawn only for an agent that can actually detect waiting. An agent with
           detectsWaiting false reports working/idle/exited and never claims waiting, and the
           client shows its tab without a needs-you indicator rather than inventing one. -->
        <span v-if="tab.needsYou" class="dot" aria-label="needs you"></span>
        <span class="name">{{ tab.name }}</span>
        <!-- The repo folder, shown only when the name is a custom title and so no longer says it. -->
        <span v-if="tab.dir !== tab.name" class="dir" :title="tab.cwd">{{ tab.dir }}</span>
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
      <!-- Only on the active tab: a rename control, then the close cap. On a mis-hit the close cap
           arming is still two taps, so neither sits a thumb's width from a destructive single tap. -->
      <button
        v-if="tab.id === active && renaming !== tab.id"
        class="rename"
        type="button"
        :aria-label="`rename ${tab.name}`"
        @click="startRename(tab)"
      >
        Rename
      </button>
      <!-- Only on the tab being looked at, so a mis-hit cannot arm the close cap of an agent the
           operator is not watching. The armed word says what the next tap does. -->
      <button
        v-if="tab.id === active && renaming !== tab.id"
        class="close"
        :class="{ armed: armed === tab.id }"
        type="button"
        :aria-label="armed === tab.id ? `confirm ending ${tab.name}` : `end ${tab.name}`"
        @click="press(tab.id)"
      >
        {{ armed === tab.id ? "End?" : "End" }}
      </button>
      <!-- The rename field is a full-width row under the name, because a phone tab is too narrow to
           hold a text input beside the name and status without one shoving the other off-screen. -->
      <form v-if="renaming === tab.id" class="renamer" @submit.prevent="saveRename(tab.id)">
        <input
          ref="field"
          v-model="draft"
          class="renamefield"
          type="text"
          maxlength="80"
          placeholder="tab name (empty resets to the repo name)"
          aria-label="new tab name"
          @keydown.escape="cancelRename"
        />
        <button class="save" type="submit">Save</button>
        <button class="cancelrename" type="button" @click="cancelRename">Cancel</button>
      </form>
      </div>
      <!-- Slid in by a left swipe: one tap here ends the session. The swipe to show it is the first
           deliberate act and the tap is the second, so this one-tap cap is still two acts to a kill.
           Kept in the DOM but inert while hidden, so it can slide rather than appear. -->
      <button
        class="swipeend"
        :class="{ shown: revealed === tab.id }"
        type="button"
        :aria-hidden="revealed === tab.id ? 'false' : 'true'"
        :tabindex="revealed === tab.id ? 0 : -1"
        :aria-label="`end ${tab.name}`"
        @click="confirmSwipeEnd(tab.id)"
      >
        End
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
  /* The swipe body slides within this; the uncovered End cap sits in the space it leaves, clipped to
     the rounded rect so nothing shows until a swipe. */
  position: relative;
  overflow: hidden;
  flex: 0 0 auto;
  border: 1px solid #2a2e35;
  border-radius: 6px;
  background: #1b1e24;
}
.swipebody {
  display: flex;
  flex-wrap: wrap;
  align-items: stretch;
  background: #1b1e24;
}
.swipeend {
  position: absolute;
  top: 0;
  right: 0;
  width: 5.5rem;
  height: 100%;
  border: 0;
  /* The same red as the two-tap cap: the one colour in the app, on the controls that destroy. */
  background: #3a2226;
  color: #ff9d9d;
  font: inherit;
  /* Parked off the right edge (clipped by the tab's overflow) and slid in when shown, so the reveal
     reads as one motion and the name under it never moves. */
  transform: translateX(100%);
  transition: transform 0.18s ease;
}
.swipeend.shown {
  transform: translateX(0);
}
.pick,
.close,
.rename,
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
.rename {
  padding: 0 0.9rem;
  border-left: 1px solid #2a2e35;
  color: #8b9099;
  font-size: 0.85rem;
}
.renamer {
  /* A full-width row of its own: the field and its two buttons wrap under the tab name. */
  flex: 1 0 100%;
  display: flex;
  gap: 0.35rem;
  padding: 0 0.5rem 0.5rem;
}
.renamefield {
  flex: 1 1 auto;
  min-width: 0;
  min-height: var(--touch-target);
  padding: 0.4rem 0.6rem;
  border: 1px solid #3b4a63;
  border-radius: 6px;
  background: #14161a;
  color: #d7dae0;
  font: inherit;
}
.save,
.cancelrename {
  flex: 0 0 auto;
  min-height: var(--touch-target);
  min-width: var(--touch-target);
  padding: 0 0.8rem;
  border: 1px solid #2a2e35;
  border-radius: 6px;
  background: none;
  color: #d7dae0;
  font: inherit;
}
.save {
  border-color: #3b4a63;
  color: #a9c4ff;
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
.tab.active .swipebody {
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
.dir {
  /* The repo folder beside a custom title: small and muted, a label not a heading. */
  flex: 0 0 auto;
  padding: 0.05rem 0.35rem;
  border-radius: 4px;
  background: #22262e;
  color: #8b9099;
  font-size: 0.75rem;
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

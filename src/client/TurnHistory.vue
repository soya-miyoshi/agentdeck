<script setup lang="ts">
import { ref } from "vue";

import type { Turn } from "../turn-log.ts";
import { title, when } from "./turn-history.ts";

// The answers, as a list rather than as scrollback. Plan 007: the reason this exists is that
// finding a finished answer by dragging a repainting TUI on a phone is the wrong way to do it.

defineProps<{ turns: Turn[]; truncated: boolean; loading: boolean; error?: string }>();
const emit = defineEmits<{ close: [] }>();

// Which turn is open, by promptId. One at a time: the point is to read one answer, not to scroll.
const openId = ref<string>();
const toggle = (promptId: string): void => {
  openId.value = openId.value === promptId ? undefined : promptId;
};
const now = Date.now();
</script>

<template>
  <div class="history">
    <div class="head">
      <span class="heading">Answers</span>
      <button class="close" type="button" @click="emit('close')">Done</button>
    </div>
    <div class="list">
      <p v-if="error" class="none">{{ error }}</p>
      <p v-else-if="loading" class="none">Loading…</p>
      <p v-else-if="turns.length === 0" class="none">
        No finished turns yet. An answer is recorded when the agent ends a turn.
      </p>
      <div v-for="turn in turns" :key="turn.promptId" class="turn">
        <button class="row" type="button" @click="toggle(turn.promptId)">
          <span class="when">{{ when(turn.endedAt, now) }}</span>
          <span class="title">{{ title(turn) }}</span>
        </button>
        <!-- Selectable, and wrapped by the browser at this phone's width. Not a terminal. -->
        <div v-if="openId === turn.promptId" class="body">
          <p v-if="turn.prompt !== ''" class="asked">{{ turn.prompt }}</p>
          <p class="answer">{{ turn.answer }}</p>
          <p v-if="turn.truncated" class="cut">This turn was longer than the log keeps.</p>
        </div>
      </div>
      <p v-if="truncated" class="none">Older turns are not shown.</p>
    </div>
  </div>
</template>

<style scoped>
.history {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  background: #0f1115;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.4rem 0.75rem;
  background: #232833;
}
.heading {
  color: #d7dae0;
  font-size: 0.85rem;
}
.close {
  border: 0;
  border-radius: 0.4rem;
  padding: 0.35rem 0.8rem;
  background: #39405060;
  color: #d7dae0;
  font: inherit;
  font-size: 0.85rem;
}
.list {
  flex: 1;
  min-height: 0;
  /* The whole reason for the feature: this scrolls like a page, not like a terminal. */
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}
.turn {
  border-bottom: 1px solid #1c202a;
}
.row {
  display: flex;
  gap: 0.6rem;
  width: 100%;
  border: 0;
  padding: 0.6rem 0.75rem;
  background: transparent;
  color: #d7dae0;
  font: inherit;
  font-size: 0.9rem;
  text-align: left;
}
.when {
  flex: none;
  color: #7d8590;
  font-variant-numeric: tabular-nums;
}
.title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.body {
  padding: 0 0.75rem 0.75rem;
}
.asked {
  margin: 0 0 0.6rem;
  color: #7d8590;
  font-size: 0.85rem;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.answer {
  margin: 0;
  color: #d7dae0;
  font-size: 0.9rem;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  user-select: text;
  -webkit-user-select: text;
}
.cut,
.none {
  margin: 0.6rem 0 0;
  padding: 0 0.75rem;
  color: #7d8590;
  font-size: 0.8rem;
}
</style>

<script setup lang="ts">
import { nextTick, ref } from "vue";

import type { SubmitMode } from "./composer.ts";

// The input path. Everything typed on the phone is edited here and reaches the pty as one submit;
// the pane above is a view of what the agent is doing, not a keyboard.

// How tall the box may grow before it scrolls instead. Beyond this it is eating the pane it exists
// to let you read, and what is being written at that length is a paste rather than a sentence.
const MAX_ROWS = 5;

defineProps<{ ctrlLatched: boolean; disabled: boolean }>();
const emit = defineEmits<{ submit: [text: string, mode: SubmitMode] }>();

const text = ref("");
const box = ref<HTMLTextAreaElement>();

/** Grow with the content up to MAX_ROWS. `auto` first, or the height only ever ratchets up. */
const resize = (): void => {
  const element = box.value;
  if (element === undefined) return;
  element.style.height = "auto";
  const line = Number.parseFloat(getComputedStyle(element).lineHeight) || 20;
  element.style.height = `${Math.min(element.scrollHeight, line * MAX_ROWS)}px`;
};

/**
 * Hand the text up and empty the box WITHOUT taking focus off it: a submit that blurs closes the
 * soft keyboard, and the next thing after answering an agent is usually answering it again.
 */
const submit = (mode: SubmitMode): void => {
  const value = text.value;
  if (value === "") return;
  text.value = "";
  emit("submit", value, mode);
  void nextTick(resize);
};

/**
 * Put text in the box for the person to finish rather than on the wire - for an uploaded image's
 * path, so the question is written beside it before anything is sent.
 */
const insert = (value: string): void => {
  text.value = `${text.value}${value}`;
  box.value?.focus();
  void nextTick(resize);
};

defineExpose({ insert });
</script>

<template>
  <div class="composer">
    <!-- `pointerdown.prevent` on the buttons, for the reason KeyRow.vue documents at length: a
         handler that fires on a synthetic click never fires on a phone once the default is
         prevented, and the default is what has to be prevented to keep the keyboard open. -->
    <textarea
      ref="box"
      v-model="text"
      class="box"
      rows="1"
      :disabled="disabled"
      :placeholder="disabled ? 'No session' : 'Type, paste or dictate here'"
      autocapitalize="off"
      autocomplete="off"
      autocorrect="off"
      spellcheck="false"
      @input="resize"
    ></textarea>
    <button
      class="act"
      type="button"
      :disabled="disabled"
      title="Send the text without pressing Enter"
      @pointerdown.prevent="submit('insert')"
    >
      Insert
    </button>
    <button
      class="act send"
      :class="{ latched: ctrlLatched }"
      type="button"
      :disabled="disabled"
      @pointerdown.prevent="submit('send')"
    >
      {{ ctrlLatched ? "Ctrl+" : "Send" }}
    </button>
  </div>
</template>

<style scoped>
.composer {
  display: flex;
  align-items: flex-end;
  gap: 0.25rem;
  padding: 0.25rem calc(0.25rem + var(--safe-right)) 0.25rem calc(0.25rem + var(--safe-left));
  background: #14161a;
  border-top: 1px solid #2a2e35;
}
.box {
  flex: 1 1 auto;
  min-width: 0;
  min-height: var(--touch-target);
  padding: 0.5rem;
  box-sizing: border-box;
  border: 1px solid #2a2e35;
  border-radius: 6px;
  background: #1b1e24;
  color: #d7dae0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  /* 16px exactly, and not a rem or a smaller number: Safari zooms the whole page in when a field
     below 16px takes focus, and the app is pinned to the visual viewport that zoom then changes. */
  font-size: 16px;
  line-height: 1.3;
  resize: none;
  overflow-y: auto;
}
.act {
  flex: 0 0 auto;
  min-height: var(--touch-target);
  padding: 0 0.7rem;
  border: 1px solid #2a2e35;
  border-radius: 6px;
  background: #1b1e24;
  color: #d7dae0;
  font: inherit;
  font-size: 0.85rem;
  white-space: nowrap;
}
.act.send {
  border-color: #3b4a63;
  background: #26303f;
}
.act.send.latched {
  border-color: #ffb454;
  background: #3a2f1c;
  color: #ffb454;
}
.act:disabled {
  color: #8b929e;
}
</style>

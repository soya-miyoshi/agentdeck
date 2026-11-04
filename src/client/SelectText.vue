<script setup lang="ts">
import { nextTick, onMounted, ref } from "vue";

// The terminal's text as plain, selectable text over the pane. The terminal itself claims every
// touch for scrolling, so this is where iOS's own long-press, handles and Copy menu work.

const props = defineProps<{ text: string }>();
const emit = defineEmits<{ close: []; refused: [] }>();

const body = ref<HTMLPreElement>();
const copyLabel = ref("Copy all");

onMounted(() => {
  // Newest output is what someone opened this for, and it is at the bottom.
  void nextTick(() => {
    if (body.value !== undefined) body.value.scrollTop = body.value.scrollHeight;
  });
});

const copyAll = async (): Promise<void> => {
  try {
    await navigator.clipboard.writeText(props.text);
    copyLabel.value = "Copied";
  } catch {
    // A refused clipboard is said, not hidden; the text is still selectable by hand.
    emit("refused");
  }
};
</script>

<template>
  <section class="select" aria-label="Select text">
    <p class="hint">Press and hold to select, then Copy.</p>
    <pre ref="body" class="text">{{ text }}</pre>
    <div class="actions">
      <button class="act" type="button" @click="() => void copyAll()">{{ copyLabel }}</button>
      <button class="act done" type="button" @click="emit('close')">Done</button>
    </div>
  </section>
</template>

<style scoped>
.select {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  background: #0f1115;
}
.hint {
  margin: 0;
  padding: 0.4rem calc(0.6rem + var(--safe-right)) 0.4rem calc(0.6rem + var(--safe-left));
  background: #14161a;
  color: #8b9099;
  font-size: 0.8rem;
}
.text {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 0.5rem calc(0.6rem + var(--safe-right)) 0.5rem calc(0.6rem + var(--safe-left));
  overflow-y: auto;
  /* What the terminal refuses: the platform's own selection. */
  -webkit-user-select: text;
  user-select: text;
  touch-action: pan-y;
  -webkit-touch-callout: default;
  color: #d7dae0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
  line-height: 1.35;
  /* Long lines wrap here, where reading matters more than columns lining up. */
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.actions {
  display: flex;
  gap: 0.5rem;
  padding: 0.4rem calc(0.5rem + var(--safe-right)) 0.4rem calc(0.5rem + var(--safe-left));
  background: #14161a;
  border-top: 1px solid #2a2e35;
}
.act {
  flex: 1 1 0;
  min-height: var(--touch-target);
  border: 1px solid #2a2e35;
  border-radius: 6px;
  background: #1b1e24;
  color: #d7dae0;
  font: inherit;
}
.act.done {
  flex: 2 1 0;
  border-color: #3b4a63;
  background: #26303f;
}
</style>

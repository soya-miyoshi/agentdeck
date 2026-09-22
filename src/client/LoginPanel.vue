<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";

import { codeBytes } from "./login.ts";

// `/login` for a phone: the URL the pane split across rows as one link, and a field for the code.
// Reads the pane on a timer while open, because the URL appears only after a method is chosen.

const props = defineProps<{ find: () => string | undefined }>();
const emit = defineEmits<{ send: [bytes: string]; close: [] }>();

const url = ref(props.find());
const code = ref("");
const copyLabel = ref("Copy URL");

const timer = setInterval(() => {
  url.value = props.find();
}, 1000);
onBeforeUnmount(() => {
  clearInterval(timer);
});

const copy = async (): Promise<void> => {
  if (url.value === undefined) return;
  try {
    await navigator.clipboard.writeText(url.value);
    copyLabel.value = "Copied";
  } catch {
    copyLabel.value = "Copy refused";
  }
};

/** Send the code and close: the prompt that asked for it is gone once it is answered. */
const submit = (): void => {
  const bytes = codeBytes(code.value);
  if (bytes === "") return;
  emit("send", bytes);
  code.value = "";
  emit("close");
};
</script>

<template>
  <section class="login">
    <template v-if="url === undefined">
      <p class="hint">
        No sign-in URL on this pane yet. Start <code>/login</code>, choose a method with the arrows
        and Enter, and the link appears here.
      </p>
      <div class="row">
        <button class="act" type="button" @click="emit('send', '/login\r')">Start /login</button>
        <button class="act" type="button" @click="emit('close')">Close</button>
      </div>
    </template>
    <template v-else>
      <div class="row">
        <a class="act open" :href="url" target="_blank" rel="noopener noreferrer">Open sign-in</a>
        <button class="act" type="button" @click="() => void copy()">{{ copyLabel }}</button>
        <button class="act" type="button" @click="emit('close')">Close</button>
      </div>
      <p class="url">{{ url }}</p>
      <form class="row" @submit.prevent="submit">
        <input
          v-model="code"
          class="code"
          type="text"
          placeholder="Paste the code from the browser"
          autocapitalize="off"
          autocomplete="off"
          autocorrect="off"
          spellcheck="false"
        />
        <button class="act send" type="submit" :disabled="code.trim() === ''">Send code</button>
      </form>
    </template>
  </section>
</template>

<style scoped>
.login {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.5rem calc(0.5rem + var(--safe-right)) 0.5rem calc(0.5rem + var(--safe-left));
  background: #14161a;
  border-bottom: 1px solid #2a2e35;
  color: #d7dae0;
  font-size: 0.85rem;
}
.hint,
.url {
  margin: 0;
}
.url {
  max-height: 3.6em;
  overflow: hidden;
  color: #8b929e;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.75rem;
  word-break: break-all;
}
.row {
  display: flex;
  gap: 0.25rem;
}
.act {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  min-height: var(--touch-target);
  padding: 0 0.7rem;
  border: 1px solid #2a2e35;
  border-radius: 6px;
  background: #1b1e24;
  color: #d7dae0;
  font: inherit;
  text-decoration: none;
}
.act.open,
.act.send {
  border-color: #3b4a63;
  background: #26303f;
}
.act:disabled {
  color: #8b929e;
}
.code {
  flex: 1 1 auto;
  min-width: 0;
  min-height: var(--touch-target);
  padding: 0 0.5rem;
  box-sizing: border-box;
  border: 1px solid #2a2e35;
  border-radius: 6px;
  background: #1b1e24;
  color: #d7dae0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  /* 16px exactly: Safari zooms the page in on a smaller focused field (see Composer.vue). */
  font-size: 16px;
}
</style>

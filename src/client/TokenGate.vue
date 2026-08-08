<script setup lang="ts">
import { ref } from "vue";

import { normaliseToken } from "./token-store.ts";

defineProps<{ message: string | undefined }>();
const emit = defineEmits<{ token: [token: string] }>();

const pasted = ref("");

const submit = (): void => {
  const token = normaliseToken(pasted.value);
  if (token === undefined) return;
  pasted.value = "";
  emit("token", token);
};
</script>

<template>
  <form class="gate" @submit.prevent="submit">
    <h1>agentdeck</h1>
    <!-- The server's sentence, verbatim. Rewording a refusal loses the advice it contained. -->
    <p v-if="message" class="message">{{ message }}</p>
    <p v-else class="message">Paste the token the server printed on first run.</p>
    <input
      v-model="pasted"
      class="field"
      type="password"
      autocomplete="off"
      autocapitalize="off"
      autocorrect="off"
      spellcheck="false"
      placeholder="token"
      aria-label="token"
    />
    <button type="submit">Connect</button>
  </form>
</template>

<style scoped>
.gate {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  max-width: 26rem;
  margin: 3rem auto;
  /* The gate is the whole page before a token exists, so it owns every edge itself. */
  padding: calc(1rem + var(--safe-top)) calc(1rem + var(--safe-right)) calc(1rem + var(--safe-bottom))
    calc(1rem + var(--safe-left));
}
h1 {
  margin: 0;
  font-size: 1.1rem;
}
.message {
  margin: 0;
  color: #8b9099;
}
.field,
button {
  min-height: var(--touch-target);
  padding: 0 0.75rem;
  border: 1px solid #2a2e35;
  border-radius: 6px;
  background: #1b1e24;
  color: #d7dae0;
  font: inherit;
}
</style>

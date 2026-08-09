<script setup lang="ts">
import { ref } from "vue";

// Picks an image and hands the raw file up. The downscale and the upload belong to the caller,
// which is the one that has the token and knows which session is active.

defineProps<{ busy: boolean }>();
const emit = defineEmits<{ pick: [file: File] }>();

const input = ref<HTMLInputElement>();

// The value is cleared after every pick, or choosing the SAME screenshot twice fires no change
// event the second time and the button reads as dead.
const picked = (event: Event): void => {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  target.value = "";
  if (file !== undefined) emit("pick", file);
};
</script>

<template>
  <button class="upload" type="button" :disabled="busy" @click="input?.click()">
    {{ busy ? "Sending…" : "Image" }}
  </button>
  <!-- No `capture`: with it, iOS opens the camera and ONLY the camera, and a screenshot of this
       app - the thing this button exists for - lives in the photo library. Without it the sheet
       offers library, camera and Files. -->
  <input ref="input" class="file" type="file" accept="image/*" @change="picked" />
</template>

<style scoped>
.upload {
  align-self: flex-start;
  margin: 0 0.75rem 0.25rem;
  border: 0;
  border-radius: 0.4rem;
  /* Same target as the key row: this is reached one-handed too. */
  min-height: var(--touch-target);
  padding: 0.35rem 0.8rem;
  background: #39405060;
  color: #d7dae0;
  font: inherit;
  font-size: 0.85rem;
}
.upload:disabled {
  color: #8b929e;
}
.file {
  display: none;
}
</style>

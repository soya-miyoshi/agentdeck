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
  /* Sits in the New session bar, so it is flush with it rather than a floating chip: no margin,
     no radius, and the same height, which is also the one-handed touch target. */
  flex: 0 0 auto;
  border: 0;
  border-left: 1px solid #2a2e35;
  min-height: var(--touch-target);
  padding: 0 0.9rem;
  background: #1b1e24;
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

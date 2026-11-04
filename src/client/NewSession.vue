<script setup lang="ts">
import { computed, ref, watch } from "vue";

import type { AgentSummary, Cwd } from "./wire.ts";
import { agentChoices, canStart, directoryChoices } from "./new-session.ts";

// The picker: a directory and an agent, both from what the server reported. 44px targets, and the
// sheet carries the bottom inset because it is the last thing above the home indicator.

// Open state is the app's, so opening this closes every other panel rather than stacking on it.
const props = defineProps<{ cwds: Cwd[]; agents: AgentSummary[]; busy: boolean; open: boolean }>();
const emit = defineEmits<{
  start: [cwd: string, agent: string];
  toggle: [];
  close: [];
  open: [];
}>();

const cwd = ref<string>();
const agent = ref<string>();

const directories = computed(() => directoryChoices(props.cwds));
const choices = computed(() => agentChoices(props.agents));
const startable = computed(() =>
  canStart(directories.value, choices.value, cwd.value, agent.value),
);

// The allowlist and PATH are both read fresh each time it opens: an agent installed since the
// page loaded, or a session started elsewhere, would otherwise be missing from the list.
watch(
  () => props.open,
  (now) => {
    if (now) emit("open");
  },
);

const start = (): void => {
  if (!startable.value || cwd.value === undefined || agent.value === undefined) return;
  emit("start", cwd.value, agent.value);
  emit("close");
};
</script>

<template>
  <div class="picker">
    <!-- The bar is the deck's one row of session-level actions. The slot is where a sibling action
         sits so it reads as the same level as `New session` rather than as a stray button above
         it; the sheet below still spans the full width. -->
    <div class="bar">
      <!-- The label never turns into "Close": that word sat right under the tab's kill cap, and a
           thumb dismissing this sheet armed a session kill. Cancel, at the bottom, closes it. -->
      <button
        class="toggle"
        :class="{ on: open }"
        type="button"
        aria-label="New session"
        :aria-expanded="open"
        @click="emit('toggle')"
      >
        New
      </button>
      <slot name="beside" />
    </div>
    <div v-if="open" class="sheet">
      <p class="label">Directory</p>
      <p v-if="directories.length === 0" class="none">
        No directories are allowlisted, so no session can start. Set AGENTDECK_ROOTS (or
        AGENTDECK_MOUNTS) on the Mac.
      </p>
      <button
        v-for="dir in directories"
        :key="dir.path"
        class="row"
        :class="{ chosen: dir.path === cwd }"
        type="button"
        :title="dir.path"
        @click="cwd = dir.path"
      >
        <span class="name">{{ dir.name }}</span>
        <span v-if="dir.note" class="note">{{ dir.note }}</span>
      </button>

      <p class="label">Agent</p>
      <!-- Disabled with the reason, never hidden: see agentChoices in new-session.ts. -->
      <button
        v-for="choice in choices"
        :key="choice.id"
        class="row"
        :class="{ chosen: choice.id === agent, off: !choice.selectable }"
        type="button"
        :disabled="!choice.selectable"
        @click="agent = choice.id"
      >
        <span class="name">{{ choice.name }}</span>
        <span v-if="choice.note" class="note">{{ choice.note }}</span>
      </button>

      <div class="actions">
        <button class="cancel" type="button" @click="emit('close')">Cancel</button>
        <button class="start" type="button" :disabled="!startable || busy" @click="start">
          {{ busy ? "Starting…" : "Start" }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.picker {
  display: flex;
  flex-direction: column;
  flex: 0 1 auto;
  min-height: 0;
  border-bottom: 1px solid #2a2e35;
  background: #14161a;
}
.bar {
  display: flex;
  align-items: stretch;
  /* The toggle takes the rest, so a sibling action keeps only the width its label needs. */
  padding-right: var(--safe-right);
  padding-left: var(--safe-left);
}
.toggle,
.start {
  min-height: var(--touch-target);
  padding: 0 0.75rem;
  border: 0;
  background: #1b1e24;
  color: #d7dae0;
  font: inherit;
  text-align: left;
}
.toggle {
  /* Takes the row and leaves the slotted actions their labels' width. Basis 0, not auto, so the
     siblings never push the bar past a phone's width. */
  flex: 1 1 0;
  white-space: nowrap;
}
.toggle.on {
  background: #232833;
  box-shadow: inset 0 -2px 0 #6aa2ff;
}
.actions {
  /* Pinned to the bottom of the sheet, so Cancel and Start are on screen however long the lists
     are: a sheet whose way out has to be scrolled to is a sheet that will not close. */
  position: sticky;
  bottom: calc(-0.5rem - var(--safe-bottom));
  display: flex;
  gap: 0.5rem;
  margin: 0.5rem calc(-0.5rem - var(--safe-right)) calc(-0.5rem - var(--safe-bottom))
    calc(-0.5rem - var(--safe-left));
  padding: 0.5rem calc(0.5rem + var(--safe-right)) calc(0.5rem + var(--safe-bottom))
    calc(0.5rem + var(--safe-left));
  background: #14161a;
  border-top: 1px solid #2a2e35;
}
.cancel {
  flex: 1 1 0;
  min-height: var(--touch-target);
  border: 1px solid #2a2e35;
  border-radius: 6px;
  background: #1b1e24;
  color: #d7dae0;
  font: inherit;
}
.start {
  flex: 2 1 0;
  border-radius: 6px;
  background: #24406b;
  text-align: center;
}
.start:disabled,
.row.off {
  opacity: 0.5;
}
.sheet {
  min-height: 0;
  padding: 0.5rem calc(0.5rem + var(--safe-right)) calc(0.5rem + var(--safe-bottom))
    calc(0.5rem + var(--safe-left));
  /* Small enough that the terminal under it keeps a few rows: vh ignores the soft keyboard. */
  max-height: 42vh;
  overflow-y: auto;
}
.label {
  margin: 0.5rem 0 0.25rem;
  color: #8b9099;
  font-size: 0.75rem;
}
.none {
  margin: 0;
  color: #c9a227;
  font-size: 0.8rem;
}
.row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  /* Touch target, not a pointer target: this is driven one-handed from a phone. */
  min-height: var(--touch-target);
  margin-bottom: 0.25rem;
  padding: 0 0.75rem;
  border: 1px solid #2a2e35;
  border-radius: 6px;
  background: #1b1e24;
  color: #d7dae0;
  font: inherit;
  text-align: left;
}
.row.chosen {
  border-color: #6aa2ff;
  background: #232833;
}
.note {
  margin-left: auto;
  color: #8b9099;
  font-size: 0.75rem;
}
</style>

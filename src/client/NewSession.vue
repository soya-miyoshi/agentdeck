<script setup lang="ts">
import { computed, ref } from "vue";

import type { AgentSummary } from "../agent-profiles.ts";
import type { Cwd } from "../cwds.ts";
import { agentChoices, canStart, directoryChoices } from "./new-session.ts";

// The picker: a directory and an agent, both chosen from what the server reported. Text labels
// only, 44px targets, and the sheet carries the bottom inset because it is the last thing above
// the home indicator while it is open.

const props = defineProps<{ cwds: Cwd[]; agents: AgentSummary[]; busy: boolean }>();
const emit = defineEmits<{ start: [cwd: string, agent: string]; open: [] }>();

const open = ref(false);
const cwd = ref<string>();
const agent = ref<string>();

const directories = computed(() => directoryChoices(props.cwds));
const choices = computed(() => agentChoices(props.agents));
const startable = computed(() => canStart(directories.value, choices.value, cwd.value, agent.value));

const toggle = (): void => {
  open.value = !open.value;
  // The allowlist and PATH are both read fresh each time it opens: an agent installed since the
  // page loaded, or a session started elsewhere, would otherwise be missing from the list.
  if (open.value) emit("open");
};

const start = (): void => {
  if (!startable.value || cwd.value === undefined || agent.value === undefined) return;
  emit("start", cwd.value, agent.value);
  open.value = false;
};
</script>

<template>
  <div class="picker">
    <button class="toggle" type="button" @click="toggle">
      {{ open ? "Close" : "New session" }}
    </button>
    <div v-if="open" class="sheet">
      <p class="label">Directory</p>
      <p v-if="directories.length === 0" class="none">
        No directories are allowlisted, so no session can start. Set AGENTDECK_MOUNTS on the Mac.
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

      <button class="start" type="button" :disabled="!startable || busy" @click="start">
        {{ busy ? "Starting…" : "Start" }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.picker {
  border-bottom: 1px solid #2a2e35;
  background: #14161a;
}
.toggle,
.start {
  min-height: var(--touch-target);
  width: 100%;
  padding: 0 0.75rem;
  border: 0;
  background: #1b1e24;
  color: #d7dae0;
  font: inherit;
  text-align: left;
}
.start {
  margin-top: 0.5rem;
  background: #24406b;
  text-align: center;
}
.start:disabled,
.row.off {
  opacity: 0.5;
}
.sheet {
  padding: 0.5rem calc(0.5rem + var(--safe-right)) calc(0.5rem + var(--safe-bottom))
    calc(0.5rem + var(--safe-left));
  max-height: 60vh;
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

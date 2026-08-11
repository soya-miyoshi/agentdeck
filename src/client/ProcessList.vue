<script setup lang="ts">
// What each session is running, on a phone. The caller mounts this only while the panel is open,
// and it reads once on mount: the route costs a `ps` of the whole machine, so polling it would be a
// background cost for a view nobody is looking at most of the time.

import { onMounted, ref } from "vue";

import { fetchProcesses, type SessionProcesses } from "./api.ts";

const props = defineProps<{ token: string }>();

const loading = ref(false);
const error = ref("");
const sessions = ref<SessionProcesses[]>([]);

/** Megabytes, because kilobytes on a phone is a number nobody can compare at a glance. */
const mb = (kb: number): string => `${String(Math.round(kb / 1024))}MB`;

/** `4d`, `3h`, `12m`, `40s` - one unit, since this is read to spot what is OLD, not to time it. */
const age = (seconds: number): string => {
  if (seconds < 0) return "?";
  if (seconds < 60) return `${String(seconds)}s`;
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))}m`;
  if (seconds < 86400) return `${String(Math.floor(seconds / 3600))}h`;
  return `${String(Math.floor(seconds / 86400))}d`;
};

const load = async (): Promise<void> => {
  loading.value = true;
  error.value = "";
  try {
    sessions.value = await fetchProcesses(props.token);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    loading.value = false;
  }
};

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="processes">
    <button type="button" class="refresh" :disabled="loading" @click="void load()">
      {{ loading ? "Reading…" : "Refresh" }}
    </button>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-else-if="!loading && sessions.length === 0" class="empty">No live sessions.</p>
    <section v-for="session in sessions" :key="session.sessionId" class="session">
      <h3>
        {{ session.sessionId }}
        <!-- The count and size are of what is BELOW the pane, which is what the session has
             accumulated rather than what it is. -->
        <span class="tally"> {{ session.childCount }} child(ren), {{ mb(session.childRssKb) }} </span>
      </h3>
      <ul>
        <li
          v-for="row in session.processes"
          :key="row.pid"
          :style="{ paddingLeft: `${String(row.depth * 12)}px` }"
          :class="{ pane: row.depth === 0 }"
        >
          <span class="meta">{{ age(row.ageSeconds) }} · {{ mb(row.rssKb) }}</span>
          <span class="command">{{ row.command }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
/* Hangs below the New session bar, whose toggle opens it, so it is a sheet like the picker's
   rather than a strip at the far end of the app from its own control. */
.processes {
  max-height: 40vh;
  overflow-y: auto;
  padding: 0 calc(0.6rem + var(--safe-right)) 0.6rem calc(0.6rem + var(--safe-left));
  background: #14161a;
  border-bottom: 1px solid #2a2e35;
  font-size: 0.8rem;
}
.refresh {
  min-height: var(--touch-target);
  background: none;
  border: none;
  color: inherit;
  font: inherit;
  padding: 0.4rem 0.6rem;
}
.session h3 {
  font-size: 0.8rem;
  font-weight: 600;
  margin: 0.4rem 0 0.2rem;
}
.tally {
  font-weight: 400;
  opacity: 0.7;
}
ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
li {
  display: flex;
  gap: 0.5rem;
  padding-block: 1px;
  white-space: nowrap;
}
/* The pane process is the agent itself rather than something it left behind, so it does not read
   as one more item on a list of leftovers. */
li.pane {
  font-weight: 600;
}
.meta {
  opacity: 0.6;
  flex: 0 0 auto;
}
.command {
  overflow: hidden;
  text-overflow: ellipsis;
}
.error {
  color: #f88;
}
.empty {
  opacity: 0.7;
}
</style>

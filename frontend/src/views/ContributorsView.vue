<template>
  <section class="card contributors-panel" aria-labelledby="contributors-title">
    <h2 id="contributors-title" class="section-title">{{ t('contributors.title') }}</h2>
    <p class="subtle">{{ t('contributors.subtitle') }}</p>

    <p v-if="loading" class="subtle" role="status">{{ t('common.loading') }}</p>
    <p v-else-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
    <p v-else-if="contributors.length === 0" class="subtle">{{ t('contributors.empty') }}</p>
    <ul v-else class="contributor-grid">
      <li v-for="contributor in contributors" :key="contributor.githubUrl" class="contributor-card">
        <a
          :href="contributor.githubUrl"
          target="_blank"
          rel="noopener noreferrer"
          :aria-label="t('contributors.openProfile', { name: contributor.name })"
        >
          <span class="contributor-name">{{ contributor.name }}</span>
          <span class="github-label">GitHub <span aria-hidden="true">↗</span></span>
        </a>
      </li>
    </ul>
  </section>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import api from '@/services/api';
import { useI18n } from '@/i18n';

const contributors = ref([]);
const loading = ref(true);
const errorMessage = ref('');
const { t } = useI18n();

onMounted(async () => {
  try {
    contributors.value = (await api.get('/contributors')).data.items || [];
  } catch (err) {
    errorMessage.value = err?.response?.data?.message || t('contributors.loadFailed');
  } finally {
    loading.value = false;
  }
});
</script>

<style scoped>
.contributors-panel { padding: 1.2rem; }
.contributor-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: .8rem; list-style: none; margin: 1rem 0 0; padding: 0; }
.contributor-card a { display: flex; justify-content: space-between; align-items: center; gap: 1rem; min-height: 4.5rem; padding: 1rem; border: 1px solid var(--line); border-radius: 12px; background: var(--panel-soft); transition: border-color .18s ease, transform .14s ease; }
.contributor-card a:hover { border-color: var(--muted); transform: translateY(-1px); }
.contributor-card a:focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; }
.contributor-name { font-weight: 800; overflow-wrap: anywhere; }
.github-label { color: var(--muted); white-space: nowrap; font-size: .9rem; }
</style>

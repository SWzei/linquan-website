<template>
  <section class="card not-found">
    <p class="code">404</p>
    <h2>{{ t('notFound.title') }}</h2>
    <p class="subtle">{{ t('notFound.message') }}</p>
    <router-link class="btn" to="/">{{ t('notFound.home') }}</router-link>
  </section>
</template>

<script setup>
import { useI18n } from '@/i18n';

const { t } = useI18n();
</script>

<style scoped>
.not-found {
  width: min(520px, 100%);
  margin: 3rem auto;
  padding: 2rem;
  text-align: center;
}

.code {
  margin: 0;
  color: var(--accent);
  font-size: 4rem;
  font-weight: 800;
}
</style>

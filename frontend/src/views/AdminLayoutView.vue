<template>
  <section class="admin-shell">
    <article class="card nav-card">
      <router-link :to="{ name: 'adminPublishing' }">{{ t('admin.pagePublishing') }}</router-link>
      <router-link :to="{ name: 'adminScheduling' }">{{ t('admin.pageScheduling') }}</router-link>
      <router-link :to="{ name: 'adminClassMatching' }">{{ t('admin.pageClassMatching') }}</router-link>
      <router-link :to="{ name: 'adminConcerts' }">{{ t('admin.pageConcerts') }}</router-link>
      <router-link :to="{ name: 'adminGallery' }">{{ t('admin.pageGallery') }}</router-link>
      <router-link :to="{ name: 'adminMembers' }">{{ t('admin.pageMembers') }}</router-link>
      <router-link :to="{ name: 'adminArchive' }">{{ t('archive.title') }}</router-link>
    </article>

    <router-view />
  </section>
</template>

<script setup>
import { useI18n } from '@/i18n';

const { t } = useI18n();
</script>

<style scoped>
.admin-shell {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}

.nav-card {
  padding: 0.65rem;
  display: flex;
  gap: 0.55rem;
  flex-wrap: wrap;
}

.nav-card a {
  padding: 0.5rem 0.8rem;
  border-radius: 10px;
  border: 1px solid var(--line);
  background: var(--panel-soft);
  font-weight: 700;
  transition:
    background-color 0.18s ease,
    color 0.18s ease,
    box-shadow 0.18s ease,
    transform 0.14s ease,
    filter 0.18s ease;
}

.nav-card a:hover {
  background: #2a2f36;
  color: #ffffff;
  filter: brightness(1.04);
  box-shadow: 0 8px 16px rgba(255, 255, 255, 0.08);
  transform: translateY(-1px);
}

.nav-card a.router-link-active {
  border-color: var(--accent);
  background: #23272c;
}
</style>

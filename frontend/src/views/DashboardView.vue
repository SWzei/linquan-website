<template>
  <section class="hero card">
    <img
      class="hero-image"
      :src="heroImageUrl"
      :alt="t('dashboard.heroPhotoAlt')"
      width="1600"
      height="900"
      fetchpriority="high"
    />
    <div class="hero-overlay"></div>
    <div class="hero-content">
      <h2 class="section-title">{{ t('dashboard.sloganTitle') }}</h2>
      <p>{{ t('dashboard.sloganBody') }}</p>
    </div>
  </section>

  <section class="grid-2 board">
    <article class="card panel">
      <h3>{{ t('dashboard.activityTitle') }}</h3>
      <p class="subtle board-subtitle">{{ t('dashboard.activitySubtitle') }}</p>
      <ul class="notice-list">
        <li v-for="item in activities" :key="item.id" class="notice-card">
          <h4>{{ item.title }}</h4>
          <p class="subtle notice-meta">{{ formatDate(item.eventTime || item.publishedAt || item.createdAt) }}<span v-if="item.location"> · {{ item.location }}</span></p>
          <p class="notice-body multiline-text">{{ item.content }}</p>
          <div v-if="item.attachments?.length" class="attachment-block">
            <p class="subtle attachment-title">{{ t('dashboard.attachmentsTitle', { count: item.attachments.length }) }}</p>
            <ul class="attachment-list">
              <li v-for="attachment in item.attachments" :key="attachment.id" class="attachment-row">
                <span class="attachment-kind">{{ attachmentTypeLabel(attachment) }}</span>
                <a class="attachment-name" :href="attachment.viewUrl || attachment.url" target="_blank" rel="noopener">{{ attachment.originalName }}</a>
                <span class="subtle attachment-size">{{ formatBytes(attachment.fileSize || attachment.size) }}</span>
                <div class="attachment-actions">
                  <a class="attachment-link" :href="attachment.viewUrl || attachment.url" target="_blank" rel="noopener">{{ t('common.open') }}</a>
                  <a class="attachment-link" :href="attachment.downloadUrl || attachment.url" :download="attachment.originalName" rel="noopener">{{ t('common.download') }}</a>
                </div>
              </li>
            </ul>
          </div>
        </li>
        <li v-if="activities.length === 0" class="subtle empty-card">{{ t('dashboard.noActivities') }}</li>
      </ul>
    </article>

    <article class="card panel">
      <h3>{{ t('dashboard.announcementTitle') }}</h3>
      <p class="subtle board-subtitle">{{ t('dashboard.announcementSubtitle') }}</p>
      <ul class="notice-list">
        <li v-for="item in announcements" :key="item.id" class="notice-card">
          <h4>{{ item.title }}</h4>
          <p class="subtle notice-meta">{{ formatDate(item.publishedAt || item.createdAt) }}</p>
          <p class="notice-body multiline-text">{{ item.content }}</p>
          <div v-if="item.attachments?.length" class="attachment-block">
            <p class="subtle attachment-title">{{ t('dashboard.attachmentsTitle', { count: item.attachments.length }) }}</p>
            <ul class="attachment-list">
              <li v-for="attachment in item.attachments" :key="attachment.id" class="attachment-row">
                <span class="attachment-kind">{{ attachmentTypeLabel(attachment) }}</span>
                <a class="attachment-name" :href="attachment.viewUrl || attachment.url" target="_blank" rel="noopener">{{ attachment.originalName }}</a>
                <span class="subtle attachment-size">{{ formatBytes(attachment.fileSize || attachment.size) }}</span>
                <div class="attachment-actions">
                  <a class="attachment-link" :href="attachment.viewUrl || attachment.url" target="_blank" rel="noopener">{{ t('common.open') }}</a>
                  <a class="attachment-link" :href="attachment.downloadUrl || attachment.url" :download="attachment.originalName" rel="noopener">{{ t('common.download') }}</a>
                </div>
              </li>
            </ul>
          </div>
        </li>
        <li v-if="announcements.length === 0" class="subtle empty-card">{{ t('dashboard.noAnnouncements') }}</li>
      </ul>
    </article>
  </section>

  <section v-if="auth.isAdmin" class="card panel admin-panel">
    <h3>{{ t('dashboard.adminTitle') }}</h3>
    <p class="subtle">{{ t('dashboard.adminSubtitle') }}</p>
    <ul class="admin-list">
      <li>{{ t('dashboard.adminItemConcert') }}</li>
      <li>{{ t('dashboard.adminItemSchedule') }}</li>
      <li>{{ t('dashboard.adminItemNotice') }}</li>
    </ul>
    <router-link to="/admin" class="btn">{{ t('dashboard.goAdmin') }}</router-link>
  </section>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import api from '@/services/api';
import { useI18n } from '@/i18n';
import { useAuthStore } from '@/stores/auth';
import { formatDateTimeInBeijing } from '@/utils/dateTime';

const activities = ref([]);
const announcements = ref([]);
const { t, locale } = useI18n();
const auth = useAuthStore();
const heroImageUrl = `${process.env.BASE_URL || '/'}photos/hero/home-hero.jpg`;

function formatDate(value) {
  return formatDateTimeInBeijing(value, locale.value);
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!value) return '0 B';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function attachmentTypeLabel(attachment) {
  const name = String(attachment?.originalName || '');
  const extension = name.includes('.') ? name.split('.').pop() : '';
  if (extension) return extension.toUpperCase();
  const mimeType = String(attachment?.mimeType || '');
  if (mimeType.startsWith('image/')) return 'IMG';
  if (mimeType === 'application/pdf') return 'PDF';
  return 'FILE';
}

onMounted(async () => {
  try {
    const [activityRes, announcementRes] = await Promise.all([api.get('/activities'), api.get('/announcements')]);
    activities.value = activityRes.data.items || [];
    announcements.value = announcementRes.data.items || [];
  } catch (err) {
    // keep dashboard quiet on transient load failures
  }
});
</script>

<style scoped>
.hero { position: relative; overflow: hidden; min-height: 320px; padding: 1.2rem; display: flex; align-items: flex-end; }
.hero-image { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: center 54%; }
.hero-overlay { position: absolute; inset: 0; background: radial-gradient(circle at 80% 20%, rgba(212, 175, 55, .08), transparent 38%), linear-gradient(90deg, rgba(5, 6, 8, .88), rgba(5, 6, 8, .36) 72%, rgba(5, 6, 8, .18)); }
.hero-content { position: relative; z-index: 1; }
.hero-content p { margin: 0; max-width: 680px; }
.board { margin-top: 1rem; }
.panel { padding: 1rem; }
.panel h3 { margin: 0; font-size: 1.15rem; }
.board-subtitle { margin: 0.35rem 0 0; }
.notice-list { margin: 0.9rem 0 0; list-style: none; padding: 0; display: flex; flex-direction: column; gap: 0.8rem; }
.notice-card, .empty-card { border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 14px; padding: 0.85rem 0.95rem; background: var(--panel-soft); }
.notice-card h4 { margin: 0; font-size: 1.06rem; line-height: 1.4; }
.notice-meta { margin: 0.35rem 0 0; }
.notice-body { margin: 0.7rem 0 0; line-height: 1.7; }
.multiline-text { white-space: pre-wrap; word-break: break-word; }
.attachment-block { margin-top: 0.7rem; }
.attachment-title { margin: 0 0 0.35rem; }
.attachment-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.35rem; }
.attachment-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; gap: 0.55rem; align-items: center; padding: 0.45rem 0.55rem; border-radius: 10px; background: rgba(255, 255, 255, 0.03); }
.attachment-kind { min-width: 3.1rem; text-align: center; padding: 0.22rem 0.42rem; border-radius: 8px; background: rgba(198, 165, 111, 0.16); color: #f2d7a4; font-size: 0.75rem; font-weight: 700; }
.attachment-name { min-width: 0; overflow-wrap: anywhere; color: var(--ink); text-decoration: none; }
.attachment-name:hover, .attachment-link:hover { text-decoration: underline; }
.attachment-size { white-space: nowrap; }
.attachment-actions { display: inline-flex; gap: 0.6rem; flex-wrap: wrap; }
.attachment-link { color: var(--accent); text-decoration: none; }
.admin-panel { margin-top: 1rem; }
.admin-list { margin: 0.8rem 0 1rem; padding-left: 1.15rem; color: var(--ink); }
.admin-list li { margin: 0.35rem 0; }
@media (max-width: 920px) {
  .hero { min-height: 240px; }
  .hero-image { object-position: center; }
  .attachment-row { grid-template-columns: 1fr; align-items: flex-start; }
}
</style>

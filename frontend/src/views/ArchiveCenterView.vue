<template>
  <section class="card panel" aria-labelledby="archive-title">
    <h2 id="archive-title" class="section-title">{{ t('archive.title') }}</h2>
    <p class="subtle">{{ t(auth.isMaintainer ? 'archive.maintainerScope' : 'archive.adminScope') }}</p>

    <form class="filters" role="search" @submit.prevent="loadRecords">
      <div class="field"><label for="archive-search">{{ t('archive.search') }}</label><input id="archive-search" v-model.trim="filters.search" /></div>
      <div class="field"><label for="archive-module">{{ t('archive.module') }}</label><select id="archive-module" v-model="filters.module"><option value="">{{ t('archive.allModules') }}</option><option v-for="item in modules" :key="item" :value="item">{{ moduleLabel(item) }}</option></select></div>
      <div class="field"><label for="archive-status">{{ t('archive.status') }}</label><select id="archive-status" v-model="filters.status"><option value="">{{ t('archive.currentArchives') }}</option><option value="archived">{{ t('archive.archived') }}</option><option value="deletion_requested">{{ t('archive.deletionRequested') }}</option><option value="restored">{{ t('archive.statuses.restored') }}</option><option value="permanently_deleted">{{ t('archive.statuses.permanently_deleted') }}</option></select></div>
      <button class="btn" type="submit" :disabled="loading">{{ t('archive.apply') }}</button>
    </form>

    <p v-if="loading" role="status" class="subtle">{{ t('common.loading') }}</p>
    <p v-else-if="records.length === 0" role="status" class="empty">{{ t('archive.empty') }}</p>
    <ul v-else class="archive-list">
      <li v-for="record in records" :key="record.id" class="archive-row">
        <div>
          <strong>{{ record.title }}</strong>
          <p class="subtle">{{ moduleLabel(record.module) }} · #{{ record.recordId }} · {{ statusLabel(record.status) }} · {{ formatDate(record.archivedAt) }}</p>
        </div>
        <div class="actions">
          <button class="btn secondary" type="button" @click="reviewHistory(record)">{{ t('archive.history') }}</button>
          <button v-if="!auth.isMaintainer && ['archived', 'deletion_requested'].includes(record.status)" class="btn secondary" type="button" @click="restore(record)">{{ t('archive.restore') }}</button>
          <button v-if="!auth.isMaintainer && record.status === 'archived'" class="btn warn" type="button" @click="requestDeletion(record)">{{ t('archive.requestDeletion') }}</button>
          <button v-if="auth.isMaintainer && record.status === 'deletion_requested'" class="btn warn" type="button" @click="permanentDelete(record)">{{ t('archive.permanentDelete') }}</button>
        </div>
      </li>
    </ul>
  </section>

  <section v-if="selected" class="card panel section-space" aria-labelledby="archive-history-title">
    <h3 id="archive-history-title">{{ t('archive.historyFor', { title: selected.title }) }}</h3>
    <p v-if="historyLoading" role="status" class="subtle">{{ t('common.loading') }}</p>
    <ol v-else class="history-list">
      <li v-for="entry in history" :key="entry.id"><strong>{{ actionLabel(entry.action) }}</strong> · {{ formatDate(entry.createdAt) }} · {{ entry.actorCredential }}<p v-if="entry.reason" class="subtle">{{ entry.reason }}</p></li>
    </ol>
  </section>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
import api from '@/services/api';
import { useAuthStore } from '@/stores/auth';
import { useI18n } from '@/i18n';
import { useToast } from '@/composables/toast';
import { formatDateTimeInBeijing } from '@/utils/dateTime';

const modules = ['publishing', 'scheduling', 'class_matching', 'concert_management', 'gallery_display', 'member_accounts'];
const auth = useAuthStore();
const { t, locale } = useI18n();
const { showSuccess, showError } = useToast();
const filters = reactive({ search: '', module: '', status: '' });
const records = ref([]); const history = ref([]); const selected = ref(null);
const loading = ref(false); const historyLoading = ref(false);
const basePath = () => auth.isMaintainer ? '/maintainer/archive' : '/admin/archive';
const moduleLabel = (value) => t(`archive.modules.${value}`);
const statusLabel = (value) => t(`archive.statuses.${value}`);
const actionLabel = (value) => t(`archive.actions.${value}`);
const formatDate = (value) => formatDateTimeInBeijing(value, locale.value);

async function loadRecords() {
  loading.value = true;
  try { records.value = (await api.get(basePath(), { params: filters })).data.items || []; }
  catch (err) { showError(err, t('archive.loadFailed')); }
  finally { loading.value = false; }
}
async function reviewHistory(record) {
  selected.value = record; historyLoading.value = true;
  try { history.value = (await api.get(`${basePath()}/history`, { params: { archiveId: record.id } })).data.items || []; }
  catch (err) { showError(err, t('archive.loadFailed')); }
  finally { historyLoading.value = false; }
}
async function restore(record) {
  if (!window.confirm(t('archive.confirmRestore', { title: record.title }))) return;
  try { await api.post(`/admin/archive/${record.id}/restore`, {}); showSuccess(t('archive.restored')); await loadRecords(); }
  catch (err) { showError(err, t('archive.actionFailed')); }
}
async function requestDeletion(record) {
  const reason = window.prompt(t('archive.reasonPrompt'));
  if (!reason?.trim()) return;
  try { await api.post(`/admin/archive/${record.id}/deletion-request`, { reason: reason.trim() }); showSuccess(t('archive.requested')); await loadRecords(); }
  catch (err) { showError(err, t('archive.actionFailed')); }
}
async function permanentDelete(record) {
  const expected = `PERMANENTLY DELETE ${record.module}/${record.recordType}/${record.recordId}`;
  const confirmation = window.prompt(t('archive.confirmPermanent', { expected }));
  if (confirmation !== expected) return;
  try { await api.post(`/maintainer/archive/${record.id}/permanent-delete`, { confirmation }); showSuccess(t('archive.deleted')); await loadRecords(); }
  catch (err) { showError(err, t('archive.actionFailed')); }
}
onMounted(loadRecords);
</script>

<style scoped>
.panel{padding:1rem}.filters{display:grid;grid-template-columns:2fr 1fr 1fr auto;gap:.7rem;align-items:end}.archive-list,.history-list{list-style:none;padding:0;margin:1rem 0 0}.archive-row{display:flex;justify-content:space-between;gap:1rem;align-items:center;border-top:1px solid var(--line);padding:.85rem 0}.archive-row p{margin:.25rem 0 0}.actions{display:flex;gap:.45rem;flex-wrap:wrap}.empty{padding:2rem;text-align:center;border:1px dashed var(--line);border-radius:12px;color:var(--muted)}.history-list li{border-top:1px solid var(--line);padding:.7rem 0}.history-list p{margin:.25rem 0 0}@media(max-width:760px){.filters{grid-template-columns:1fr}.archive-row{align-items:flex-start;flex-direction:column}.actions{width:100%}.actions .btn{flex:1}}
</style>

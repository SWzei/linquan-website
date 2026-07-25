<template>
  <section class="grid-2">
    <ConcertEditorForm
      :mode="formMode"
      :form="editorForm"
      :active-title="selectedConcert?.title || ''"
      :current-attachment-path="selectedConcert?.attachmentPath || ''"
      :selected-attachment-name="selectedAttachmentFile?.name || ''"
      :remove-attachment="removeAttachment"
      :release-message="releaseMessage"
      :submitting="savingConcert"
      :releasing="releasingConcert"
      :deleting="deletingConcert"
      :disabled="editorBusy"
      :file-input-nonce="attachmentInputNonce"
      :accept="concertAttachmentAccept"
      @submit="submitConcertForm"
      @release="releaseConcert"
      @delete="deleteConcert"
      @reset-mode="beginCreateMode"
      @file-change="handleAttachmentFileChange"
      @update:form="updateEditorForm"
      @update:remove-attachment="removeAttachment = $event"
      @update:release-message="releaseMessage = $event"
    />

    <article class="card panel">
      <div class="section-head">
        <div>
          <h2 class="section-title">{{ t('admin.manageConcerts') }}</h2>
          <p class="subtle">
            {{ selectedConcert ? t('admin.currentConcertEditing', { title: selectedConcert.title }) : t('admin.currentConcertCreating') }}
          </p>
        </div>
        <button class="btn secondary" type="button" :disabled="concertsLoading || editorBusy" @click="refreshConcerts">
          {{ concertsLoading ? t('common.loading') : t('admin.refreshConcerts') }}
        </button>
      </div>

      <ul v-if="concerts.length" class="concert-list">
        <li
          v-for="item in concerts"
          :key="item.id"
          :class="{ active: item.id === selectedConcertId }"
          @click="selectConcert(item.id)"
        >
          <div class="concert-item-head">
            <h3>{{ item.title }}</h3>
            <span class="status-pill">{{ t(`concertStatus.${item.status}`) }}</span>
          </div>
          <p class="subtle" v-if="item.applicationDeadline">
            {{ t('admin.applicationDeadline') }}: {{ formatDate(item.applicationDeadline) }}
          </p>
          <p class="subtle multiline-text">{{ item.announcement || item.description || t('concerts.noDetails') }}</p>
        </li>
      </ul>
      <p v-else-if="concertsLoading" class="subtle">{{ t('common.loading') }}</p>
      <p v-else class="subtle">{{ t('admin.noConcertsAdmin') }}</p>
    </article>
  </section>

  <section class="grid-2 section-space">
    <article class="card panel">
      <div class="section-head">
        <div>
          <h2 class="section-title">{{ t('admin.registrationListTitle') }}</h2>
          <p class="subtle">
            {{ selectedConcert ? t('admin.registrationCount', { count: registrations.length }) : t('admin.registrationRequiresConcert') }}
          </p>
          <p v-if="selectedConcert && loadingRegistrations && registrations.length" class="subtle inline-loading">
            {{ t('common.loading') }}
          </p>
        </div>
        <div class="row action-row">
          <button
            class="btn secondary"
            type="button"
            :disabled="!selectedConcertId || loadingRegistrations"
            @click="loadRegistrations({ force: true, preserveExisting: true })"
          >
            {{ loadingRegistrations ? t('common.loading') : t('admin.loadRegistrations') }}
          </button>
          <button
            class="btn secondary"
            type="button"
            :disabled="!selectedConcertId || downloadingRegistrationsCsv"
            @click="downloadRegistrationsCsv"
          >
            {{ downloadingRegistrationsCsv ? t('common.loading') : t('admin.downloadRegistrationsCsv') }}
          </button>
        </div>
      </div>

      <p v-if="!selectedConcert" class="subtle">{{ t('admin.registrationRequiresConcert') }}</p>
      <p v-else-if="loadingRegistrations && registrations.length === 0" class="subtle">{{ t('common.loading') }}</p>
      <p v-else-if="registrations.length === 0" class="subtle">{{ t('admin.noRegistrations') }}</p>

      <div v-else class="registration-list">
        <button
          v-for="item in registrations"
          :key="item.id"
          type="button"
          class="registration-item"
          :class="{ active: item.id === selectedRegistrationId }"
          @click="selectRegistration(item.id)"
        >
          <h3>{{ item.applicantName || item.displayName }}</h3>
          <p class="subtle">{{ item.applicantStudentNumber || item.studentNumber }}</p>
          <p class="subtle multiline-text">{{ item.pieceZh || item.pieceTitle || '-' }}</p>
        </button>
      </div>
    </article>

    <article class="card panel">
      <h2 class="section-title">{{ t('admin.registrationDetailTitle') }}</h2>
      <p v-if="!selectedConcert" class="subtle">{{ t('admin.registrationRequiresConcert') }}</p>
      <p v-else-if="loadingRegistrations && registrations.length === 0" class="subtle">{{ t('common.loading') }}</p>
      <p v-else-if="!selectedRegistration" class="subtle">{{ t('admin.registrationDetailEmpty') }}</p>

      <template v-else>
        <div class="detail-grid">
          <div>
            <span class="label">{{ t('common.name') }}</span>
            <strong>{{ selectedRegistration.applicantName || selectedRegistration.displayName || '-' }}</strong>
          </div>
          <div>
            <span class="label">{{ t('common.student') }}</span>
            <strong>{{ selectedRegistration.applicantStudentNumber || selectedRegistration.studentNumber || '-' }}</strong>
          </div>
          <div>
            <span class="label">{{ t('common.status') }}</span>
            <strong>{{ t(`applicationStatus.${selectedRegistration.status}`) || selectedRegistration.status || '-' }}</strong>
          </div>
          <div>
            <span class="label">{{ t('concerts.durationMin') }}</span>
            <strong>{{ selectedRegistration.durationMin ?? '-' }}</strong>
          </div>
          <div>
            <span class="label">{{ t('concerts.contactQq') }}</span>
            <strong>{{ selectedRegistration.contactQq || '-' }}</strong>
          </div>
          <div>
            <span class="label">{{ t('admin.submittedAt') }}</span>
            <strong>{{ formatDate(selectedRegistration.createdAt) }}</strong>
          </div>
          <div>
            <span class="label">{{ t('admin.updatedAt') }}</span>
            <strong>{{ formatDate(selectedRegistration.updatedAt) }}</strong>
          </div>
          <div>
            <span class="label">{{ t('admin.viewScoreFile') }}</span>
            <strong v-if="selectedRegistration.scoreFilePath">
              <button class="link-button" type="button" @click="openScoreFile">
                {{ t('admin.viewScoreFile') }}
              </button>
            </strong>
            <strong v-else>{{ t('concerts.noScoreFile') }}</strong>
          </div>
        </div>

        <div class="field section-space">
          <label>{{ t('concerts.pieceZh') }}</label>
          <textarea :value="selectedRegistration.pieceZh || selectedRegistration.pieceTitle || ''" rows="3" readonly />
        </div>
        <div class="field">
          <label>{{ t('concerts.pieceEn') }}</label>
          <textarea :value="selectedRegistration.pieceEn || selectedRegistration.composer || ''" rows="3" readonly />
        </div>
        <div class="field" v-if="selectedRegistration.feedback">
          <label>{{ t('common.feedback') }}</label>
          <textarea :value="selectedRegistration.feedback" rows="4" readonly />
        </div>
      </template>
    </article>
  </section>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import api from '@/services/api';
import { useI18n } from '@/i18n';
import { useToast } from '@/composables/toast';
import ConcertEditorForm from '@/components/admin/ConcertEditorForm.vue';
import { formatDateTimeInBeijing, utcIsoToBeijingInput } from '@/utils/dateTime';
import { openAuthenticatedFile } from '@/utils/authenticatedFiles.mjs';
import { validateSelectedFiles } from '@/utils/fileLimits';

const { t, locale } = useI18n();
const { showSuccess, showError } = useToast();

const concertAttachmentAccept = '.pdf,.doc,.docx,.jpg,.jpeg,.png,.webp,.gif,.txt,.md,.csv,.xlsx,.xls,.ppt,.pptx';

function createEmptyConcertForm() {
  return {
    title: '',
    description: '',
    announcement: '',
    applicationDeadline: '',
    status: 'draft'
  };
}

const editorForm = reactive(createEmptyConcertForm());
const concerts = ref([]);
const selectedConcertId = ref(0);
const selectedAttachmentFile = ref(null);
const attachmentInputNonce = ref(0);
const removeAttachment = ref(false);
const releaseMessage = ref('');
const registrations = ref([]);
const selectedRegistrationId = ref(0);
const loadingRegistrations = ref(false);
const registrationsConcertId = ref(0);
const editorBaseline = ref(createEmptyConcertForm());
const concertsLoading = ref(false);
const savingConcert = ref(false);
const releasingConcert = ref(false);
const deletingConcert = ref(false);
const downloadingRegistrationsCsv = ref(false);

let concertsRequestToken = 0;
let registrationsRequestToken = 0;

const editableConcertStatuses = new Set(['draft', 'open', 'closed']);

const selectedConcert = computed(
  () => concerts.value.find((item) => item.id === selectedConcertId.value) || null
);
const selectedRegistration = computed(
  () => registrations.value.find((item) => item.id === selectedRegistrationId.value) || null
);
const formMode = computed(() => (selectedConcert.value ? 'edit' : 'create'));
const editorBusy = computed(
  () => concertsLoading.value || savingConcert.value || releasingConcert.value || deletingConcert.value
);
const hasDirtyConcertForm = computed(() => {
  const baseline = editorBaseline.value;
  return (
    editorForm.title.trim() !== baseline.title ||
    editorForm.description.trim() !== baseline.description ||
    editorForm.announcement.trim() !== baseline.announcement ||
    editorForm.applicationDeadline !== baseline.applicationDeadline ||
    editorForm.status !== baseline.status ||
    Boolean(selectedAttachmentFile.value) ||
    removeAttachment.value
  );
});

function formatDate(value) {
  return formatDateTimeInBeijing(value, locale.value);
}

async function openScoreFile() {
  try {
    await openAuthenticatedFile(api, selectedRegistration.value?.scoreFilePath);
  } catch (err) {
    setError(err);
  }
}

function setError(err, fallbackKey = 'admin.errorRequest') {
  const details = err?.response?.data?.details;
  const detailText = Array.isArray(details) && details.length > 0
    ? details[0]?.message
    : '';
  showError(detailText || err, t(fallbackKey));
}

function toStorageDateTime(value) {
  if (!value) {
    return '';
  }
  return `${value}:00`;
}

function toInputDateTime(value) {
  return utcIsoToBeijingInput(value);
}

function normalizeConcertForm(form) {
  form.title = String(form.title || '').trim();
  form.description = String(form.description || '').trim();
  form.announcement = String(form.announcement || '').trim();
}

function snapshotConcertFormFromItem(item) {
  return {
    title: String(item?.title || '').trim(),
    description: String(item?.description || '').trim(),
    announcement: String(item?.announcement || '').trim(),
    applicationDeadline: toInputDateTime(item?.applicationDeadline),
    status: editableConcertStatuses.has(item?.status) ? item.status : 'draft'
  };
}

function validateConcertForm(form) {
  normalizeConcertForm(form);
  if (form.title.length < 2) {
    showError(t('admin.publishTitleInvalid'));
    return false;
  }
  return true;
}

function buildConcertFormData(form, attachmentFile, removeCurrentAttachment = false) {
  const payload = new FormData();
  payload.append('title', form.title || '');
  payload.append('description', form.description || '');
  payload.append('announcement', form.announcement || '');
  payload.append('applicationDeadline', toStorageDateTime(form.applicationDeadline));
  payload.append('status', form.status);
  if (attachmentFile) {
    payload.append('attachmentFile', attachmentFile);
  }
  if (removeCurrentAttachment) {
    payload.append('removeAttachment', 'true');
  }
  return payload;
}

function normalizeConcertItem(item) {
  return {
    ...item,
    description: item?.description || '',
    announcement: item?.announcement || '',
    attachmentPath: item?.attachmentPath || null,
    status: editableConcertStatuses.has(item?.status) ? item.status : 'draft'
  };
}

function resetEditorState() {
  const empty = createEmptyConcertForm();
  Object.assign(editorForm, empty);
  editorBaseline.value = { ...empty };
  selectedAttachmentFile.value = null;
  removeAttachment.value = false;
  releaseMessage.value = '';
  attachmentInputNonce.value += 1;
}

function syncEditorStateFromConcert(concert, { preserveReleaseMessage = false } = {}) {
  if (!concert) {
    resetEditorState();
    return;
  }

  const snapshot = snapshotConcertFormFromItem(concert);
  Object.assign(editorForm, snapshot);
  editorBaseline.value = { ...snapshot };
  selectedAttachmentFile.value = null;
  removeAttachment.value = false;
  if (!preserveReleaseMessage) {
    releaseMessage.value = '';
  }
  attachmentInputNonce.value += 1;
}

function clearRegistrationState({ cancelRequests = true } = {}) {
  if (cancelRequests) {
    registrationsRequestToken += 1;
  }
  loadingRegistrations.value = false;
  registrationsConcertId.value = 0;
  registrations.value = [];
  selectedRegistrationId.value = 0;
}

function beginCreateMode({ skipConfirm = false } = {}) {
  if (!skipConfirm && hasDirtyConcertForm.value && !window.confirm(t('admin.confirmDiscardConcertChanges'))) {
    return false;
  }
  selectedConcertId.value = 0;
  resetEditorState();
  clearRegistrationState();
  return true;
}

async function refreshConcerts() {
  const requestId = ++concertsRequestToken;
  concertsLoading.value = true;
  try {
    const { data } = await api.get('/admin/concerts');
    if (requestId !== concertsRequestToken) {
      return;
    }

    const items = (data.items || []).map(normalizeConcertItem);
    concerts.value = items;

    if (selectedConcertId.value && !items.some((item) => item.id === selectedConcertId.value)) {
      beginCreateMode({ skipConfirm: true });
      return;
    }

    if (selectedConcert.value && !hasDirtyConcertForm.value) {
      syncEditorStateFromConcert(selectedConcert.value, { preserveReleaseMessage: true });
    }
  } catch (err) {
    setError(err, 'admin.concertsLoadFailed');
  } finally {
    if (requestId === concertsRequestToken) {
      concertsLoading.value = false;
    }
  }
}

function upsertConcert(item) {
  const normalized = normalizeConcertItem(item);
  const index = concerts.value.findIndex((entry) => entry.id === normalized.id);
  if (index === -1) {
    concerts.value = [normalized, ...concerts.value];
    return;
  }
  const nextItems = [...concerts.value];
  nextItems[index] = {
    ...nextItems[index],
    ...normalized
  };
  concerts.value = nextItems;
}

function selectConcert(concertId) {
  if (editorBusy.value || selectedConcertId.value === concertId) {
    return;
  }
  if (hasDirtyConcertForm.value && !window.confirm(t('admin.confirmDiscardConcertChanges'))) {
    return;
  }
  selectedConcertId.value = concertId;
  syncEditorStateFromConcert(selectedConcert.value);
  clearRegistrationState();
  loadRegistrations({ force: true });
}

function selectRegistration(registrationId) {
  selectedRegistrationId.value = registrationId;
}

function handleAttachmentFileChange(file) {
  const error = validateSelectedFiles(file ? [file] : []);
  if (error) {
    showError(error);
    selectedAttachmentFile.value = null;
    attachmentInputNonce.value += 1;
    return;
  }
  selectedAttachmentFile.value = file;
  if (file) {
    removeAttachment.value = false;
  }
}

function updateEditorForm(nextForm) {
  Object.assign(editorForm, nextForm);
}

async function loadRegistrations({ force = false, preserveExisting = false } = {}) {
  const concertId = selectedConcertId.value;
  if (!concertId) {
    clearRegistrationState();
    return;
  }
  if (!force && registrationsConcertId.value === concertId) {
    return;
  }

  const requestId = ++registrationsRequestToken;
  if (!preserveExisting || registrationsConcertId.value !== concertId) {
    registrations.value = [];
    selectedRegistrationId.value = 0;
  }
  loadingRegistrations.value = true;

  try {
    const { data } = await api.get(`/admin/concerts/${concertId}/applications`);
    if (requestId !== registrationsRequestToken || concertId !== selectedConcertId.value) {
      return;
    }

    registrations.value = data.items || [];
    registrationsConcertId.value = concertId;
    if (!registrations.value.length) {
      selectedRegistrationId.value = 0;
      return;
    }
    if (!registrations.value.some((item) => item.id === selectedRegistrationId.value)) {
      selectedRegistrationId.value = registrations.value[0].id;
    }
  } catch (err) {
    if (requestId !== registrationsRequestToken) {
      return;
    }
    registrations.value = [];
    selectedRegistrationId.value = 0;
    registrationsConcertId.value = 0;
    setError(err, 'admin.registrationLoadFailed');
  } finally {
    if (requestId === registrationsRequestToken) {
      loadingRegistrations.value = false;
    }
  }
}

async function submitConcertForm() {
  if (!validateConcertForm(editorForm)) {
    return;
  }

  if (!selectedConcert.value) {
    if (!window.confirm(t('admin.confirmCreateConcert'))) {
      return;
    }
    savingConcert.value = true;
    try {
      const payload = buildConcertFormData(editorForm, selectedAttachmentFile.value, false);
      const { data } = await api.post('/admin/concerts', payload);
      upsertConcert(data);
      showSuccess(t('admin.concertCreated', { id: data.id }));
      beginCreateMode({ skipConfirm: true });
    } catch (err) {
      setError(err);
    } finally {
      savingConcert.value = false;
    }
    return;
  }

  if (!window.confirm(t('admin.confirmUpdateConcert'))) {
    return;
  }
  savingConcert.value = true;
  try {
    const payload = buildConcertFormData(editorForm, selectedAttachmentFile.value, removeAttachment.value);
    const { data } = await api.patch(`/admin/concerts/${selectedConcert.value.id}`, payload);
    upsertConcert(data);
    syncEditorStateFromConcert(normalizeConcertItem(data), { preserveReleaseMessage: true });
    showSuccess(t('admin.concertUpdated'));
  } catch (err) {
    setError(err);
  } finally {
    savingConcert.value = false;
  }
}

async function releaseConcert() {
  if (!selectedConcert.value || editorBusy.value) {
    return;
  }
  if (hasDirtyConcertForm.value) {
    showError(t('admin.concertUnsavedBeforeRelease'));
    return;
  }
  if (!window.confirm(t('admin.confirmReleaseConcert'))) {
    return;
  }
  releasingConcert.value = true;
  try {
    const { data } = await api.post(`/admin/concerts/${selectedConcert.value.id}/release`, {
      message: releaseMessage.value || undefined
    });
    upsertConcert({ ...selectedConcert.value, status: 'open' });
    syncEditorStateFromConcert({ ...selectedConcert.value, status: 'open' }, { preserveReleaseMessage: true });
    showSuccess(t('admin.concertReleased', { count: data.notification?.sent || 0 }));
  } catch (err) {
    setError(err);
  } finally {
    releasingConcert.value = false;
  }
}

async function deleteConcert() {
  if (!selectedConcert.value || editorBusy.value) {
    return;
  }
  if (!window.confirm(t('admin.confirmDeleteConcert'))) {
    return;
  }
  deletingConcert.value = true;
  try {
    const concertId = selectedConcert.value.id;
    await api.delete(`/admin/concerts/${concertId}`);
    concerts.value = concerts.value.filter((item) => item.id !== concertId);
    showSuccess(t('admin.concertDeleted'));
    beginCreateMode({ skipConfirm: true });
  } catch (err) {
    setError(err);
  } finally {
    deletingConcert.value = false;
  }
}

async function downloadRegistrationsCsv() {
  if (!selectedConcertId.value || downloadingRegistrationsCsv.value) {
    return;
  }
  downloadingRegistrationsCsv.value = true;
  try {
    const response = await api.get(`/admin/concerts/${selectedConcertId.value}/applications/export`, {
      responseType: 'blob'
    });
    const fileNameMatch = String(response.headers['content-disposition'] || '').match(/filename="?([^"]+)"?/i);
    const fileName = fileNameMatch?.[1] || `linquan_concert_applications_${selectedConcertId.value}.csv`;
    const blobUrl = window.URL.createObjectURL(response.data);
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(blobUrl);
    showSuccess(t('admin.registrationCsvExported'));
  } catch (err) {
    setError(err, 'admin.registrationCsvExportFailed');
  } finally {
    downloadingRegistrationsCsv.value = false;
  }
}

onMounted(async () => {
  await refreshConcerts();
});
</script>

<style scoped>
.panel {
  padding: 1rem;
}

.link-button {
  appearance: none;
  border: 0;
  padding: 0;
  color: var(--accent);
  background: transparent;
  text-decoration: underline;
  cursor: pointer;
  font: inherit;
}

.section-space {
  margin-top: 1rem;
}

.section-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.8rem;
  margin-bottom: 0.8rem;
}

.concert-list,
.registration-list {
  list-style: none;
  margin: 0.7rem 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  max-height: 26rem;
  overflow: auto;
}

.concert-list li,
.registration-item {
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--panel-soft);
  padding: 0.65rem 0.75rem;
  cursor: pointer;
  color: var(--ink);
  text-align: left;
}

.concert-list li:hover,
.registration-item:hover {
  background: #242a31;
}

.concert-list li.active,
.registration-item.active {
  border-color: var(--accent);
  background: #262d35;
}

.concert-item-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.concert-list h3,
.registration-item h3 {
  margin: 0;
}

.concert-list p,
.registration-item p {
  margin: 0.35rem 0 0;
}

.multiline-text {
  white-space: pre-wrap;
  word-break: break-word;
}

.status-pill {
  display: inline-flex;
  align-items: center;
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.04);
  color: var(--muted);
  font-size: 0.82rem;
  flex-shrink: 0;
}

.detail-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.7rem;
}

.label {
  display: block;
  font-size: 0.85rem;
  color: var(--muted);
  margin-bottom: 0.15rem;
}

.action-row {
  justify-content: flex-end;
  flex-wrap: wrap;
}

.inline-loading {
  margin-top: 0.35rem;
}

@media (max-width: 860px) {
  .detail-grid {
    grid-template-columns: 1fr;
  }

  .section-head,
  .concert-item-head {
    flex-direction: column;
    align-items: flex-start;
  }

  .action-row {
    justify-content: flex-start;
  }
}
</style>

<template>
  <section class="grid-2">
    <article class="card panel">
      <h2 class="section-title">{{ t('admin.publishActivity') }}</h2>
      <form class="form" @submit.prevent="postActivity">
        <div class="field"><label>{{ t('admin.title') }}</label><input v-model.trim="activity.title" required /></div>
        <div class="field"><label>{{ t('admin.content') }}</label><textarea v-model="activity.content" required rows="5" /></div>
        <div class="row">
          <div class="field field-half">
            <label>{{ t('admin.eventTime') }}</label>
            <input type="datetime-local" v-model="activity.eventTime" />
            <p class="subtle">{{ t('admin.dateTimeGuide') }}</p>
          </div>
          <div class="field field-half">
            <label>{{ t('admin.location') }}</label>
            <input v-model.trim="activity.location" :placeholder="t('admin.locationPlaceholder')" />
          </div>
        </div>
        <div class="field">
          <label>{{ t('admin.attachmentFiles') }}</label>
          <input type="file" :accept="publishingAccept" multiple @change="onCreateActivityFilesChange" />
          <p class="subtle">{{ t('admin.attachmentUploadHint') }}</p>
          <ul v-if="activityFiles.length" class="pending-file-list">
            <li v-for="file in activityFiles" :key="fileKey(file)" class="pending-file-item">
              <span class="attachment-kind">{{ attachmentTypeLabel(file) }}</span>
              <span class="file-name">{{ file.name }}</span>
              <span class="subtle">{{ formatBytes(file.size) }}</span>
              <button class="text-action" type="button" @click="removePendingFile(activityFiles, file)">{{ t('admin.removePendingFile') }}</button>
            </li>
          </ul>
        </div>
        <label class="toggle"><input type="checkbox" v-model="activity.isPublished" />{{ activity.isPublished ? t('admin.statePublished') : t('admin.stateUnpublished') }}</label>
        <button class="btn" :disabled="submitting.createActivity">{{ activity.isPublished ? t('admin.publishActivityButton') : t('admin.saveDraftButton') }}</button>
      </form>
    </article>

    <article class="card panel">
      <h2 class="section-title">{{ t('admin.publishAnnouncement') }}</h2>
      <form class="form" @submit.prevent="postAnnouncement">
        <div class="field"><label>{{ t('admin.title') }}</label><input v-model.trim="announcement.title" required /></div>
        <div class="field"><label>{{ t('admin.content') }}</label><textarea v-model="announcement.content" required rows="5" /></div>
        <div class="field">
          <label>{{ t('admin.attachmentFiles') }}</label>
          <input type="file" :accept="publishingAccept" multiple @change="onCreateAnnouncementFilesChange" />
          <p class="subtle">{{ t('admin.attachmentUploadHint') }}</p>
          <ul v-if="announcementFiles.length" class="pending-file-list">
            <li v-for="file in announcementFiles" :key="fileKey(file)" class="pending-file-item">
              <span class="attachment-kind">{{ attachmentTypeLabel(file) }}</span>
              <span class="file-name">{{ file.name }}</span>
              <span class="subtle">{{ formatBytes(file.size) }}</span>
              <button class="text-action" type="button" @click="removePendingFile(announcementFiles, file)">{{ t('admin.removePendingFile') }}</button>
            </li>
          </ul>
        </div>
        <label class="toggle"><input type="checkbox" v-model="announcement.isPublished" />{{ announcement.isPublished ? t('admin.statePublished') : t('admin.stateUnpublished') }}</label>
        <button class="btn" :disabled="submitting.createAnnouncement">{{ announcement.isPublished ? t('admin.publishAnnouncementButton') : t('admin.saveDraftButton') }}</button>
      </form>
    </article>
  </section>

  <section class="grid-2 section-space">
    <article class="card panel">
      <h2 class="section-title">{{ t('admin.manageActivities') }}</h2>
      <ul class="item-list">
        <li v-for="item in activities" :key="item.id" :class="{ active: item.id === selectedActivityId }" @click="selectActivity(item)">
          <h3>{{ item.title }}</h3>
          <p class="subtle">
            {{ item.isPublished ? t('admin.statePublished') : t('admin.stateUnpublished') }}
            <span v-if="activityMetaTime(item)"> · {{ activityMetaTime(item) }}</span>
          </p>
          <p class="subtle" v-if="item.eventTime">{{ formatBeijingDateTime(item.eventTime) }}</p>
          <p class="subtle" v-if="item.attachments?.length">{{ t('admin.attachmentCount', { count: item.attachments.length }) }}</p>
        </li>
      </ul>
      <p v-if="activities.length === 0" class="subtle">{{ t('admin.noActivitiesAdmin') }}</p>

      <form v-if="selectedActivityId" class="form edit-form" @submit.prevent="saveActivity">
        <h3>{{ t('admin.editActivity') }}</h3>
        <div class="field"><label>{{ t('admin.title') }}</label><input v-model.trim="editActivity.title" required /></div>
        <div class="field"><label>{{ t('admin.content') }}</label><textarea v-model="editActivity.content" required rows="5" /></div>
        <div class="row">
          <div class="field field-half"><label>{{ t('admin.eventTime') }}</label><input type="datetime-local" v-model="editActivity.eventTime" /></div>
          <div class="field field-half"><label>{{ t('admin.location') }}</label><input v-model.trim="editActivity.location" :placeholder="t('admin.locationPlaceholder')" /></div>
        </div>
        <div class="field">
          <label>{{ t('admin.currentAttachments') }}</label>
          <ul v-if="editActivity.attachments.length" class="attachment-list compact">
            <li v-for="item in editActivity.attachments" :key="item.id" class="attachment-item">
              <div class="attachment-summary">
                <span class="attachment-kind">{{ attachmentTypeLabel(item) }}</span>
                <div class="attachment-text">
                  <a :href="item.viewUrl || item.url" target="_blank" rel="noopener">{{ item.originalName }}</a>
                  <span class="subtle">{{ formatBytes(item.fileSize) }}</span>
                </div>
              </div>
              <div class="attachment-actions">
                <a class="text-action" :href="item.viewUrl || item.url" target="_blank" rel="noopener">{{ t('common.open') }}</a>
                <a class="text-action" :href="item.downloadUrl || item.url" :download="item.originalName" rel="noopener">{{ t('common.download') }}</a>
                <label class="text-action" :class="{ disabled: isAttachmentBusy(`activity:replace:${item.id}`) }">
                  {{ t('admin.replaceAttachment') }}
                  <input class="hidden-input" type="file" :accept="publishingAccept" :disabled="isAttachmentBusy(`activity:replace:${item.id}`)" @change="onReplaceActivityAttachment(item, $event)" />
                </label>
                <button class="text-action danger" type="button" :disabled="isAttachmentBusy(`activity:delete:${item.id}`)" @click="deleteActivityAttachment(item)">{{ t('admin.deleteAttachment') }}</button>
              </div>
            </li>
          </ul>
          <p v-else class="subtle">{{ t('admin.noAttachments') }}</p>
        </div>
        <div class="field">
          <label>{{ t('admin.attachmentFiles') }}</label>
          <input type="file" :accept="publishingAccept" multiple @change="onEditActivityFilesChange" />
          <p class="subtle">{{ t('admin.pendingAttachmentHint') }}</p>
          <ul v-if="editActivityFiles.length" class="pending-file-list">
            <li v-for="file in editActivityFiles" :key="fileKey(file)" class="pending-file-item">
              <span class="attachment-kind">{{ attachmentTypeLabel(file) }}</span>
              <span class="file-name">{{ file.name }}</span>
              <span class="subtle">{{ formatBytes(file.size) }}</span>
              <button class="text-action" type="button" @click="removePendingFile(editActivityFiles, file)">{{ t('admin.removePendingFile') }}</button>
            </li>
          </ul>
        </div>
        <label class="toggle"><input type="checkbox" v-model="editActivity.isPublished" />{{ editActivity.isPublished ? t('admin.statePublished') : t('admin.stateUnpublished') }}</label>
        <div class="row">
          <button class="btn" type="submit" :disabled="submitting.saveActivity">{{ t('admin.saveActivity') }}</button>
          <button class="btn warn" type="button" :disabled="submitting.saveActivity" @click="deleteActivity">{{ t('admin.deleteActivity') }}</button>
        </div>
      </form>
    </article>

    <article class="card panel">
      <h2 class="section-title">{{ t('admin.manageAnnouncements') }}</h2>
      <ul class="item-list">
        <li v-for="item in announcements" :key="item.id" :class="{ active: item.id === selectedAnnouncementId }" @click="selectAnnouncement(item)">
          <h3>{{ item.title }}</h3>
          <p class="subtle">
            {{ item.isPublished ? t('admin.statePublished') : t('admin.stateUnpublished') }}
            <span v-if="announcementMetaTime(item)"> · {{ announcementMetaTime(item) }}</span>
          </p>
          <p class="subtle" v-if="item.attachments?.length">{{ t('admin.attachmentCount', { count: item.attachments.length }) }}</p>
        </li>
      </ul>
      <p v-if="announcements.length === 0" class="subtle">{{ t('admin.noAnnouncementsAdmin') }}</p>

      <form v-if="selectedAnnouncementId" class="form edit-form" @submit.prevent="saveAnnouncement">
        <h3>{{ t('admin.editAnnouncement') }}</h3>
        <div class="field"><label>{{ t('admin.title') }}</label><input v-model.trim="editAnnouncement.title" required /></div>
        <div class="field"><label>{{ t('admin.content') }}</label><textarea v-model="editAnnouncement.content" required rows="5" /></div>
        <div class="field">
          <label>{{ t('admin.currentAttachments') }}</label>
          <ul v-if="editAnnouncement.attachments.length" class="attachment-list compact">
            <li v-for="item in editAnnouncement.attachments" :key="item.id" class="attachment-item">
              <div class="attachment-summary">
                <span class="attachment-kind">{{ attachmentTypeLabel(item) }}</span>
                <div class="attachment-text">
                  <a :href="item.viewUrl || item.url" target="_blank" rel="noopener">{{ item.originalName }}</a>
                  <span class="subtle">{{ formatBytes(item.fileSize) }}</span>
                </div>
              </div>
              <div class="attachment-actions">
                <a class="text-action" :href="item.viewUrl || item.url" target="_blank" rel="noopener">{{ t('common.open') }}</a>
                <a class="text-action" :href="item.downloadUrl || item.url" :download="item.originalName" rel="noopener">{{ t('common.download') }}</a>
                <label class="text-action" :class="{ disabled: isAttachmentBusy(`announcement:replace:${item.id}`) }">
                  {{ t('admin.replaceAttachment') }}
                  <input class="hidden-input" type="file" :accept="publishingAccept" :disabled="isAttachmentBusy(`announcement:replace:${item.id}`)" @change="onReplaceAnnouncementAttachment(item, $event)" />
                </label>
                <button class="text-action danger" type="button" :disabled="isAttachmentBusy(`announcement:delete:${item.id}`)" @click="deleteAnnouncementAttachment(item)">{{ t('admin.deleteAttachment') }}</button>
              </div>
            </li>
          </ul>
          <p v-else class="subtle">{{ t('admin.noAttachments') }}</p>
        </div>
        <div class="field">
          <label>{{ t('admin.attachmentFiles') }}</label>
          <input type="file" :accept="publishingAccept" multiple @change="onEditAnnouncementFilesChange" />
          <p class="subtle">{{ t('admin.pendingAttachmentHint') }}</p>
          <ul v-if="editAnnouncementFiles.length" class="pending-file-list">
            <li v-for="file in editAnnouncementFiles" :key="fileKey(file)" class="pending-file-item">
              <span class="attachment-kind">{{ attachmentTypeLabel(file) }}</span>
              <span class="file-name">{{ file.name }}</span>
              <span class="subtle">{{ formatBytes(file.size) }}</span>
              <button class="text-action" type="button" @click="removePendingFile(editAnnouncementFiles, file)">{{ t('admin.removePendingFile') }}</button>
            </li>
          </ul>
        </div>
        <label class="toggle"><input type="checkbox" v-model="editAnnouncement.isPublished" />{{ editAnnouncement.isPublished ? t('admin.statePublished') : t('admin.stateUnpublished') }}</label>
        <div class="row">
          <button class="btn" type="submit" :disabled="submitting.saveAnnouncement">{{ t('admin.saveAnnouncement') }}</button>
          <button class="btn warn" type="button" :disabled="submitting.saveAnnouncement" @click="deleteAnnouncement">{{ t('admin.deleteAnnouncement') }}</button>
        </div>
      </form>
    </article>
  </section>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
import api from '@/services/api';
import { useI18n } from '@/i18n';
import { useToast } from '@/composables/toast';
import { beijingInputToUtcIso, formatDateTimeInBeijing, toUtcMillis, utcIsoToBeijingInput } from '@/utils/dateTime';
import { validateSelectedFiles } from '@/utils/fileLimits';

const { t, locale } = useI18n();
const { showSuccess, showError } = useToast();
const publishingAccept = '.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.md,.jpg,.jpeg,.png,.webp,.gif,.zip,.ppt,.pptx';

const activity = reactive({ title: '', content: '', eventTime: '', location: '', isPublished: true });
const announcement = reactive({ title: '', content: '', isPublished: true });
const activities = ref([]);
const announcements = ref([]);
const selectedActivityId = ref(0);
const selectedAnnouncementId = ref(0);
const activityFiles = ref([]);
const announcementFiles = ref([]);
const editActivityFiles = ref([]);
const editAnnouncementFiles = ref([]);
const attachmentBusyKey = ref('');
const submitting = reactive({ createActivity: false, createAnnouncement: false, saveActivity: false, saveAnnouncement: false });
const editActivity = reactive({ title: '', content: '', eventTime: '', location: '', isPublished: true, attachments: [] });
const editAnnouncement = reactive({ title: '', content: '', isPublished: true, attachments: [] });

function formatBeijingDateTime(value) { return formatDateTimeInBeijing(value, locale.value); }
function parseTimeWeight(value) { return toUtcMillis(value); }
function sortActivityItems(items) {
  return [...items].sort((left, right) => {
    const diff = parseTimeWeight(right.eventTime || right.publishedAt || right.createdAt) - parseTimeWeight(left.eventTime || left.publishedAt || left.createdAt);
    return diff !== 0 ? diff : Number(right.id || 0) - Number(left.id || 0);
  });
}
function sortAnnouncementItems(items) {
  return [...items].sort((left, right) => {
    const diff = parseTimeWeight(right.publishedAt || right.createdAt) - parseTimeWeight(left.publishedAt || left.createdAt);
    return diff !== 0 ? diff : Number(right.id || 0) - Number(left.id || 0);
  });
}
function activityMetaTime(item) { return formatBeijingDateTime(item?.publishedAt || item?.createdAt); }
function announcementMetaTime(item) { return formatBeijingDateTime(item?.publishedAt || item?.createdAt); }
function normalizeContentItem(item) { return { ...item, attachments: item?.attachments || [], isPublished: Boolean(item?.isPublished) }; }
function upsertActivityItem(item) {
  const normalized = normalizeContentItem(item);
  activities.value = sortActivityItems([normalized, ...activities.value.filter((entry) => entry.id !== normalized.id)]);
}
function upsertAnnouncementItem(item) {
  const normalized = normalizeContentItem(item);
  announcements.value = sortAnnouncementItems([normalized, ...announcements.value.filter((entry) => entry.id !== normalized.id)]);
}
function removeActivityItem(activityId) { activities.value = activities.value.filter((item) => item.id !== activityId); }
function removeAnnouncementItem(announcementId) { announcements.value = announcements.value.filter((item) => item.id !== announcementId); }
function fileKey(file) { return `${file.name}-${file.size}-${file.lastModified || 0}`; }
function mergeSelectedFiles(targetRef, fileList) {
  const incoming = Array.from(fileList || []);
  const seen = new Set(targetRef.value.map(fileKey));
  const nextFiles = [...targetRef.value];
  for (const file of incoming) {
    const key = fileKey(file);
    if (!seen.has(key)) { seen.add(key); nextFiles.push(file); }
  }
  const error = validateSelectedFiles(nextFiles);
  if (error) {
    showError(error);
    return;
  }
  targetRef.value = nextFiles;
}
function removePendingFile(targetRef, file) { const key = fileKey(file); targetRef.value = targetRef.value.filter((item) => fileKey(item) !== key); }
function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
function attachmentTypeLabel(attachment) {
  const name = String(attachment?.originalName || attachment?.name || '');
  const extension = name.includes('.') ? name.split('.').pop() : '';
  if (extension) return extension.toUpperCase();
  const mimeType = String(attachment?.mimeType || attachment?.type || '');
  if (mimeType.startsWith('image/')) return 'IMG';
  if (mimeType === 'application/pdf') return 'PDF';
  return 'FILE';
}
function normalizePublishForm(form, { includeEventFields = false } = {}) {
  form.title = String(form.title || '').trim();
  form.content = String(form.content || '').trim();
  if (includeEventFields) form.location = String(form.location || '').trim();
}
function validatePublishForm(form, { includeEventFields = false } = {}) {
  normalizePublishForm(form, { includeEventFields });
  if (form.title.length < 2) { showError(t('admin.publishTitleInvalid')); return false; }
  if (form.content.length < 2) { showError(t('admin.publishContentInvalid')); return false; }
  return true;
}
function buildContentFormData(form, files, { includeEventFields = false } = {}) {
  const formData = new FormData();
  formData.append('title', form.title || '');
  formData.append('content', form.content || '');
  formData.append('isPublished', String(Boolean(form.isPublished)));
  if (includeEventFields) {
    formData.append('eventTime', form.eventTime ? beijingInputToUtcIso(form.eventTime) : '');
    formData.append('location', form.location || '');
  }
  for (const file of files || []) formData.append('attachmentFiles', file);
  return formData;
}
function resetActivityCreateForm() { activity.title = ''; activity.content = ''; activity.eventTime = ''; activity.location = ''; activity.isPublished = true; activityFiles.value = []; }
function resetAnnouncementCreateForm() { announcement.title = ''; announcement.content = ''; announcement.isPublished = true; announcementFiles.value = []; }
function applyActivity(item) {
  selectedActivityId.value = item?.id || 0;
  editActivity.title = item?.title || '';
  editActivity.content = item?.content || '';
  editActivity.eventTime = utcIsoToBeijingInput(item?.eventTime);
  editActivity.location = item?.location || '';
  editActivity.isPublished = Boolean(item?.isPublished);
  editActivity.attachments = item?.attachments || [];
  editActivityFiles.value = [];
}
function applyAnnouncement(item) {
  selectedAnnouncementId.value = item?.id || 0;
  editAnnouncement.title = item?.title || '';
  editAnnouncement.content = item?.content || '';
  editAnnouncement.isPublished = Boolean(item?.isPublished);
  editAnnouncement.attachments = item?.attachments || [];
  editAnnouncementFiles.value = [];
}
function refreshSelectedActivityAttachments(item) { if (selectedActivityId.value === item?.id) editActivity.attachments = item?.attachments || []; }
function refreshSelectedAnnouncementAttachments(item) { if (selectedAnnouncementId.value === item?.id) editAnnouncement.attachments = item?.attachments || []; }
function selectActivity(item) { applyActivity(item); }
function selectAnnouncement(item) { applyAnnouncement(item); }
function onCreateActivityFilesChange(event) { mergeSelectedFiles(activityFiles, event.target.files); event.target.value = ''; }
function onCreateAnnouncementFilesChange(event) { mergeSelectedFiles(announcementFiles, event.target.files); event.target.value = ''; }
function onEditActivityFilesChange(event) { mergeSelectedFiles(editActivityFiles, event.target.files); event.target.value = ''; }
function onEditAnnouncementFilesChange(event) { mergeSelectedFiles(editAnnouncementFiles, event.target.files); event.target.value = ''; }
function isAttachmentBusy(key) { return attachmentBusyKey.value === key; }
function setError(err) {
  const details = err?.response?.data?.details;
  const detailText = Array.isArray(details) && details.length > 0 ? details[0]?.message : '';
  showError(detailText || err, t('admin.errorRequest'));
}

async function loadActivities() {
  const { data } = await api.get('/admin/activities');
  activities.value = sortActivityItems((data.items || []).map(normalizeContentItem));
  const current = activities.value.find((item) => item.id === selectedActivityId.value) || null;
  if (selectedActivityId.value && current) applyActivity(current);
  else if (!activities.value.some((item) => item.id === selectedActivityId.value)) applyActivity(null);
}

async function loadAnnouncements() {
  const { data } = await api.get('/admin/announcements');
  announcements.value = sortAnnouncementItems((data.items || []).map(normalizeContentItem));
  const current = announcements.value.find((item) => item.id === selectedAnnouncementId.value) || null;
  if (selectedAnnouncementId.value && current) applyAnnouncement(current);
  else if (!announcements.value.some((item) => item.id === selectedAnnouncementId.value)) applyAnnouncement(null);
}

async function postActivity() {
  if (submitting.createActivity || !validatePublishForm(activity, { includeEventFields: true })) return;
  if (!window.confirm(activity.isPublished ? t('admin.confirmPublishActivity') : t('admin.confirmSaveActivityDraft'))) return;
  submitting.createActivity = true;
  try {
    const payload = buildContentFormData(activity, activityFiles.value, { includeEventFields: true });
    const { data } = await api.post('/admin/activities', payload);
    upsertActivityItem(data);
    showSuccess(t(activity.isPublished ? 'admin.activityPublished' : 'admin.activityDraftSaved'));
    resetActivityCreateForm();
  } catch (err) {
    setError(err);
  } finally {
    submitting.createActivity = false;
  }
}

async function postAnnouncement() {
  if (submitting.createAnnouncement || !validatePublishForm(announcement)) return;
  if (!window.confirm(announcement.isPublished ? t('admin.confirmPublishAnnouncement') : t('admin.confirmSaveAnnouncementDraft'))) return;
  submitting.createAnnouncement = true;
  try {
    const payload = buildContentFormData(announcement, announcementFiles.value);
    const { data } = await api.post('/admin/announcements', payload);
    upsertAnnouncementItem(data);
    showSuccess(t(announcement.isPublished ? 'admin.announcementPublished' : 'admin.announcementDraftSaved'));
    resetAnnouncementCreateForm();
  } catch (err) {
    setError(err);
  } finally {
    submitting.createAnnouncement = false;
  }
}

async function saveActivity() {
  if (!selectedActivityId.value || submitting.saveActivity || !validatePublishForm(editActivity, { includeEventFields: true })) return;
  if (!window.confirm(t('admin.confirmSaveActivity'))) return;
  submitting.saveActivity = true;
  try {
    const payload = buildContentFormData(editActivity, editActivityFiles.value, { includeEventFields: true });
    const { data } = await api.patch(`/admin/activities/${selectedActivityId.value}`, payload);
    upsertActivityItem(data);
    applyActivity(data);
    showSuccess(t('admin.activityUpdated'));
  } catch (err) {
    setError(err);
  } finally {
    submitting.saveActivity = false;
  }
}

async function deleteActivity() {
  if (!selectedActivityId.value) return;
  if (!window.confirm(t('admin.confirmDeleteActivity'))) return;
  submitting.saveActivity = true;
  try {
    const activityId = selectedActivityId.value;
    await api.delete(`/admin/activities/${activityId}`);
    removeActivityItem(activityId);
    applyActivity(null);
    showSuccess(t('admin.activityDeleted'));
  } catch (err) {
    setError(err);
  } finally {
    submitting.saveActivity = false;
  }
}

async function saveAnnouncement() {
  if (!selectedAnnouncementId.value || submitting.saveAnnouncement || !validatePublishForm(editAnnouncement)) return;
  if (!window.confirm(t('admin.confirmSaveAnnouncement'))) return;
  submitting.saveAnnouncement = true;
  try {
    const payload = buildContentFormData(editAnnouncement, editAnnouncementFiles.value);
    const { data } = await api.patch(`/admin/announcements/${selectedAnnouncementId.value}`, payload);
    upsertAnnouncementItem(data);
    applyAnnouncement(data);
    showSuccess(t('admin.announcementUpdated'));
  } catch (err) {
    setError(err);
  } finally {
    submitting.saveAnnouncement = false;
  }
}

async function deleteAnnouncement() {
  if (!selectedAnnouncementId.value) return;
  if (!window.confirm(t('admin.confirmDeleteAnnouncement'))) return;
  submitting.saveAnnouncement = true;
  try {
    const announcementId = selectedAnnouncementId.value;
    await api.delete(`/admin/announcements/${announcementId}`);
    removeAnnouncementItem(announcementId);
    applyAnnouncement(null);
    showSuccess(t('admin.announcementDeleted'));
  } catch (err) {
    setError(err);
  } finally {
    submitting.saveAnnouncement = false;
  }
}

async function onReplaceActivityAttachment(item, event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file || !selectedActivityId.value) return;
  const sizeError = validateSelectedFiles([file]);
  if (sizeError) { showError(sizeError); return; }
  const busyKey = `activity:replace:${item.id}`;
  attachmentBusyKey.value = busyKey;
  try {
    const payload = new FormData();
    payload.append('attachmentFile', file);
    const { data } = await api.post(`/admin/activities/${selectedActivityId.value}/attachments/${item.id}/replace`, payload);
    upsertActivityItem(data.item);
    refreshSelectedActivityAttachments(data.item);
    showSuccess(t('admin.attachmentReplaced'));
  } catch (err) {
    setError(err);
  } finally {
    attachmentBusyKey.value = '';
  }
}

async function deleteActivityAttachment(item) {
  if (!selectedActivityId.value) return;
  if (!window.confirm(t('admin.confirmDeleteAttachment'))) return;
  const busyKey = `activity:delete:${item.id}`;
  attachmentBusyKey.value = busyKey;
  try {
    const { data } = await api.delete(`/admin/activities/${selectedActivityId.value}/attachments/${item.id}`);
    upsertActivityItem(data.item);
    refreshSelectedActivityAttachments(data.item);
    showSuccess(t('admin.attachmentDeleted'));
  } catch (err) {
    setError(err);
  } finally {
    attachmentBusyKey.value = '';
  }
}

async function onReplaceAnnouncementAttachment(item, event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file || !selectedAnnouncementId.value) return;
  const sizeError = validateSelectedFiles([file]);
  if (sizeError) { showError(sizeError); return; }
  const busyKey = `announcement:replace:${item.id}`;
  attachmentBusyKey.value = busyKey;
  try {
    const payload = new FormData();
    payload.append('attachmentFile', file);
    const { data } = await api.post(`/admin/announcements/${selectedAnnouncementId.value}/attachments/${item.id}/replace`, payload);
    upsertAnnouncementItem(data.item);
    refreshSelectedAnnouncementAttachments(data.item);
    showSuccess(t('admin.attachmentReplaced'));
  } catch (err) {
    setError(err);
  } finally {
    attachmentBusyKey.value = '';
  }
}

async function deleteAnnouncementAttachment(item) {
  if (!selectedAnnouncementId.value) return;
  if (!window.confirm(t('admin.confirmDeleteAttachment'))) return;
  const busyKey = `announcement:delete:${item.id}`;
  attachmentBusyKey.value = busyKey;
  try {
    const { data } = await api.delete(`/admin/announcements/${selectedAnnouncementId.value}/attachments/${item.id}`);
    upsertAnnouncementItem(data.item);
    refreshSelectedAnnouncementAttachments(data.item);
    showSuccess(t('admin.attachmentDeleted'));
  } catch (err) {
    setError(err);
  } finally {
    attachmentBusyKey.value = '';
  }
}

onMounted(async () => {
  try {
    await Promise.all([loadActivities(), loadAnnouncements()]);
  } catch (err) {
    setError(err);
  }
});
</script>

<style scoped>
.panel { padding: 1rem; }
.section-space { margin-top: 1rem; }
.form { display: flex; flex-direction: column; gap: 0.7rem; }
.field-half { flex: 1; }
.item-list { list-style: none; margin: 0.6rem 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.55rem; max-height: 220px; overflow: auto; }
.item-list li { border: 1px solid var(--line); border-radius: 10px; background: var(--panel-soft); padding: 0.65rem 0.75rem; cursor: pointer; }
.item-list li.active { border-color: var(--accent); background: #20242a; }
.item-list h3, .edit-form h3 { margin: 0; }
.item-list p { margin: 0.35rem 0 0; }
.edit-form { margin-top: 0.95rem; border-top: 1px solid var(--line); padding-top: 0.85rem; }
.toggle { display: inline-flex; align-items: center; gap: 0.45rem; font-size: 0.92rem; color: var(--muted); }
.pending-file-list, .attachment-list { list-style: none; margin: 0.45rem 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem; }
.pending-file-item, .attachment-item { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: center; gap: 0.55rem; padding: 0.45rem 0.6rem; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 10px; background: rgba(255, 255, 255, 0.02); }
.attachment-item { grid-template-columns: minmax(0, 1fr) auto; }
.attachment-summary { min-width: 0; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 0.55rem; align-items: center; }
.attachment-text { min-width: 0; display: flex; flex-direction: column; gap: 0.15rem; }
.attachment-text a, .file-name { min-width: 0; overflow-wrap: anywhere; }
.attachment-kind { min-width: 3.1rem; text-align: center; padding: 0.22rem 0.42rem; border-radius: 8px; background: rgba(198, 165, 111, 0.16); color: #f2d7a4; font-size: 0.75rem; font-weight: 700; }
.attachment-actions { display: inline-flex; align-items: center; justify-content: flex-end; gap: 0.65rem; flex-wrap: wrap; }
.text-action { appearance: none; border: 0; background: transparent; padding: 0; color: var(--accent); font: inherit; cursor: pointer; text-decoration: underline; }
.text-action:disabled, .text-action.disabled { color: var(--muted); cursor: default; text-decoration: none; pointer-events: none; }
.text-action.danger { color: #f0b0a7; }
.hidden-input { display: none; }
@media (max-width: 860px) {
  .pending-file-item, .attachment-item { grid-template-columns: 1fr; align-items: flex-start; }
  .attachment-summary { grid-template-columns: 1fr; }
  .attachment-actions { justify-content: flex-start; }
}
</style>

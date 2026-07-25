<template>
  <section class="card panel">
    <h2 class="section-title">{{ t('admin.manageGallery') }}</h2>
    <p class="subtle">{{ t('admin.gallerySubtitle') }}</p>

    <form class="form create-form" @submit.prevent="createItem">
      <h3>{{ t('admin.galleryAdd') }}</h3>
      <div class="field">
        <label>{{ t('admin.gallerySource') }}</label>
        <input v-model.trim="createForm.src" :placeholder="t('admin.gallerySourcePlaceholder')" />
      </div>
      <div class="field">
        <label>{{ t('admin.galleryUpload') }}</label>
        <div class="row">
          <input ref="createFileInputRef" type="file" accept="image/*" @change="onCreateFileChange" />
          <button class="btn secondary" type="button" @click="uploadCreateFile">
            {{ t('admin.galleryUploadButton') }}
          </button>
        </div>
        <p class="subtle">{{ t('admin.galleryUploadHint') }}</p>
      </div>
      <div class="field">
        <label>{{ t('admin.galleryFallback') }}</label>
        <input v-model.trim="createForm.fallback" :placeholder="t('admin.galleryFallbackPlaceholder')" />
      </div>
      <div class="row">
        <div class="field field-half">
          <label>{{ t('admin.galleryTitleZh') }}</label>
          <input v-model.trim="createForm.titleZh" required />
        </div>
        <div class="field field-half">
          <label>{{ t('admin.galleryTitleEn') }}</label>
          <input v-model.trim="createForm.titleEn" required />
        </div>
      </div>
      <div class="row">
        <div class="field field-half">
          <label>{{ t('admin.galleryDescZh') }}</label>
          <textarea v-model="createForm.descriptionZh" rows="3" />
        </div>
        <div class="field field-half">
          <label>{{ t('admin.galleryDescEn') }}</label>
          <textarea v-model="createForm.descriptionEn" rows="3" />
        </div>
      </div>
      <div class="row">
        <div class="field field-half">
          <label>{{ t('admin.galleryAltZh') }}</label>
          <input v-model.trim="createForm.altZh" />
        </div>
        <div class="field field-half">
          <label>{{ t('admin.galleryAltEn') }}</label>
          <input v-model.trim="createForm.altEn" />
        </div>
      </div>
      <div class="row">
        <div class="field field-half">
          <label>{{ t('admin.galleryOrder') }}</label>
          <input type="number" min="0" v-model.number="createForm.displayOrder" />
        </div>
        <label class="toggle">
          <input type="checkbox" v-model="createForm.isVisible" />
          {{ t('admin.galleryVisible') }}
        </label>
      </div>
      <button class="btn" type="submit">{{ t('admin.galleryCreateButton') }}</button>
    </form>
  </section>

  <section class="card panel section-space">
    <h2 class="section-title">{{ t('admin.galleryList') }}</h2>
    <p v-if="items.length === 0" class="subtle">{{ t('admin.galleryEmpty') }}</p>

    <article v-for="item in items" :key="item.id" class="gallery-item">
      <div class="preview">
        <img
          v-if="item._previewSrc"
          :src="item._previewSrc"
          :alt="item.altZh || item.titleZh"
          @error="onPreviewError(item)"
        />
        <EmptyImage v-else :label="t('gallery.empty')" />
      </div>

      <form class="form" @submit.prevent="saveItem(item)">
        <div class="row">
          <div class="field field-half">
            <label>{{ t('admin.gallerySource') }}</label>
            <input v-model.trim="item.src" />
          </div>
          <div class="field field-half">
            <label>{{ t('admin.galleryFallback') }}</label>
            <input v-model.trim="item.fallback" />
          </div>
        </div>
        <div class="field">
          <label>{{ t('admin.galleryUpload') }}</label>
          <div class="row">
            <input type="file" accept="image/*" @change="onItemFileChange(item, $event)" />
            <button class="btn secondary" type="button" @click="uploadItemFile(item)">
              {{ t('admin.galleryReplaceButton') }}
            </button>
          </div>
        </div>

        <div class="row">
          <div class="field field-half">
            <label>{{ t('admin.galleryTitleZh') }}</label>
            <input v-model.trim="item.titleZh" required />
          </div>
          <div class="field field-half">
            <label>{{ t('admin.galleryTitleEn') }}</label>
            <input v-model.trim="item.titleEn" required />
          </div>
        </div>

        <div class="row">
          <div class="field field-half">
            <label>{{ t('admin.galleryDescZh') }}</label>
            <textarea v-model="item.descriptionZh" rows="3" />
          </div>
          <div class="field field-half">
            <label>{{ t('admin.galleryDescEn') }}</label>
            <textarea v-model="item.descriptionEn" rows="3" />
          </div>
        </div>

        <div class="row">
          <div class="field field-half">
            <label>{{ t('admin.galleryAltZh') }}</label>
            <input v-model.trim="item.altZh" />
          </div>
          <div class="field field-half">
            <label>{{ t('admin.galleryAltEn') }}</label>
            <input v-model.trim="item.altEn" />
          </div>
        </div>

        <div class="row controls-row">
          <div class="field field-half">
            <label>{{ t('admin.galleryOrder') }}</label>
            <input type="number" min="0" v-model.number="item.displayOrder" />
          </div>
          <label class="toggle">
            <input type="checkbox" v-model="item.isVisible" />
            {{ t('admin.galleryVisible') }}
          </label>
        </div>

        <div class="row">
          <button class="btn" type="submit">{{ t('admin.gallerySave') }}</button>
          <button class="btn warn" type="button" @click="deleteItem(item)">{{ t('admin.galleryDelete') }}</button>
        </div>
      </form>
    </article>
  </section>
</template>

<script setup>
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import api from '@/services/api';
import { useI18n } from '@/i18n';
import { useToast } from '@/composables/toast';
import EmptyImage from '@/components/EmptyImage.vue';
import { createAuthenticatedObjectUrlStore } from '@/utils/authenticatedFiles.mjs';
import { IMAGE_FILE_LIMIT_BYTES, validateSelectedFiles } from '@/utils/fileLimits';

const { t } = useI18n();
const { showSuccess, showError } = useToast();

const items = ref([]);
const createFileInputRef = ref(null);
const createImageFile = ref(null);
const previewUrls = createAuthenticatedObjectUrlStore(api);
const createForm = reactive({
  src: '',
  fallback: '',
  titleZh: '',
  titleEn: '',
  descriptionZh: '',
  descriptionEn: '',
  altZh: '',
  altEn: '',
  displayOrder: '',
  isVisible: true
});

function normalizeSrc(src) {
  const value = String(src || '').trim();
  if (!value) {
    return value;
  }
  if (value.startsWith('/') || value.startsWith('http://') || value.startsWith('https://')) {
    return value;
  }
  return `/${value}`;
}

function normalizeOptional(value) {
  const text = String(value || '').trim();
  return text.length ? text : null;
}

function parseDisplayOrder(value) {
  if (value === '' || value === null || value === undefined) {
    return undefined;
  }
  const num = Number(value);
  if (!Number.isInteger(num) || num < 0) {
    return 0;
  }
  return num;
}

function normalizeItem(item) {
  return {
    ...item,
    src: normalizeSrc(item.src),
    fallback: item.fallback || '',
    titleZh: item.titleZh || '',
    titleEn: item.titleEn || '',
    descriptionZh: item.descriptionZh || '',
    descriptionEn: item.descriptionEn || '',
    altZh: item.altZh || '',
    altEn: item.altEn || '',
    isVisible: Boolean(item.isVisible),
    displayOrder: Number.isInteger(Number(item.displayOrder)) ? Number(item.displayOrder) : 0,
    _previewSrc: '',
    _fallbackApplied: false
  };
}

function isProtectedPreview(url) {
  return String(url || '').startsWith('/api/admin/');
}

async function loadProtectedPreview(item, url) {
  return previewUrls.load(`gallery-${item.id}`, url);
}

async function refreshPreview(item) {
  const primary = item.previewUrl || item.src;
  item._fallbackApplied = false;
  if (!primary) {
    item._previewSrc = '';
    return;
  }
  item._previewSrc = isProtectedPreview(primary)
    ? await loadProtectedPreview(item, primary)
    : primary;
}

async function onPreviewError(item) {
  if (item._fallbackApplied) {
    item._previewSrc = '';
    return;
  }
  item._fallbackApplied = true;
  const fallback = item.fallbackPreviewUrl || item.fallback;
  if (!fallback) {
    item._previewSrc = '';
    return;
  }
  try {
    item._previewSrc = isProtectedPreview(fallback)
      ? await loadProtectedPreview(item, fallback)
      : fallback;
  } catch (err) {
    item._previewSrc = '';
    showError(err, t('admin.galleryLoadFailed'));
  }
}

async function uploadGalleryFile(file) {
  const formData = new FormData();
  formData.append('imageFile', file);
  const { data } = await api.post('/admin/gallery/upload', formData);
  return data?.src || '';
}

async function loadItems() {
  const { data } = await api.get('/admin/gallery');
  previewUrls.releaseAll();
  items.value = (data.items || []).map(normalizeItem);
  await Promise.all(items.value.map(async (item) => {
    try {
      await refreshPreview(item);
    } catch (err) {
      item._previewSrc = '';
      showError(err, t('admin.galleryLoadFailed'));
    }
  }));
}

function onCreateFileChange(event) {
  const file = event?.target?.files?.[0] || null;
  const error = validateSelectedFiles(file ? [file] : [], { maxFileBytes: IMAGE_FILE_LIMIT_BYTES, maxFiles: 1 });
  if (error) {
    showError(error);
    event.target.value = '';
    createImageFile.value = null;
    return;
  }
  createImageFile.value = file;
}

function onItemFileChange(item, event) {
  const file = event?.target?.files?.[0] || null;
  const error = validateSelectedFiles(file ? [file] : [], { maxFileBytes: IMAGE_FILE_LIMIT_BYTES, maxFiles: 1 });
  if (error) {
    showError(error);
    event.target.value = '';
    item._pendingFile = null;
    return;
  }
  item._pendingFile = file;
}

async function uploadCreateFile() {
  if (!createImageFile.value) {
    showError(t('admin.galleryFileRequired'));
    return;
  }
  try {
    const src = await uploadGalleryFile(createImageFile.value);
    if (src) {
      createForm.src = src;
    }
    createImageFile.value = null;
    if (createFileInputRef.value) {
      createFileInputRef.value.value = '';
    }
    showSuccess(t('admin.galleryUploadSuccess'));
  } catch (err) {
    showError(err, t('admin.galleryLoadFailed'));
  }
}

async function uploadItemFile(item) {
  if (!item?._pendingFile) {
    showError(t('admin.galleryFileRequired'));
    return;
  }
  try {
    const src = await uploadGalleryFile(item._pendingFile);
    if (src) {
      item.src = src;
    }
    item._pendingFile = null;
    showSuccess(t('admin.galleryUploadSuccess'));
  } catch (err) {
    showError(err, t('admin.galleryLoadFailed'));
  }
}

async function createItem() {
  if (!window.confirm(t('admin.confirmCreateGallery'))) {
    return;
  }
  try {
    await api.post('/admin/gallery', {
      src: normalizeSrc(createForm.src),
      fallback: normalizeOptional(createForm.fallback),
      titleZh: createForm.titleZh,
      titleEn: createForm.titleEn,
      descriptionZh: normalizeOptional(createForm.descriptionZh),
      descriptionEn: normalizeOptional(createForm.descriptionEn),
      altZh: normalizeOptional(createForm.altZh),
      altEn: normalizeOptional(createForm.altEn),
      isVisible: createForm.isVisible,
      displayOrder: parseDisplayOrder(createForm.displayOrder)
    });
    showSuccess(t('admin.galleryCreated'));
    createForm.src = '';
    createForm.fallback = '';
    createForm.titleZh = '';
    createForm.titleEn = '';
    createForm.descriptionZh = '';
    createForm.descriptionEn = '';
    createForm.altZh = '';
    createForm.altEn = '';
    createForm.displayOrder = '';
    createForm.isVisible = true;
    await loadItems();
  } catch (err) {
    showError(err, t('admin.galleryLoadFailed'));
  }
}

async function saveItem(item) {
  if (!window.confirm(t('admin.confirmSaveGallery'))) {
    return;
  }
  try {
    await api.patch(`/admin/gallery/${item.id}`, {
      src: normalizeSrc(item.src),
      fallback: normalizeOptional(item.fallback),
      titleZh: item.titleZh,
      titleEn: item.titleEn,
      descriptionZh: normalizeOptional(item.descriptionZh),
      descriptionEn: normalizeOptional(item.descriptionEn),
      altZh: normalizeOptional(item.altZh),
      altEn: normalizeOptional(item.altEn),
      isVisible: item.isVisible,
      displayOrder: parseDisplayOrder(item.displayOrder)
    });
    showSuccess(t('admin.galleryUpdated'));
    await loadItems();
  } catch (err) {
    showError(err, t('admin.galleryLoadFailed'));
  }
}

async function deleteItem(item) {
  if (!window.confirm(t('admin.confirmDeleteGallery'))) {
    return;
  }
  try {
    await api.delete(`/admin/gallery/${item.id}`);
    showSuccess(t('admin.galleryDeleted'));
    await loadItems();
  } catch (err) {
    showError(err, t('admin.galleryLoadFailed'));
  }
}

onMounted(async () => {
  try {
    await loadItems();
  } catch (err) {
    showError(err, t('admin.galleryLoadFailed'));
  }
});

onBeforeUnmount(() => {
  previewUrls.releaseAll();
});
</script>

<style scoped>
.panel {
  padding: 1rem;
}

.section-space {
  margin-top: 1rem;
}

.create-form {
  margin-top: 0.8rem;
}

.gallery-item {
  margin-top: 0.85rem;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--panel-soft);
  padding: 0.75rem;
  display: grid;
  grid-template-columns: 190px minmax(0, 1fr);
  gap: 0.8rem;
}

.preview img {
  width: 100%;
  aspect-ratio: 4 / 3;
  object-fit: cover;
  border-radius: 10px;
  border: 1px solid var(--line);
}

.form {
  display: flex;
  flex-direction: column;
  gap: 0.62rem;
}

.field-half {
  flex: 1;
}

.controls-row {
  align-items: flex-end;
}

.toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  color: var(--muted);
}

@media (max-width: 860px) {
  .gallery-item {
    grid-template-columns: 1fr;
  }
}
</style>

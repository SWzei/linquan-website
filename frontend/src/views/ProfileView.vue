<template>
  <section class="card panel">
    <h2 class="section-title">{{ t('profile.title') }}</h2>
    <form class="form" @submit.prevent="saveProfile">
      <div class="field">
        <label for="profile-display-name">{{ t('profile.displayName') }}</label>
        <input id="profile-display-name" v-model.trim="form.displayName" />
      </div>
      <div class="field">
        <label for="profile-avatar-url">{{ t('profile.avatarUrl') }}</label>
        <input id="profile-avatar-url" v-model.trim="form.avatarUrl" placeholder="https://..." />
      </div>
      <div class="field">
        <label for="profile-avatar-upload">{{ t('profile.avatarUpload') }}</label>
        <input id="profile-avatar-upload" type="file" accept="image/*" @change="onAvatarFileChange" />
        <p class="subtle">{{ t('profile.avatarUploadHint') }}</p>
        <img v-if="avatarPreviewUrl || form.avatarUrl" class="avatar-preview" :src="avatarPreviewUrl || form.avatarUrl" :alt="t('profile.avatarPreview')" />
        <EmptyImage v-else class="profile-empty-image" :label="t('profile.noImage')" />
      </div>
      <div class="field">
        <label for="profile-photo-url">{{ t('profile.personalPhoto') }}</label>
        <input id="profile-photo-url" v-model.trim="form.photoUrl" :placeholder="t('profile.personalPhotoPlaceholder')" />
      </div>
      <div class="field">
        <label for="profile-photo-upload">{{ t('profile.photoUpload') }}</label>
        <input id="profile-photo-upload" type="file" accept="image/*" @change="onPhotoFileChange" />
        <p class="subtle">{{ t('profile.photoUploadHint') }}</p>
        <img v-if="photoPreviewUrl || form.photoUrl"
          class="photo-preview"
          :src="photoPreviewUrl || form.photoUrl"
          :alt="t('profile.photoPreview')"
        />
        <EmptyImage v-else class="profile-empty-image" :label="t('profile.noPersonalPhoto')" />
      </div>
      <div class="field">
        <label for="profile-bio">{{ t('profile.bio') }}</label>
        <textarea id="profile-bio" v-model="form.bio" />
      </div>
      <div class="row">
        <div class="field field-half">
          <label for="profile-grade">{{ t('profile.grade') }}</label>
          <input id="profile-grade" v-model.trim="form.grade" :placeholder="t('profile.gradePlaceholder')" />
        </div>
        <div class="field field-half">
          <label for="profile-academy">{{ t('profile.academy') }}</label>
          <input id="profile-academy" v-model.trim="form.academy" :placeholder="t('profile.academyPlaceholder')" />
        </div>
      </div>
      <div class="row">
        <div class="field field-half">
          <label for="profile-major">{{ t('profile.major') }}</label>
          <input id="profile-major" v-model.trim="form.major" :placeholder="t('profile.majorPlaceholder')" />
        </div>
        <div class="field field-half">
          <label for="profile-wechat">{{ t('profile.wechatAccount') }}</label>
          <input id="profile-wechat" v-model.trim="form.wechatAccount" :placeholder="t('profile.wechatPlaceholder')" />
        </div>
      </div>
      <div class="field">
        <label for="profile-phone">{{ t('profile.phone') }}</label>
        <input id="profile-phone" v-model.trim="form.phone" :placeholder="t('profile.phonePlaceholder')" />
      </div>
      <div class="field">
        <label for="profile-hobbies">{{ t('profile.hobbies') }}</label>
        <textarea id="profile-hobbies" v-model="form.hobbies" :placeholder="t('profile.hobbiesPlaceholder')" />
      </div>
      <div class="field">
        <label for="profile-piano-interests">{{ t('profile.pianoInterests') }}</label>
        <textarea id="profile-piano-interests" v-model="form.pianoInterests" :placeholder="t('profile.pianoInterestsPlaceholder')" />
      </div>
      <button class="btn" :disabled="saving">{{ saving ? t('profile.saving') : t('profile.save') }}</button>
    </form>
  </section>
</template>

<script setup>
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import api from '@/services/api';
import { useI18n } from '@/i18n';
import { useToast } from '@/composables/toast';
import EmptyImage from '@/components/EmptyImage.vue';
import { IMAGE_FILE_LIMIT_BYTES, validateSelectedFiles } from '@/utils/fileLimits';

const form = reactive({
  displayName: '',
  avatarUrl: '',
  photoUrl: '',
  bio: '',
  grade: '',
  major: '',
  academy: '',
  hobbies: '',
  pianoInterests: '',
  wechatAccount: '',
  phone: ''
});

const saving = ref(false);
const avatarFile = ref(null);
const photoFile = ref(null);
const avatarPreviewUrl = ref('');
const photoPreviewUrl = ref('');

const { t } = useI18n();
const { showSuccess, showError } = useToast();

function setForm(data) {
  form.displayName = data.displayName || '';
  form.avatarUrl = data.avatarUrl || '';
  form.photoUrl = data.photoUrl || '';
  form.bio = data.bio || '';
  form.grade = data.grade || '';
  form.major = data.major || '';
  form.academy = data.academy || '';
  form.hobbies = data.hobbies || '';
  form.pianoInterests = data.pianoInterests || '';
  form.wechatAccount = data.wechatAccount || '';
  form.phone = data.phone || '';
}

async function loadData() {
  const { data } = await api.get('/profiles/me');
  setForm(data || {});
}

function clearPreview(urlRef) {
  if (urlRef.value) {
    URL.revokeObjectURL(urlRef.value);
  }
  urlRef.value = '';
}

function onAvatarFileChange(event) {
  const file = event.target.files?.[0] || null;
  const error = validateSelectedFiles(file ? [file] : [], { maxFileBytes: IMAGE_FILE_LIMIT_BYTES, maxFiles: 1 });
  if (error) {
    showError(error);
    event.target.value = '';
    return;
  }
  avatarFile.value = file;
  clearPreview(avatarPreviewUrl);
  if (file) {
    avatarPreviewUrl.value = URL.createObjectURL(file);
  }
}

function onPhotoFileChange(event) {
  const file = event.target.files?.[0] || null;
  const error = validateSelectedFiles(file ? [file] : [], { maxFileBytes: IMAGE_FILE_LIMIT_BYTES, maxFiles: 1 });
  if (error) {
    showError(error);
    event.target.value = '';
    return;
  }
  photoFile.value = file;
  clearPreview(photoPreviewUrl);
  if (file) {
    photoPreviewUrl.value = URL.createObjectURL(file);
  }
}

async function uploadAvatarIfNeeded() {
  if (!avatarFile.value) {
    return;
  }
  const formData = new FormData();
  formData.append('avatar', avatarFile.value);
  const uploadRes = await api.post('/profiles/me/avatar', formData);
  form.avatarUrl = uploadRes.data.avatarUrl || form.avatarUrl;
}

async function uploadPhotoIfNeeded() {
  if (!photoFile.value) {
    return;
  }
  const formData = new FormData();
  formData.append('photo', photoFile.value);
  const uploadRes = await api.post('/profiles/me/photo', formData);
  form.photoUrl = uploadRes.data.photoUrl || form.photoUrl;
}

async function saveProfile() {
  if (!window.confirm(t('profile.confirmSave'))) {
    return;
  }
  saving.value = true;
  try {
    await uploadAvatarIfNeeded();
    await uploadPhotoIfNeeded();
    await api.put('/profiles/me', form);
    avatarFile.value = null;
    photoFile.value = null;
    clearPreview(avatarPreviewUrl);
    clearPreview(photoPreviewUrl);
    showSuccess(t('profile.saveSuccess'));
    await loadData();
  } catch (err) {
    showError(err, t('profile.saveFailed'));
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  try {
    await loadData();
  } catch (err) {
    showError(err, t('profile.loadFailed'));
  }
});

onBeforeUnmount(() => {
  clearPreview(avatarPreviewUrl);
  clearPreview(photoPreviewUrl);
});
</script>

<style scoped>
.panel {
  padding: 1rem;
}

.form {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
}

.field-half {
  flex: 1;
}

.avatar-preview {
  width: 84px;
  height: 84px;
  border-radius: 12px;
  object-fit: cover;
  border: 1px solid var(--line);
}

.photo-preview {
  max-width: 220px;
  border-radius: 12px;
  border: 1px solid var(--line);
}

.profile-empty-image { max-width: 220px; min-height: 110px; }
</style>

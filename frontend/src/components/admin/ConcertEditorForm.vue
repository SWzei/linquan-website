<template>
  <article class="card panel">
    <div class="section-head">
      <div>
        <h2 class="section-title">{{ titleText }}</h2>
        <p class="subtle">{{ modeHint }}</p>
      </div>
      <button
        v-if="isEditMode"
        class="btn secondary"
        type="button"
        :disabled="disabled"
        @click="emit('reset-mode')"
      >
        {{ t('admin.createNewConcertMode') }}
      </button>
    </div>

    <form class="form" @submit.prevent="emit('submit')">
      <div class="field">
        <label>{{ t('admin.title') }}</label>
        <input v-model.trim="titleModel" :disabled="disabled" required />
      </div>

      <div class="field">
        <label>{{ t('admin.description') }}</label>
        <textarea v-model="descriptionModel" :disabled="disabled" rows="4" />
      </div>

      <div class="field">
        <label>{{ t('admin.announcement') }}</label>
        <textarea v-model="announcementModel" :disabled="disabled" rows="4" />
      </div>

      <div class="row">
        <div class="field field-half">
          <label>{{ t('admin.applicationDeadline') }}</label>
          <input type="datetime-local" v-model="applicationDeadlineModel" :disabled="disabled" />
          <p class="subtle">{{ t('admin.dateTimeGuide') }}</p>
        </div>
        <div class="field field-half">
          <label>{{ t('common.status') }}</label>
          <select v-model="statusModel" :disabled="disabled">
            <option value="draft">{{ t('concertStatus.draft') }}</option>
            <option value="open">{{ t('concertStatus.open') }}</option>
            <option value="closed">{{ t('concertStatus.closed') }}</option>
          </select>
        </div>
      </div>

      <div class="field">
        <label>{{ t('admin.attachmentFile') }}</label>
        <input :key="fileInputKey" type="file" :accept="accept" :disabled="disabled" @change="handleFileChange" />
        <p v-if="selectedAttachmentName" class="subtle">
          {{ t('admin.selectedFileName', { name: selectedAttachmentName }) }}
        </p>
      </div>

      <div v-if="isEditMode" class="field">
        <label>{{ t('admin.currentAttachment') }}</label>
        <p v-if="currentAttachmentPath" class="subtle current-attachment">
          <a :href="currentAttachmentPath" target="_blank" rel="noopener">{{ t('admin.currentAttachment') }}</a>
        </p>
        <p v-else class="subtle">{{ t('admin.noAttachments') }}</p>

        <label v-if="currentAttachmentPath" class="toggle">
          <input
            type="checkbox"
            :checked="removeAttachment"
            :disabled="disabled || Boolean(selectedAttachmentName)"
            @change="emit('update:removeAttachment', $event.target.checked)"
          />
          {{ t('admin.removeAttachment') }}
        </label>
        <p v-if="currentAttachmentPath && selectedAttachmentName" class="subtle">
          {{ t('admin.attachmentWillBeReplaced') }}
        </p>
      </div>

      <div v-if="isEditMode" class="field">
        <label>{{ t('admin.releaseMessage') }}</label>
        <textarea
          :value="releaseMessage"
          :disabled="disabled || deleting"
          rows="3"
          @input="emit('update:releaseMessage', $event.target.value)"
        />
      </div>

      <div class="row action-row">
        <button class="btn" type="submit" :disabled="disabled || submitting || releasing || deleting">
          {{ primaryActionLabel }}
        </button>
        <button
          v-if="isEditMode"
          class="btn warn"
          type="button"
          :disabled="disabled || submitting || releasing || deleting"
          @click="emit('release')"
        >
          {{ releasing ? t('common.loading') : t('admin.releaseConcert') }}
        </button>
        <button
          v-if="isEditMode"
          class="btn danger"
          type="button"
          :disabled="disabled || submitting || releasing || deleting"
          @click="emit('delete')"
        >
          {{ deleting ? t('common.loading') : t('admin.deleteConcert') }}
        </button>
      </div>
    </form>
  </article>
</template>

<script setup>
import { computed } from 'vue';
import { useI18n } from '@/i18n';

const props = defineProps({
  mode: {
    type: String,
    default: 'create'
  },
  form: {
    type: Object,
    required: true
  },
  activeTitle: {
    type: String,
    default: ''
  },
  currentAttachmentPath: {
    type: String,
    default: ''
  },
  selectedAttachmentName: {
    type: String,
    default: ''
  },
  removeAttachment: {
    type: Boolean,
    default: false
  },
  releaseMessage: {
    type: String,
    default: ''
  },
  submitting: {
    type: Boolean,
    default: false
  },
  releasing: {
    type: Boolean,
    default: false
  },
  deleting: {
    type: Boolean,
    default: false
  },
  disabled: {
    type: Boolean,
    default: false
  },
  fileInputNonce: {
    type: Number,
    default: 0
  },
  accept: {
    type: String,
    default: ''
  }
});

const emit = defineEmits([
  'submit',
  'release',
  'delete',
  'reset-mode',
  'file-change',
  'update:form',
  'update:removeAttachment',
  'update:releaseMessage'
]);

const { t } = useI18n();

const isEditMode = computed(() => props.mode === 'edit');
const titleText = computed(() => {
  if (!isEditMode.value) {
    return t('admin.createConcert');
  }
  return props.activeTitle
    ? `${t('admin.editConcert')} - ${props.activeTitle}`
    : t('admin.editConcert');
});
const modeHint = computed(() => (
  isEditMode.value ? t('admin.editConcertHint') : t('admin.createConcertHint')
));
const primaryActionLabel = computed(() => {
  if (props.submitting) {
    return t('common.loading');
  }
  return isEditMode.value ? t('admin.saveConcert') : t('admin.createConcertButton');
});
const fileInputKey = computed(() => `concert-file-${props.fileInputNonce}`);
const titleModel = computed({
  get: () => props.form.title || '',
  set: (value) => updateForm({ title: value })
});
const descriptionModel = computed({
  get: () => props.form.description || '',
  set: (value) => updateForm({ description: value })
});
const announcementModel = computed({
  get: () => props.form.announcement || '',
  set: (value) => updateForm({ announcement: value })
});
const applicationDeadlineModel = computed({
  get: () => props.form.applicationDeadline || '',
  set: (value) => updateForm({ applicationDeadline: value })
});
const statusModel = computed({
  get: () => props.form.status || 'draft',
  set: (value) => updateForm({ status: value })
});

function updateForm(patch) {
  emit('update:form', {
    ...props.form,
    ...patch
  });
}

function handleFileChange(event) {
  emit('file-change', event.target.files?.[0] || null);
}
</script>

<style scoped>
.panel {
  padding: 1rem;
}

.section-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.8rem;
  margin-bottom: 0.8rem;
}

.form {
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
}

.field-half {
  flex: 1;
}

.toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  font-size: 0.9rem;
  color: var(--muted);
}

.action-row {
  flex-wrap: wrap;
}

.current-attachment a {
  color: var(--accent);
  text-decoration: underline;
}

.danger {
  background: #8f2730;
  border-color: #8f2730;
  color: #fff;
}

.danger:hover {
  background: #a22b36;
  border-color: #a22b36;
}

@media (max-width: 860px) {
  .section-head {
    flex-direction: column;
  }
}
</style>

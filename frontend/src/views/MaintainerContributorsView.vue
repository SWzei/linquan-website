<template>
  <section class="card panel" aria-labelledby="contributor-management-title">
    <router-link class="back-link" to="/maintainer">← {{ t('maintainerContributors.back') }}</router-link>
    <h2 id="contributor-management-title" class="section-title">{{ t('maintainerContributors.title') }}</h2>
    <p class="subtle">{{ t('maintainerContributors.subtitle') }}</p>

    <form class="form contributor-form" @submit.prevent="saveContributor">
      <div class="field">
        <label for="contributor-name">{{ t('maintainerContributors.name') }}</label>
        <input id="contributor-name" ref="nameInput" v-model.trim="form.name" maxlength="80" required autocomplete="off" />
      </div>
      <div class="field">
        <label for="contributor-github">{{ t('maintainerContributors.githubUrl') }}</label>
        <input id="contributor-github" v-model.trim="form.githubUrl" type="url" maxlength="200" required placeholder="https://github.com/example" autocomplete="url" />
        <p class="subtle field-hint">{{ t('maintainerContributors.githubHint') }}</p>
      </div>
      <div class="form-actions">
        <button class="btn" type="submit" :disabled="saving">
          {{ editingId ? t('maintainerContributors.saveEdit') : t('maintainerContributors.add') }}
        </button>
        <button v-if="editingId" class="btn secondary" type="button" :disabled="saving" @click="resetForm">
          {{ t('maintainerContributors.cancel') }}
        </button>
      </div>
    </form>
  </section>

  <section class="card panel section-space" aria-labelledby="contributor-order-title">
    <h3 id="contributor-order-title">{{ t('maintainerContributors.orderTitle') }}</h3>
    <p class="subtle">{{ t('maintainerContributors.orderHint') }}</p>
    <p v-if="loading" class="subtle" role="status">{{ t('common.loading') }}</p>
    <p v-else-if="contributors.length === 0" class="subtle">{{ t('maintainerContributors.empty') }}</p>
    <ol v-else class="management-list">
      <li v-for="(contributor, index) in contributors" :key="contributor.id">
        <div class="contributor-summary">
          <strong>{{ contributor.name }}</strong>
          <a :href="contributor.githubUrl" target="_blank" rel="noopener noreferrer">{{ contributor.githubUrl }}</a>
        </div>
        <div class="item-actions">
          <button class="btn secondary" type="button" :disabled="reordering || index === 0" :aria-label="t('maintainerContributors.moveUpLabel', { name: contributor.name })" @click="move(index, -1)">↑ {{ t('maintainerContributors.up') }}</button>
          <button class="btn secondary" type="button" :disabled="reordering || index === contributors.length - 1" :aria-label="t('maintainerContributors.moveDownLabel', { name: contributor.name })" @click="move(index, 1)">↓ {{ t('maintainerContributors.down') }}</button>
          <button class="btn secondary" type="button" :aria-label="t('maintainerContributors.editLabel', { name: contributor.name })" @click="editContributor(contributor)">{{ t('maintainerContributors.edit') }}</button>
          <button class="btn warn" type="button" :aria-label="t('maintainerContributors.removeLabel', { name: contributor.name })" @click="removeContributor(contributor)">{{ t('maintainerContributors.remove') }}</button>
        </div>
      </li>
    </ol>
  </section>
</template>

<script setup>
import { nextTick, onMounted, reactive, ref } from 'vue';
import api from '@/services/api';
import { useI18n } from '@/i18n';
import { useToast } from '@/composables/toast';

const contributors = ref([]);
const loading = ref(false);
const saving = ref(false);
const reordering = ref(false);
const editingId = ref(null);
const nameInput = ref(null);
const form = reactive({ name: '', githubUrl: '' });
const { t } = useI18n();
const { showSuccess, showError } = useToast();

async function loadContributors() {
  loading.value = true;
  try {
    contributors.value = (await api.get('/maintainer/contributors')).data.items || [];
  } catch (err) {
    showError(err, t('maintainerContributors.loadFailed'));
  } finally {
    loading.value = false;
  }
}

function resetForm() {
  editingId.value = null;
  form.name = '';
  form.githubUrl = '';
}

async function saveContributor() {
  saving.value = true;
  try {
    const payload = { name: form.name, githubUrl: form.githubUrl };
    if (editingId.value) await api.patch(`/maintainer/contributors/${editingId.value}`, payload);
    else await api.post('/maintainer/contributors', payload);
    resetForm();
    await loadContributors();
    showSuccess(t('maintainerContributors.saved'));
    await nextTick();
    nameInput.value?.focus();
  } catch (err) {
    showError(err, t('maintainerContributors.saveFailed'));
  } finally {
    saving.value = false;
  }
}

async function editContributor(contributor) {
  editingId.value = contributor.id;
  form.name = contributor.name;
  form.githubUrl = contributor.githubUrl;
  await nextTick();
  nameInput.value?.focus();
  nameInput.value?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function move(index, offset) {
  const reordered = [...contributors.value];
  const [item] = reordered.splice(index, 1);
  reordered.splice(index + offset, 0, item);
  reordering.value = true;
  try {
    const response = await api.put('/maintainer/contributors/order', { ids: reordered.map((entry) => entry.id) });
    contributors.value = response.data.items || reordered;
    showSuccess(t('maintainerContributors.orderSaved'));
  } catch (err) {
    showError(err, t('maintainerContributors.orderFailed'));
    await loadContributors();
  } finally {
    reordering.value = false;
  }
}

async function removeContributor(contributor) {
  if (!window.confirm(t('maintainerContributors.confirmRemove', { name: contributor.name }))) return;
  try {
    await api.delete(`/maintainer/contributors/${contributor.id}`);
    if (editingId.value === contributor.id) resetForm();
    await loadContributors();
    showSuccess(t('maintainerContributors.removed'));
  } catch (err) {
    showError(err, t('maintainerContributors.removeFailed'));
  }
}

onMounted(loadContributors);
</script>

<style scoped>
.panel { padding: 1rem; }
.back-link { display: inline-block; margin-bottom: .8rem; color: var(--muted); text-decoration: underline; text-underline-offset: .2rem; }
.contributor-form { max-width: 720px; margin-top: 1rem; }
.field-hint { margin: .35rem 0 0; }
.form-actions, .item-actions { display: flex; flex-wrap: wrap; gap: .55rem; }
.management-list { list-style-position: inside; margin: 1rem 0 0; padding: 0; }
.management-list li { display: flex; justify-content: space-between; align-items: center; gap: 1rem; padding: .8rem 0; border-top: 1px solid var(--line); }
.contributor-summary { display: grid; gap: .25rem; min-width: 0; }
.contributor-summary a { color: var(--muted); overflow-wrap: anywhere; text-decoration: underline; text-underline-offset: .18rem; }
@media (max-width: 700px) {
  .management-list li { align-items: stretch; flex-direction: column; }
  .item-actions .btn { flex: 1 1 calc(50% - .55rem); }
}
</style>

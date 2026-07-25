<template>
  <section class="card auth-wrap">
    <h2 class="section-title">{{ t('passwordChange.title') }}</h2>
    <p class="subtle">{{ t('passwordChange.subtitle') }}</p>
    <form class="form" @submit.prevent="submit">
      <div class="field">
        <label for="current-password">{{ t('passwordChange.currentPassword') }}</label>
        <input
          id="current-password"
          v-model="currentPassword"
          type="password"
          autocomplete="current-password"
          required
        />
      </div>
      <div class="field">
        <label for="new-password">{{ t('passwordChange.newPassword') }}</label>
        <input
          id="new-password"
          v-model="newPassword"
          type="password"
          autocomplete="new-password"
          minlength="8"
          maxlength="128"
          pattern="(?=.*[A-Za-z])(?=.*\d).{8,128}"
          required
        />
        <small class="subtle">{{ t('passwordChange.requirement') }}</small>
      </div>
      <button class="btn" type="submit" :disabled="loading">
        {{ loading ? t('passwordChange.saving') : t('passwordChange.save') }}
      </button>
    </form>
  </section>
</template>

<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { useI18n } from '@/i18n';
import { useToast } from '@/composables/toast';

const currentPassword = ref('');
const newPassword = ref('');
const loading = ref(false);
const auth = useAuthStore();
const router = useRouter();
const { t } = useI18n();
const { showError, showSuccess } = useToast();

async function submit() {
  loading.value = true;
  try {
    await auth.changePassword({
      currentPassword: currentPassword.value,
      newPassword: newPassword.value
    });
    showSuccess(t('passwordChange.changed'));
    await router.replace({ name: 'login' });
  } catch (err) {
    showError(err, t('passwordChange.failed'));
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.auth-wrap {
  width: min(460px, 100%);
  margin: 0 auto;
  padding: 1.2rem;
}

.form {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}
</style>

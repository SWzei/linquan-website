<template>
  <section class="card auth-card">
    <h2 class="section-title">{{ t('maintainer.loginTitle') }}</h2>
    <p class="subtle">{{ t('maintainer.loginSubtitle') }}</p>
    <form class="form" @submit.prevent="submit">
      <div class="field">
        <label for="maintainer-credential">{{ t('maintainer.credential') }}</label>
        <input id="maintainer-credential" v-model.trim="credential" autocomplete="username" required />
      </div>
      <div class="field">
        <label for="maintainer-password">{{ t('maintainer.password') }}</label>
        <input id="maintainer-password" v-model="password" type="password" autocomplete="current-password" required />
      </div>
      <button class="btn" type="submit" :disabled="loading">{{ t('maintainer.login') }}</button>
    </form>
  </section>
</template>

<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { useI18n } from '@/i18n';
import { useToast } from '@/composables/toast';

const credential = ref('');
const password = ref('');
const loading = ref(false);
const auth = useAuthStore();
const router = useRouter();
const { t } = useI18n();
const { showError } = useToast();

async function submit() {
  loading.value = true;
  try {
    await auth.maintainerLogin({ credential: credential.value, password: password.value });
    await router.push('/maintainer');
  } catch (err) {
    showError(err, t('maintainer.loginFailed'));
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>.auth-card { max-width: 520px; margin: 2rem auto; padding: 1.2rem; }</style>

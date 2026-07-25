<template>
  <section class="card auth-wrap">
    <h2 class="section-title">{{ t('login.title') }}</h2>
    <p class="subtle">{{ t('login.subtitle') }}</p>

    <form class="form" @submit.prevent="handleLogin">
      <div class="field">
        <label for="member-login-credential">{{ t('login.credential') }}</label>
        <input
          id="member-login-credential"
          v-model.trim="credential"
          autocomplete="username"
          required
          :placeholder="t('login.credentialPlaceholder')"
        />
      </div>
      <div class="field">
        <label for="member-login-password">{{ t('login.password') }}</label>
        <div class="password-wrap">
          <input
            id="member-login-password"
            v-model="password"
            :type="showPassword ? 'text' : 'password'"
            autocomplete="current-password"
            required
            minlength="6"
            :placeholder="t('login.passwordPlaceholder')"
          />
          <button class="toggle-btn" type="button" @click="showPassword = !showPassword">
            {{ showPassword ? t('common.hide') : t('common.show') }}
          </button>
        </div>
      </div>
      <button class="btn" type="submit" :disabled="loading">{{ loading ? t('login.loggingIn') : t('login.login') }}</button>
      <p class="subtle">
        {{ t('login.noAccount') }}
        <router-link to="/register" class="link">{{ t('login.createAccount') }}</router-link>
      </p>
    </form>
  </section>
</template>

<script setup>
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { useI18n } from '@/i18n';
import { useToast } from '@/composables/toast';

const credential = ref('');
const password = ref('');
const showPassword = ref(false);
const loading = ref(false);

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();
const { t } = useI18n();
const { showError } = useToast();

async function handleLogin() {
  loading.value = true;
  try {
    await auth.login({
      credential: credential.value,
      password: password.value
    });
    const redirect = route.query.redirect || '/';
    router.push(redirect);
  } catch (err) {
    showError(err, t('login.failed'));
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

.link {
  color: var(--accent);
  font-weight: 700;
}

.password-wrap {
  display: flex;
  gap: 0.45rem;
}

.password-wrap input {
  flex: 1;
}

.toggle-btn {
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--panel-soft);
  color: var(--ink);
  padding: 0.55rem 0.7rem;
  cursor: pointer;
  font-weight: 700;
}
</style>

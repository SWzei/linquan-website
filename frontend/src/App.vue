<template>
  <div>
    <header class="topbar">
      <div class="topbar-inner">
        <div class="brand">
          <router-link class="brand-home" :to="auth.isMaintainer ? '/maintainer' : '/'" :aria-label="t('app.clubName')">
            <img class="brand-mark" :src="logoUrl" alt="" width="38" height="38" />
          </router-link>
          <div>
            <router-link class="brand-title" :to="auth.isMaintainer ? '/maintainer' : '/'">
              <h1>{{ t('app.clubName') }}</h1>
            </router-link>
            <router-link v-if="!auth.isMaintainer" class="contributor-link" to="/contributors">
              {{ t('app.contributorsLink') }}
            </router-link>
          </div>
        </div>

        <nav class="nav" :aria-label="t('app.primaryNavigation')">
          <router-link to="/">{{ t('app.navHome') }}</router-link>
          <router-link v-if="auth.isMember" to="/schedule">{{ t('app.navSchedule') }}</router-link>
          <router-link v-if="auth.isMember" to="/class-matching">{{ t('app.navClassMatching') }}</router-link>
          <router-link v-if="auth.isMember" to="/concerts">{{ t('app.navConcerts') }}</router-link>
          <router-link v-if="!auth.isMaintainer" to="/members">{{ t('app.navMembers') }}</router-link>
          <router-link v-if="!auth.isMaintainer" to="/gallery">{{ t('app.navGallery') }}</router-link>
          <router-link v-if="auth.isMember" to="/profile">{{ t('app.navProfile') }}</router-link>
          <router-link v-if="auth.isAdmin" to="/admin">{{ t('app.navAdmin') }}</router-link>
          <router-link v-if="auth.isMaintainer" to="/maintainer">{{ t('app.navMaintainer') }}</router-link>
          <router-link v-if="auth.isMaintainer" to="/maintainer/contributors">{{ t('app.navContributorManagement') }}</router-link>
          <router-link v-if="auth.isMaintainer" to="/maintainer/archive">{{ t('archive.title') }}</router-link>
          <router-link v-if="!auth.isAuthenticated" to="/login">{{ t('app.navLogin') }}</router-link>
          <router-link v-if="!auth.isAuthenticated" to="/register">{{ t('app.navRegister') }}</router-link>
          <button v-if="auth.isAuthenticated" class="btn secondary" @click="logout">
            {{ t('app.navLogout') }}
          </button>
          <div class="lang-switch">
            <button class="lang-btn" :class="{ active: locale === 'zh' }" :aria-pressed="locale === 'zh'" @click="setLocale('zh')">
              {{ t('app.langZh') }}
            </button>
            <button class="lang-btn" :class="{ active: locale === 'en' }" :aria-pressed="locale === 'en'" @click="setLocale('en')">
              {{ t('app.langEn') }}
            </button>
          </div>
        </nav>
      </div>
    </header>

    <main class="page">
      <router-view />
    </main>
    <div
      v-if="profileReminderVisible"
      class="reminder-backdrop"
      @keydown="handleReminderKeydown"
    >
      <section
        ref="reminderDialog"
        class="card profile-reminder"
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-reminder-title"
        aria-describedby="profile-reminder-body"
      >
        <h2 id="profile-reminder-title">{{ t('register.profileReminderTitle') }}</h2>
        <p id="profile-reminder-body">{{ t('register.profileReminderBody') }}</p>
        <div class="reminder-actions">
          <button
            ref="reminderPrimary"
            class="btn"
            type="button"
            :disabled="reminderBusy"
            @click="finishProfileReminder(true)"
          >
            {{ t('register.profileReminderAction') }}
          </button>
          <button
            class="btn secondary"
            type="button"
            :disabled="reminderBusy"
            @click="finishProfileReminder(false)"
          >
            {{ t('register.profileReminderLater') }}
          </button>
        </div>
      </section>
    </div>
    <CenterToast />
  </div>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { useI18n } from '@/i18n';
import CenterToast from '@/components/CenterToast.vue';
import { useToast } from '@/composables/toast';
import { shouldShowProfileReminder } from '@/utils/authUiState.mjs';

const router = useRouter();
const auth = useAuthStore();
const { t, locale, setLocale } = useI18n();
const { showError } = useToast();
const reminderBusy = ref(false);
const reminderDialog = ref(null);
const reminderPrimary = ref(null);
const profileReminderVisible = computed(() => shouldShowProfileReminder(auth.user));
const logoUrl = `${process.env.BASE_URL || '/'}photos/brand/linquan-logo.jpg`;

watch(
  () => profileReminderVisible.value,
  async (visible) => {
    if (visible) {
      await nextTick();
      reminderPrimary.value?.focus();
    }
  },
  { immediate: true }
);

async function finishProfileReminder(openProfile) {
  reminderBusy.value = true;
  try {
    await auth.acknowledgeProfileReminder();
    if (openProfile) await router.push('/profile');
  } catch (err) {
    showError(err, t('register.profileReminderFailed'));
  } finally {
    reminderBusy.value = false;
  }
}

function handleReminderKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    finishProfileReminder(false);
    return;
  }
  if (event.key !== 'Tab') return;
  const buttons = [...(reminderDialog.value?.querySelectorAll('button:not(:disabled)') || [])];
  if (!buttons.length) return;
  const first = buttons[0];
  const last = buttons[buttons.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function logout() {
  if (!window.confirm(t('app.confirmLogout'))) {
    return;
  }
  const wasMaintainer = auth.isMaintainer;
  auth.logout();
  router.push(wasMaintainer ? '/maintainer/login' : '/login');
}
</script>

<style scoped>
.topbar {
  position: sticky;
  top: 0;
  z-index: 5;
  backdrop-filter: blur(8px);
  background: rgba(14, 17, 24, 0.9);
  border-bottom: 1px solid var(--line);
}

.topbar-inner {
  width: min(1200px, calc(100% - 1.6rem));
  margin: 0 auto;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.8rem 0;
  gap: 1rem;
}

.brand {
  display: flex;
  align-items: center;
  gap: 0.7rem;
}

.brand h1 {
  margin: 0;
  font-size: 1.06rem;
  letter-spacing: 0.02em;
}

.contributor-link {
  display: inline-block;
  margin: 0.1rem 0 0;
  color: var(--muted);
  font-size: 0.8rem;
  text-decoration: underline;
  text-decoration-color: transparent;
  text-underline-offset: 0.18rem;
  transition: color 0.18s ease, text-decoration-color 0.18s ease;
}

.contributor-link:hover,
.contributor-link:focus-visible {
  color: var(--ink);
  text-decoration-color: currentColor;
}

.brand-mark {
  width: 2.4rem;
  height: 2.4rem;
  border-radius: 10px;
  display: block;
  object-fit: cover;
  border: 1px solid var(--line);
  background: #0f1114;
}

.nav {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  flex-wrap: wrap;
}

.lang-switch {
  display: inline-flex;
  border: 1px solid var(--line);
  border-radius: 9px;
  overflow: hidden;
  margin-left: 0.25rem;
}

.lang-btn {
  border: 0;
  background: #13161b;
  padding: 0.24rem 0.48rem;
  font-size: 0.74rem;
  font-weight: 700;
  color: var(--muted);
  cursor: pointer;
  transition: background-color 0.18s ease, color 0.18s ease, filter 0.18s ease;
}

.lang-btn:hover {
  background: #232831;
  color: #e6e6e6;
  filter: brightness(1.06);
}

.lang-btn.active {
  background: #1f2328;
  color: var(--ink);
}

.nav a,
.nav .btn {
  padding: 0.68rem 1.02rem;
  border-radius: 10px;
  color: var(--ink);
  font-weight: 700;
  font-size: 1.1rem;
  line-height: 1;
  transition:
    background-color 0.18s ease,
    color 0.18s ease,
    box-shadow 0.18s ease,
    transform 0.14s ease,
    filter 0.18s ease;
}

.nav a:hover {
  background: #2a2f36;
  color: #ffffff;
  filter: brightness(1.04);
  box-shadow: 0 8px 16px rgba(255, 255, 255, 0.08);
  transform: translateY(-1px);
}

.nav a.router-link-active {
  background: #1b1f24;
}

.nav .btn.secondary {
  background: #1b1f24;
}

.reminder-backdrop {
  position: fixed;
  inset: 0;
  z-index: 30;
  display: grid;
  place-items: center;
  padding: 1rem;
  background: rgba(4, 6, 9, 0.78);
  backdrop-filter: blur(5px);
}

.profile-reminder {
  width: min(520px, 100%);
  padding: 1.35rem;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.48);
}

.profile-reminder h2 {
  margin: 0;
  font-size: 1.3rem;
}

.profile-reminder p {
  margin: 0.7rem 0 0;
  color: var(--muted);
  line-height: 1.7;
}

.reminder-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.65rem;
  margin-top: 1.1rem;
}

.reminder-actions .btn {
  min-width: 9rem;
}

@media (max-width: 920px) {
  .topbar-inner {
    flex-direction: column;
    align-items: stretch;
  }
  .nav {
    justify-content: flex-start;
  }
  .reminder-actions .btn {
    flex: 1 1 100%;
  }
}
</style>

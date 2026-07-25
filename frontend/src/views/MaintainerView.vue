<template>
  <section class="card panel">
    <h2 class="section-title">{{ t('maintainer.title') }}</h2>
    <p class="subtle">{{ t('maintainer.scope') }}</p>
    <div class="field">
      <label for="maintainer-member-search">{{ t('maintainer.search') }}</label>
      <input id="maintainer-member-search" v-model.trim="query" @input="loadMembers" />
    </div>
    <p v-if="loading" class="subtle" role="status">{{ t('common.loading') }}</p>
    <ul v-else class="member-list">
      <li v-for="member in members" :key="member.id">
        <div><strong>{{ member.displayName }}</strong><p class="subtle">{{ member.studentNumber }} · {{ member.email || '-' }}</p></div>
        <button type="button" class="btn" :class="{ secondary: member.isAdmin }" :aria-label="`${member.isAdmin ? t('maintainer.revoke') : t('maintainer.grant')} ${member.displayName}`" @click="setAdmin(member, !member.isAdmin)">
          {{ member.isAdmin ? t('maintainer.revoke') : t('maintainer.grant') }}
        </button>
      </li>
    </ul>
    <p v-if="!loading && members.length === 0" class="subtle">{{ t('maintainer.noMembers') }}</p>
  </section>
  <section class="card panel section-space">
    <h3>{{ t('archive.title') }}</h3>
    <p class="subtle">{{ t('archive.maintainerScope') }}</p>
    <router-link class="btn secondary" to="/maintainer/archive">{{ t('archive.open') }}</router-link>
  </section>
  <section class="card panel section-space">
    <h3>{{ t('maintainer.contributorManagementTitle') }}</h3>
    <p class="subtle">{{ t('maintainer.contributorManagementScope') }}</p>
    <router-link class="btn secondary" to="/maintainer/contributors">
      {{ t('maintainer.manageContributors') }}
    </router-link>
  </section>
  <section class="card panel section-space">
    <h3>{{ t('maintainer.auditTitle') }}</h3>
    <ul class="audit-list">
      <li v-for="item in audit" :key="item.id">{{ item.createdAt }} · {{ item.action }} · {{ item.targetDisplayName }} ({{ item.targetStudentNumber }})</li>
    </ul>
  </section>
  <section class="card panel section-space">
    <h3>{{ t('maintainer.securityTitle') }}</h3>
    <form class="form" @submit.prevent="changePassword">
      <div class="field"><label for="maintainer-current-password">{{ t('maintainer.currentPassword') }}</label><input id="maintainer-current-password" v-model="currentPassword" type="password" autocomplete="current-password" required /></div>
      <div class="field"><label for="maintainer-new-password">{{ t('maintainer.newPassword') }}</label><input id="maintainer-new-password" v-model="newPassword" type="password" autocomplete="new-password" required /></div>
      <button class="btn" type="submit">{{ t('maintainer.changePassword') }}</button>
    </form>
  </section>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import api from '@/services/api';
import { useAuthStore } from '@/stores/auth';
import { useI18n } from '@/i18n';
import { useToast } from '@/composables/toast';

const members = ref([]); const audit = ref([]); const query = ref('');
const currentPassword = ref(''); const newPassword = ref(''); const loading = ref(false);
const auth = useAuthStore(); const router = useRouter(); const { t } = useI18n();
const { showSuccess, showError } = useToast();
async function loadMembers() { loading.value = true; try { members.value = (await api.get('/maintainer/members', { params: { q: query.value } })).data.items || []; } catch (err) { showError(err); } finally { loading.value = false; } }
async function loadAudit() { audit.value = (await api.get('/maintainer/audit-log')).data.items || []; }
async function setAdmin(member, isAdmin) { if (!window.confirm(t('maintainer.confirmPrivilege', { action: isAdmin ? t('maintainer.grant') : t('maintainer.revoke'), member: member.displayName }))) return; try { await api.put(`/maintainer/members/${member.id}/administrator`, { isAdmin }); await Promise.all([loadMembers(), loadAudit()]); showSuccess(t('maintainer.saved')); } catch (err) { showError(err); } }
async function changePassword() { try { await api.post('/maintainer/change-password', { currentPassword: currentPassword.value, newPassword: newPassword.value }); showSuccess(t('maintainer.passwordChanged')); auth.logout(); await router.push('/maintainer/login'); } catch (err) { showError(err); } }
onMounted(async () => { try { await Promise.all([loadMembers(), loadAudit()]); } catch (err) { showError(err); } });
</script>

<style scoped>.panel{padding:1rem}.member-list,.audit-list{list-style:none;padding:0}.member-list li{display:flex;justify-content:space-between;gap:1rem;align-items:center;border-top:1px solid var(--line);padding:.75rem 0}.member-list p{margin:.25rem 0 0}</style>

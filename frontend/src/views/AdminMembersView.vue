<template>
  <section class="grid-2">
    <article class="card panel">
      <h2 class="section-title">{{ t('admin.memberAccountMgmt') }}</h2>
      <p class="subtle">{{ t('admin.memberAccountSubtitle') }}</p>

      <form class="row search-row" @submit.prevent="loadMembers">
        <div class="field search-field">
          <label>{{ t('admin.memberAccountSearch') }}</label>
          <input
            v-model.trim="keyword"
            :placeholder="t('admin.memberAccountSearchPlaceholder')"
          />
        </div>
        <button class="btn secondary" type="submit">{{ t('admin.loadMembers') }}</button>
      </form>

      <p v-if="loadingList" class="subtle">{{ t('common.loading') }}</p>
      <p v-else-if="members.length === 0" class="subtle">{{ t('admin.memberAccountEmpty') }}</p>

      <div v-else class="member-list">
        <button
          v-for="item in members"
          :key="item.id"
          type="button"
          class="member-item"
          :class="{ active: item.id === selectedMemberId }"
          @click="selectMember(item.id)"
        >
          <h3>{{ item.displayName || item.studentNumber }}</h3>
          <p class="subtle">{{ item.studentNumber }} · {{ item.email || '-' }}</p>
          <p class="subtle">{{ item.academy || '-' }} · {{ item.major || '-' }}</p>
        </button>
      </div>
    </article>

    <article class="card panel">
      <h2 class="section-title">{{ t('admin.memberAccountDetail') }}</h2>
      <p v-if="loadingDetail" class="subtle">{{ t('common.loading') }}</p>
      <p v-else-if="!detail" class="subtle">{{ t('admin.memberDetailEmpty') }}</p>

      <template v-else>
        <div class="detail-grid">
          <div>
            <span class="label">{{ t('common.name') }}</span>
            <strong>{{ detail.displayName || '-' }}</strong>
          </div>
          <div>
            <span class="label">{{ t('common.student') }}</span>
            <strong>{{ detail.studentNumber }}</strong>
          </div>
          <div>
            <span class="label">{{ t('admin.memberAccount') }}</span>
            <strong>{{ detail.studentNumber }}</strong>
          </div>
          <div>
            <span class="label">{{ t('admin.memberEmail') }}</span>
            <strong>{{ detail.email || '-' }}</strong>
          </div>
          <div>
            <span class="label">{{ t('profile.academy') }}</span>
            <strong>{{ detail.academy || '-' }}</strong>
          </div>
          <div>
            <span class="label">{{ t('profile.major') }}</span>
            <strong>{{ detail.major || '-' }}</strong>
          </div>
          <div>
            <span class="label">{{ t('profile.grade') }}</span>
            <strong>{{ detail.grade || '-' }}</strong>
          </div>
          <div>
            <span class="label">{{ t('admin.memberCreatedAt') }}</span>
            <strong>{{ formatDate(detail.createdAt) }}</strong>
          </div>
        </div>

        <form class="form section-space" @submit.prevent="resetPassword">
          <div class="field">
            <label>{{ t('admin.memberResetPasswordInput') }}</label>
            <input
              v-model.trim="manualPassword"
              :placeholder="t('admin.memberResetPasswordPlaceholder')"
            />
            <p class="subtle">{{ t('admin.memberResetPasswordHint') }}</p>
          </div>
          <div class="row">
            <button class="btn secondary" type="submit">{{ t('admin.memberResetPassword') }}</button>
            <button class="btn warn" type="button" @click="deleteMember">{{ t('admin.memberDelete') }}</button>
          </div>
        </form>

        <div v-if="latestTemporaryPassword" class="temporary-password">
          <p class="subtle">{{ t('admin.memberTemporaryPassword') }}</p>
          <code>{{ latestTemporaryPassword }}</code>
        </div>
      </template>
    </article>
  </section>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import api from '@/services/api';
import { useI18n } from '@/i18n';
import { useToast } from '@/composables/toast';
import { formatDateTimeInBeijing } from '@/utils/dateTime';

const { t, locale } = useI18n();
const { showSuccess, showError } = useToast();

const members = ref([]);
const keyword = ref('');
const loadingList = ref(false);
const selectedMemberId = ref(0);
const detail = ref(null);
const loadingDetail = ref(false);
const manualPassword = ref('');
const latestTemporaryPassword = ref('');

function formatDate(value) {
  return formatDateTimeInBeijing(value, locale.value);
}

async function loadMembers() {
  loadingList.value = true;
  try {
    const params = {};
    if (keyword.value) {
      params.keyword = keyword.value;
    }
    const { data } = await api.get('/admin/members', { params });
    members.value = data.items || [];

    if (members.value.length === 0) {
      selectedMemberId.value = 0;
      detail.value = null;
      return;
    }

    const stillSelected = members.value.some((item) => item.id === selectedMemberId.value);
    if (!stillSelected) {
      selectedMemberId.value = members.value[0].id;
    }
    await loadMemberDetail(selectedMemberId.value);
  } catch (err) {
    showError(err, t('admin.memberLoadFailed'));
  } finally {
    loadingList.value = false;
  }
}

async function loadMemberDetail(memberId) {
  if (!memberId) {
    detail.value = null;
    return;
  }
  loadingDetail.value = true;
  try {
    const { data } = await api.get(`/admin/members/${memberId}`);
    detail.value = data || null;
  } catch (err) {
    detail.value = null;
    showError(err, t('admin.memberLoadFailed'));
  } finally {
    loadingDetail.value = false;
  }
}

async function selectMember(memberId) {
  selectedMemberId.value = memberId;
  manualPassword.value = '';
  latestTemporaryPassword.value = '';
  await loadMemberDetail(memberId);
}

async function resetPassword() {
  if (!detail.value) {
    return;
  }
  if (
    manualPassword.value
    && (
      manualPassword.value.length < 8
      || manualPassword.value.length > 128
      || !/[A-Za-z]/.test(manualPassword.value)
      || !/\d/.test(manualPassword.value)
    )
  ) {
    showError(t('admin.memberResetPasswordInvalid'));
    return;
  }
  if (!window.confirm(t('admin.confirmResetMemberPassword'))) {
    return;
  }
  try {
    const payload = {};
    if (manualPassword.value) {
      payload.newPassword = manualPassword.value;
    }
    const { data } = await api.post(`/admin/members/${detail.value.id}/reset-password`, payload);
    latestTemporaryPassword.value = data.temporaryPassword || '';
    manualPassword.value = '';
    showSuccess(
      t('admin.memberPasswordReset', {
        password: latestTemporaryPassword.value || '-'
      }),
      4200
    );
    await loadMemberDetail(detail.value.id);
  } catch (err) {
    showError(err, t('admin.memberLoadFailed'));
  }
}

async function deleteMember() {
  if (!detail.value) {
    return;
  }
  if (!window.confirm(t('admin.confirmDeleteMember'))) {
    return;
  }
  try {
    await api.delete(`/admin/members/${detail.value.id}`);
    showSuccess(t('admin.memberDeleted'));
    latestTemporaryPassword.value = '';
    manualPassword.value = '';
    selectedMemberId.value = 0;
    detail.value = null;
    await loadMembers();
  } catch (err) {
    showError(err, t('admin.memberLoadFailed'));
  }
}

onMounted(async () => {
  await loadMembers();
});
</script>

<style scoped>
.panel {
  padding: 1rem;
}

.search-row {
  align-items: flex-end;
  margin-bottom: 0.8rem;
}

.search-field {
  min-width: min(380px, 100%);
  flex: 1;
}

.member-list {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
  max-height: 62vh;
  overflow: auto;
  padding-right: 0.2rem;
}

.member-item {
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--panel-soft);
  color: var(--ink);
  text-align: left;
  padding: 0.7rem;
  cursor: pointer;
}

.member-item h3 {
  margin: 0 0 0.2rem;
}

.member-item p {
  margin: 0.1rem 0;
}

.member-item:hover {
  background: #242a31;
}

.member-item.active {
  border-color: var(--accent);
  background: #262d35;
}

.detail-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.7rem;
}

.label {
  display: block;
  font-size: 0.85rem;
  color: var(--muted);
  margin-bottom: 0.15rem;
}

.temporary-password {
  margin-top: 0.8rem;
  padding: 0.65rem 0.75rem;
  border: 1px dashed var(--line);
  border-radius: 10px;
  background: #12161b;
}

.temporary-password p {
  margin: 0 0 0.3rem;
}

.temporary-password code {
  font-size: 0.98rem;
  user-select: all;
}

@media (max-width: 860px) {
  .detail-grid {
    grid-template-columns: 1fr;
  }
}
</style>

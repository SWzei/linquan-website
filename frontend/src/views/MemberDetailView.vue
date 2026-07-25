<template>
  <section class="card panel">
    <router-link class="back" to="/members">{{ t('profile.backToDirectory') }}</router-link>
    <h2 class="section-title">{{ t('profile.memberDetailTitle') }}</h2>

    <div v-if="member" class="detail-wrap">
      <img v-if="member.avatarUrl" :src="member.avatarUrl" :alt="t('profile.memberAvatar', { name: member.displayName || t('profile.member') })" class="avatar" />
      <EmptyImage v-else class="avatar-placeholder" :label="t('profile.noImage')" />
      <div>
        <h3>{{ member.displayName || member.studentNumber }}</h3>
        <p class="subtle">
          {{ member.academy || t('profile.academyUnset') }} · {{ member.major || t('profile.majorUnset') }} ·
          {{ member.grade || t('profile.gradeUnset') }}
        </p>
        <p class="multiline-text">{{ member.bio || t('profile.noIntro') }}</p>
        <p class="multiline-text"><strong>{{ t('profile.hobbies') }}:</strong> {{ member.hobbies || t('profile.notProvided') }}</p>
        <p class="multiline-text"><strong>{{ t('profile.pianoInterests') }}:</strong> {{ member.pianoInterests || t('profile.notProvided') }}</p>
      </div>
      <div v-if="member.photoUrl" class="photo-block">
        <p class="subtle">{{ t('profile.personalPhoto') }}</p>
        <img :src="member.photoUrl" alt="" class="personal-photo" />
      </div>
      <div v-else class="photo-block"><EmptyImage :label="t('profile.noPersonalPhoto')" /></div>
    </div>

    <p v-if="!member && !error" class="subtle">{{ t('common.loading') }}</p>
    <p v-if="error" class="subtle">{{ error }}</p>
  </section>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import api from '@/services/api';
import { useI18n } from '@/i18n';
import { useToast } from '@/composables/toast';
import EmptyImage from '@/components/EmptyImage.vue';

const route = useRoute();
const { t } = useI18n();
const { showError } = useToast();
const member = ref(null);
const error = ref('');

onMounted(async () => {
  try {
    const publicId = String(route.params.publicId || '');
    if (!/^[A-Za-z0-9-]{16,64}$/.test(publicId)) {
      error.value = t('profile.memberNotFound');
      showError(error.value);
      return;
    }
    const { data } = await api.get(`/members/${encodeURIComponent(publicId)}`);
    member.value = data;
  } catch (err) {
    error.value = err?.response?.data?.message || t('profile.memberNotFound');
    showError(error.value);
  }
});
</script>

<style scoped>
.panel {
  padding: 1rem;
}

.back {
  display: inline-flex;
  margin-bottom: 0.7rem;
  color: var(--accent);
  font-weight: 700;
}

.detail-wrap {
  display: grid;
  grid-template-columns: 96px 1fr;
  gap: 0.9rem;
}

.avatar {
  width: 96px;
  height: 96px;
  border-radius: 12px;
  object-fit: cover;
  border: 1px solid var(--line);
}
.avatar-placeholder { width: 96px; min-height: 96px; }

.detail-wrap h3 {
  margin: 0;
}

.detail-wrap p {
  margin: 0.4rem 0 0;
}

.multiline-text {
  white-space: pre-wrap;
}

.photo-block {
  grid-column: 1 / -1;
}

.personal-photo {
  max-width: 280px;
  border-radius: 12px;
  border: 1px solid var(--line);
}
</style>

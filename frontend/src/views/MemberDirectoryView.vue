<template>
  <section class="card panel">
    <h2 class="section-title">{{ t('profile.directoryTitle') }}</h2>
    <div class="field search-field">
      <label for="member-search">{{ t('profile.searchMember') }}</label>
      <input id="member-search" v-model.trim="memberKeyword" :placeholder="t('profile.searchMemberPlaceholder')" />
    </div>

    <ul class="directory">
      <li v-for="item in filteredMembers" :key="item.publicId">
        <router-link class="member-link" :to="{ name: 'memberDetail', params: { publicId: item.publicId } }">
          <img v-if="item.avatarUrl" :src="item.avatarUrl" :alt="t('profile.memberAvatar', { name: item.displayName || t('profile.member') })" />
          <EmptyImage v-else :label="t('profile.noImage')" compact />
          <div>
            <h3>{{ item.displayName || t('profile.member') }}</h3>
            <p class="subtle">
              {{ item.academy || t('profile.academyUnset') }} · {{ item.major || t('profile.majorUnset') }} ·
              {{ item.grade || t('profile.gradeUnset') }}
            </p>
            <p class="multiline-text">{{ item.bio || t('profile.noIntro') }}</p>
          </div>
        </router-link>
      </li>
    </ul>
    <p v-if="filteredMembers.length === 0" class="subtle">{{ t('profile.noProfiles') }}</p>
  </section>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import api from '@/services/api';
import { useI18n } from '@/i18n';
import { useToast } from '@/composables/toast';
import EmptyImage from '@/components/EmptyImage.vue';

const members = ref([]);
const memberKeyword = ref('');
const { t } = useI18n();
const { showError } = useToast();

const filteredMembers = computed(() => {
  const keyword = memberKeyword.value.trim().toLowerCase();
  if (!keyword) {
    return members.value;
  }
  return members.value.filter((item) => {
    const fields = [
      item.displayName,
      item.academy,
      item.major,
      item.grade,
      item.bio,
      item.hobbies,
      item.pianoInterests
    ];
    return fields.some((value) => String(value || '').toLowerCase().includes(keyword));
  });
});

onMounted(async () => {
  try {
    const { data } = await api.get('/members');
    members.value = data.items || [];
  } catch (err) {
    showError(err, t('profile.loadFailed'));
  }
});
</script>

<style scoped>
.panel {
  padding: 1rem;
}

.multiline-text {
  white-space: pre-wrap;
}

.directory {
  list-style: none;
  margin: 0.9rem 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.directory li {
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--panel-soft);
}

.member-link {
  display: grid;
  grid-template-columns: 64px 1fr;
  gap: 0.7rem;
  padding: 0.7rem;
}

.directory img {
  width: 64px;
  height: 64px;
  border-radius: 12px;
  object-fit: cover;
}

.directory h3 {
  margin: 0;
}

.directory p {
  margin: 0.35rem 0 0;
}

.search-field {
  margin-bottom: 0.6rem;
}
</style>

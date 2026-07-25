<template>
  <section class="grid-2">
    <article class="card panel">
      <div class="section-head">
        <div>
          <h2 class="section-title">{{ t('classMatching.title') }}</h2>
          <p class="subtle">{{ t('classMatching.subtitle') }}</p>
        </div>
      </div>

      <div class="field">
        <label>{{ t('classMatching.termSelect') }}</label>
        <select v-model.number="selectedTermId" :disabled="loadingTerms || terms.length === 0">
          <option :value="0">{{ t('common.choose') }}</option>
          <option v-for="item in terms" :key="item.id" :value="item.id">
            {{ item.name }}
          </option>
        </select>
      </div>

      <p v-if="selectedTerm" class="subtle term-note">
        {{
          t('classMatching.termInfo', {
            name: selectedTerm.name,
            start: selectedTerm.startDate,
            end: selectedTerm.endDate
          })
        }}
      </p>
      <p v-else class="subtle term-note">{{ t('classMatching.noTerms') }}</p>

      <article class="base-card" v-if="baseProfile">
        <div class="base-head">
          <img v-if="baseProfile.avatarUrl || baseProfile.photoUrl" class="avatar" :src="baseProfile.avatarUrl || baseProfile.photoUrl" :alt="t('profile.memberAvatar', { name: baseProfile.displayName })" />
          <EmptyImage v-else :label="t('profile.noImage')" compact />
          <div>
            <h3>{{ baseProfile.displayName }}</h3>
            <p class="subtle">{{ baseProfile.studentNumber }}</p>
            <p class="subtle" v-if="baseProfile.academy || baseProfile.major">
              {{ [baseProfile.academy, baseProfile.major].filter(Boolean).join(' · ') }}
            </p>
          </div>
        </div>
        <p class="subtle multiline-text">{{ baseProfile.bio || t('classMatching.baseProfileHint') }}</p>
      </article>

      <article class="status-card" v-if="participantProfile">
        <p class="subtle">
          {{ t('classMatching.currentRole') }}:
          <strong>{{ participantTypeLabel(participantProfile.participantType) }}</strong>
        </p>
        <p class="subtle">
          {{ t('classMatching.currentMode') }}:
          <strong>{{ matchingModeLabel(participantProfile.matchingMode) }}</strong>
        </p>
        <p class="subtle" v-if="participantProfile.participantType === 'teacher'">
          {{ t('classMatching.qualificationStatus') }}:
          <strong :class="qualificationClass(participantProfile.qualificationStatus)">
            {{ qualificationLabel(participantProfile.qualificationStatus) }}
          </strong>
        </p>
        <p class="subtle multiline-text" v-if="participantProfile.qualificationFeedback">
          {{ participantProfile.qualificationFeedback }}
        </p>
      </article>
    </article>

    <article class="card panel">
      <h2 class="section-title">{{ t('classMatching.profileExtensionTitle') }}</h2>
      <p class="subtle">{{ t('classMatching.profileExtensionSubtitle') }}</p>

      <form class="form" @submit.prevent="saveProfile">
        <div class="row">
          <div class="field field-half">
            <label>{{ t('classMatching.participantType') }}</label>
            <select v-model="form.participantType">
              <option value="student">{{ t('classMatching.roleStudent') }}</option>
              <option value="teacher">{{ t('classMatching.roleTeacher') }}</option>
            </select>
          </div>
          <div class="field field-half">
            <label>{{ t('classMatching.matchingMode') }}</label>
            <select v-model="form.matchingMode">
              <option value="direct">{{ t('classMatching.modeDirect') }}</option>
              <option value="ranking">{{ t('classMatching.modeRanking') }}</option>
            </select>
          </div>
        </div>

        <div class="field" v-if="isStudent">
          <label>{{ t('classMatching.skillLevel') }}</label>
          <textarea v-model="form.skillLevel" rows="3" :placeholder="t('classMatching.skillLevelPlaceholder')" />
        </div>
        <div class="field" v-if="isStudent">
          <label>{{ t('classMatching.learningGoals') }}</label>
          <textarea v-model="form.learningGoals" rows="3" :placeholder="t('classMatching.learningGoalsPlaceholder')" />
        </div>
        <div class="field" v-if="isStudent">
          <label>{{ t('classMatching.budgetExpectation') }}</label>
          <input v-model.trim="form.budgetExpectation" :placeholder="t('classMatching.budgetPlaceholder')" />
        </div>

        <div class="field" v-if="isTeacher">
          <label>{{ t('classMatching.teachingExperience') }}</label>
          <textarea
            v-model="form.teachingExperience"
            rows="4"
            :placeholder="t('classMatching.teachingExperiencePlaceholder')"
          />
        </div>
        <div class="field" v-if="isTeacher">
          <label>{{ t('classMatching.skillSpecialization') }}</label>
          <textarea
            v-model="form.skillSpecialization"
            rows="4"
            :placeholder="t('classMatching.skillSpecializationPlaceholder')"
          />
        </div>
        <div class="row" v-if="isTeacher">
          <div class="field field-half">
            <label>{{ t('classMatching.feeExpectation') }}</label>
            <input v-model.trim="form.feeExpectation" :placeholder="t('classMatching.feePlaceholder')" />
          </div>
          <div class="field field-half">
            <label>{{ t('classMatching.capacity') }}</label>
            <input type="number" min="1" max="100" v-model.number="form.capacity" />
          </div>
        </div>

        <div class="field" v-if="form.matchingMode === 'direct'">
          <label>{{ t('classMatching.directTarget') }}</label>
          <select v-model.number="form.directTargetUserId">
            <option :value="0">{{ t('classMatching.directTargetNone') }}</option>
            <option v-for="item in directCandidates" :key="item.userId" :value="item.userId">
              {{ item.displayName }} ({{ item.studentNumber }})
            </option>
          </select>
          <p class="subtle">{{ t('classMatching.directHint') }}</p>
        </div>

        <button class="btn" :disabled="savingProfile || !selectedTermId">
          {{ savingProfile ? t('common.loading') : t('classMatching.saveProfileExtension') }}
        </button>
      </form>
    </article>
  </section>

  <section class="grid-2 section-space" v-if="selectedTermId">
    <article class="card panel">
      <h2 class="section-title">{{ t('classMatching.availabilityTitle') }}</h2>
      <p class="subtle">{{ t('classMatching.availabilitySubtitle') }}</p>

      <div class="days">
        <section v-for="day in days" :key="day.value" class="day-card">
          <h3>{{ day.label }}</h3>
          <ul class="slot-list">
            <li v-for="hour in hours" :key="`${day.value}-${hour}`">
              <label v-if="slotAt(day.value, hour)" class="slot-row">
                <input
                  type="checkbox"
                  :checked="availabilitySlotIds.includes(slotAt(day.value, hour).id)"
                  @change="toggleAvailability(slotAt(day.value, hour).id, $event.target.checked)"
                />
                <span>{{ hourRange(hour) }}</span>
                <span class="subtle">{{ t('classMatching.selectedCount', { count: slotAt(day.value, hour).selectedCount }) }}</span>
              </label>
            </li>
          </ul>
        </section>
      </div>

      <div class="row action-row">
        <span class="subtle">{{ t('classMatching.selectedSlots', { count: availabilitySlotIds.length }) }}</span>
        <button class="btn" :disabled="savingAvailability || !selectedTermId" @click="saveAvailability">
          {{ savingAvailability ? t('common.loading') : t('classMatching.saveAvailability') }}
        </button>
      </div>
    </article>

    <article class="card panel">
      <h2 class="section-title">{{ t('classMatching.preferenceTitle') }}</h2>
      <p class="subtle">{{ preferenceSubtitle }}</p>

      <template v-if="form.matchingMode === 'direct'">
        <div class="direct-box">
          <p class="subtle">{{ t('classMatching.directCurrentTarget') }}</p>
          <strong v-if="selectedDirectCandidate">
            {{ selectedDirectCandidate.displayName }} ({{ selectedDirectCandidate.studentNumber }})
          </strong>
          <strong v-else>{{ t('classMatching.directTargetUnset') }}</strong>
        </div>
      </template>

      <template v-else>
        <div class="field">
          <label>{{ t('classMatching.addRankingTarget') }}</label>
          <div class="row">
            <select v-model.number="rankingCandidateToAdd" class="grow">
              <option :value="0">{{ t('common.choose') }}</option>
              <option v-for="item in availableRankingCandidates" :key="item.userId" :value="item.userId">
                {{ item.displayName }} ({{ item.studentNumber }})
              </option>
            </select>
            <button class="btn secondary" type="button" :disabled="!rankingCandidateToAdd" @click="addRankingTarget">
              {{ t('classMatching.addRankingButton') }}
            </button>
          </div>
        </div>

        <ol class="ranking-list" v-if="rankedCandidates.length">
          <li v-for="(item, index) in rankedCandidates" :key="item.userId" class="ranking-item">
            <div>
              <strong>{{ item.displayName }}</strong>
              <p class="subtle">{{ item.studentNumber }}</p>
            </div>
            <div class="row compact-row">
              <button class="btn secondary compact-btn" type="button" :disabled="index === 0" @click="moveRanking(index, -1)">
                ↑
              </button>
              <button
                class="btn secondary compact-btn"
                type="button"
                :disabled="index === rankedCandidates.length - 1"
                @click="moveRanking(index, 1)"
              >
                ↓
              </button>
              <button class="btn warn compact-btn" type="button" @click="removeRanking(index)">
                {{ t('classMatching.removeRankingButton') }}
              </button>
            </div>
          </li>
        </ol>
        <p v-else class="subtle">{{ t('classMatching.noRankings') }}</p>

        <button class="btn" :disabled="savingRankings || !selectedTermId" @click="saveRankings">
          {{ savingRankings ? t('common.loading') : t('classMatching.saveRankings') }}
        </button>
      </template>
    </article>
  </section>

  <section class="card panel section-space" v-if="selectedTermId">
    <div class="section-head">
      <div>
        <h2 class="section-title">{{ t('classMatching.currentResultTitle') }}</h2>
        <p class="subtle" v-if="overview.currentVersion">
          {{
            t('classMatching.currentVersionInfo', {
              version: overview.currentVersion.versionNumber,
              source: versionSourceLabel(overview.currentVersion.sourceType)
            })
          }}
        </p>
      </div>
    </div>

    <table v-if="overview.matches?.length" class="result-table">
      <thead>
        <tr>
          <th>{{ t('classMatching.resultStudent') }}</th>
          <th>{{ t('classMatching.resultTeacher') }}</th>
          <th>{{ t('classMatching.resultRoomTime') }}</th>
          <th>{{ t('classMatching.resultType') }}</th>
          <th>{{ t('classMatching.resultScore') }}</th>
          <th>{{ t('common.note') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in overview.matches" :key="item.id">
          <td>{{ item.studentName }} ({{ item.studentNumber }})</td>
          <td>{{ item.teacherName }} ({{ item.teacherNumber }})</td>
          <td>{{ formatRoomTime(item) }}</td>
          <td>
            <span class="type-pill" :class="`type-${item.matchType}`">
              {{ matchTypeLabel(item.matchType) }}
            </span>
          </td>
          <td>{{ formatScore(item.matchingScore) }}</td>
          <td class="multiline-text">{{ item.notes || item.adminComment || '—' }}</td>
        </tr>
      </tbody>
    </table>
    <p v-else class="subtle">{{ t('classMatching.noResults') }}</p>
  </section>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue';
import api from '@/services/api';
import { useI18n } from '@/i18n';
import { useToast } from '@/composables/toast';
import EmptyImage from '@/components/EmptyImage.vue';

const { t } = useI18n();
const { showSuccess, showError } = useToast();

const days = computed(() => [
  { value: 0, label: t('day.sunShort') },
  { value: 1, label: t('day.monShort') },
  { value: 2, label: t('day.tueShort') },
  { value: 3, label: t('day.wedShort') },
  { value: 4, label: t('day.thuShort') },
  { value: 5, label: t('day.friShort') },
  { value: 6, label: t('day.satShort') }
]);
const hours = Array.from({ length: 14 }, (_, index) => 8 + index);

const terms = ref([]);
const selectedTermId = ref(0);
const loadingTerms = ref(false);
const loadingOverview = ref(false);
const savingProfile = ref(false);
const savingAvailability = ref(false);
const savingRankings = ref(false);
const rankingCandidateToAdd = ref(0);

const overview = reactive({
  term: null,
  baseProfile: null,
  participantProfile: null,
  slots: [],
  availabilitySlotIds: [],
  rankingTargetUserIds: [],
  candidates: {
    teacherCandidates: [],
    studentCandidates: []
  },
  currentVersion: null,
  matches: []
});

const form = reactive({
  participantType: 'student',
  matchingMode: 'ranking',
  skillLevel: '',
  learningGoals: '',
  budgetExpectation: '',
  teachingExperience: '',
  skillSpecialization: '',
  feeExpectation: '',
  capacity: 1,
  directTargetUserId: 0
});

const availabilitySlotIds = ref([]);
const rankingTargetUserIds = ref([]);

const selectedTerm = computed(() => overview.term || terms.value.find((item) => item.id === selectedTermId.value) || null);
const baseProfile = computed(() => overview.baseProfile || null);
const participantProfile = computed(() => overview.participantProfile || null);
const isStudent = computed(() => form.participantType === 'student');
const isTeacher = computed(() => form.participantType === 'teacher');
const slotMap = computed(() => {
  const map = new Map();
  for (const slot of overview.slots || []) {
    map.set(`${slot.dayOfWeek}-${slot.hour}`, slot);
  }
  return map;
});
const candidateList = computed(() =>
  isStudent.value ? overview.candidates.teacherCandidates || [] : overview.candidates.studentCandidates || []
);
const rankingCandidateList = computed(() =>
  candidateList.value.filter((item) => item.matchingMode === 'ranking')
);
const candidateMap = computed(() => {
  const map = new Map();
  for (const item of candidateList.value) {
    map.set(item.userId, item);
  }
  return map;
});
const rankingCandidateMap = computed(() => {
  const map = new Map();
  for (const item of rankingCandidateList.value) {
    map.set(item.userId, item);
  }
  return map;
});
const directCandidates = computed(() => candidateList.value);
const availableRankingCandidates = computed(() =>
  rankingCandidateList.value.filter((item) => !rankingTargetUserIds.value.includes(item.userId))
);
const rankedCandidates = computed(() =>
  rankingTargetUserIds.value.map((userId) => rankingCandidateMap.value.get(userId)).filter(Boolean)
);
const selectedDirectCandidate = computed(() => candidateMap.value.get(Number(form.directTargetUserId || 0)) || null);
const preferenceSubtitle = computed(() =>
  form.matchingMode === 'direct' ? t('classMatching.directSubtitle') : t('classMatching.rankingSubtitle')
);

function resetForm(profile = null) {
  form.participantType = profile?.participantType || 'student';
  form.matchingMode = profile?.matchingMode || 'ranking';
  form.skillLevel = profile?.skillLevel || '';
  form.learningGoals = profile?.learningGoals || '';
  form.budgetExpectation = profile?.budgetExpectation || '';
  form.teachingExperience = profile?.teachingExperience || '';
  form.skillSpecialization = profile?.skillSpecialization || '';
  form.feeExpectation = profile?.feeExpectation || '';
  form.capacity = Number(profile?.capacity || 1);
  form.directTargetUserId = Number(profile?.directTargetUserId || 0);
}

function slotAt(day, hour) {
  return slotMap.value.get(`${day}-${hour}`) || null;
}

function toggleAvailability(slotId, checked) {
  if (checked) {
    if (!availabilitySlotIds.value.includes(slotId)) {
      availabilitySlotIds.value = [...availabilitySlotIds.value, slotId];
    }
    return;
  }
  availabilitySlotIds.value = availabilitySlotIds.value.filter((item) => item !== slotId);
}

function moveRanking(index, offset) {
  const nextIndex = index + offset;
  if (nextIndex < 0 || nextIndex >= rankingTargetUserIds.value.length) {
    return;
  }
  const next = [...rankingTargetUserIds.value];
  const [target] = next.splice(index, 1);
  next.splice(nextIndex, 0, target);
  rankingTargetUserIds.value = next;
}

function removeRanking(index) {
  rankingTargetUserIds.value = rankingTargetUserIds.value.filter((_, itemIndex) => itemIndex !== index);
}

function addRankingTarget() {
  if (!rankingCandidateToAdd.value) {
    return;
  }
  rankingTargetUserIds.value = [...rankingTargetUserIds.value, rankingCandidateToAdd.value];
  rankingCandidateToAdd.value = 0;
}

function hourRange(hour) {
  return `${String(hour).padStart(2, '0')}:00 - ${String(hour + 1).padStart(2, '0')}:00`;
}

function participantTypeLabel(type) {
  return t(type === 'teacher' ? 'classMatching.roleTeacher' : 'classMatching.roleStudent');
}

function matchingModeLabel(mode) {
  return t(mode === 'direct' ? 'classMatching.modeDirect' : 'classMatching.modeRanking');
}

function qualificationLabel(status) {
  return t(`classMatching.qualification${status?.[0]?.toUpperCase?.() || ''}${status?.slice?.(1) || ''}`);
}

function qualificationClass(status) {
  return {
    approved: status === 'approved',
    rejected: status === 'rejected'
  };
}

function versionSourceLabel(sourceType) {
  return t(`classMatching.versionSource.${sourceType}`) || sourceType;
}

function matchTypeLabel(matchType) {
  return t(`classMatching.matchType.${matchType}`) || matchType;
}

function formatRoomTime(item) {
  if (!item?.roomSlotId) {
    return t('classMatching.roomTimePending');
  }
  const dayKey = ['sunShort', 'monShort', 'tueShort', 'wedShort', 'thuShort', 'friShort', 'satShort'][item.dayOfWeek];
  return t('classMatching.roomTimeFormat', {
    room: item.roomNo,
    day: t(`day.${dayKey}`),
    hour: item.hour
  });
}

function formatScore(value) {
  return Number(value || 0).toFixed(1);
}

async function loadTerms() {
  loadingTerms.value = true;
  try {
    const { data } = await api.get('/class-matching/terms');
    terms.value = data.items || [];
    if (!terms.value.length) {
      selectedTermId.value = 0;
      return;
    }
    if (!terms.value.some((item) => item.id === selectedTermId.value)) {
      selectedTermId.value = Number(data.currentTermId || terms.value[0].id || 0);
    }
  } finally {
    loadingTerms.value = false;
  }
}

async function loadOverview() {
  if (!selectedTermId.value) {
    overview.term = null;
    overview.baseProfile = null;
    overview.participantProfile = null;
    overview.slots = [];
    overview.availabilitySlotIds = [];
    overview.rankingTargetUserIds = [];
    overview.candidates = { teacherCandidates: [], studentCandidates: [] };
    overview.currentVersion = null;
    overview.matches = [];
    availabilitySlotIds.value = [];
    rankingTargetUserIds.value = [];
    resetForm();
    return;
  }

  loadingOverview.value = true;
  try {
    const { data } = await api.get('/class-matching/overview', {
      params: { termId: selectedTermId.value }
    });
    overview.term = data.term || null;
    overview.baseProfile = data.baseProfile || null;
    overview.participantProfile = data.participantProfile || null;
    overview.slots = data.slots || [];
    overview.availabilitySlotIds = data.availabilitySlotIds || [];
    overview.rankingTargetUserIds = data.rankingTargetUserIds || [];
    overview.candidates = data.candidates || { teacherCandidates: [], studentCandidates: [] };
    overview.currentVersion = data.currentVersion || null;
    overview.matches = data.matches || [];
    availabilitySlotIds.value = [...overview.availabilitySlotIds];
    rankingTargetUserIds.value = [...overview.rankingTargetUserIds];
    resetForm(overview.participantProfile);
    rankingCandidateToAdd.value = 0;
  } finally {
    loadingOverview.value = false;
  }
}

async function saveProfile() {
  if (!selectedTermId.value) {
    showError(t('classMatching.noTerms'));
    return;
  }
  savingProfile.value = true;
  try {
    await api.put('/class-matching/profile', {
      termId: selectedTermId.value,
      participantType: form.participantType,
      matchingMode: form.matchingMode,
      skillLevel: isStudent.value ? form.skillLevel : null,
      learningGoals: isStudent.value ? form.learningGoals : null,
      budgetExpectation: isStudent.value ? form.budgetExpectation : null,
      teachingExperience: isTeacher.value ? form.teachingExperience : null,
      skillSpecialization: isTeacher.value ? form.skillSpecialization : null,
      feeExpectation: isTeacher.value ? form.feeExpectation : null,
      capacity: isTeacher.value ? Number(form.capacity || 1) : null,
      directTargetUserId: form.matchingMode === 'direct' ? Number(form.directTargetUserId || 0) || null : null
    });
    showSuccess(t('classMatching.profileSaved'));
    await loadOverview();
  } catch (err) {
    showError(err, t('classMatching.profileSaveFailed'));
  } finally {
    savingProfile.value = false;
  }
}

async function saveAvailability() {
  if (!selectedTermId.value) {
    return;
  }
  savingAvailability.value = true;
  try {
    await api.post('/class-matching/availability', {
      termId: selectedTermId.value,
      slotIds: availabilitySlotIds.value
    });
    showSuccess(t('classMatching.availabilitySaved'));
    await loadOverview();
  } catch (err) {
    showError(err, t('classMatching.availabilitySaveFailed'));
  } finally {
    savingAvailability.value = false;
  }
}

async function saveRankings() {
  if (!selectedTermId.value) {
    return;
  }
  savingRankings.value = true;
  try {
    await api.post('/class-matching/rankings', {
      termId: selectedTermId.value,
      targetUserIds: rankingTargetUserIds.value
    });
    showSuccess(t('classMatching.rankingsSaved'));
    await loadOverview();
  } catch (err) {
    showError(err, t('classMatching.rankingsSaveFailed'));
  } finally {
    savingRankings.value = false;
  }
}

watch(selectedTermId, async () => {
  try {
    await loadOverview();
  } catch (err) {
    showError(err, t('classMatching.loadFailed'));
  }
});

watch(
  () => form.participantType,
  () => {
    rankingCandidateToAdd.value = 0;
    if (form.matchingMode === 'direct' && form.directTargetUserId && !candidateMap.value.has(Number(form.directTargetUserId))) {
      form.directTargetUserId = 0;
    }
    rankingTargetUserIds.value = rankingTargetUserIds.value.filter((item) => rankingCandidateMap.value.has(item));
  }
);

watch(
  () => form.matchingMode,
  (mode) => {
    if (mode === 'direct') {
      rankingCandidateToAdd.value = 0;
      return;
    }
    rankingTargetUserIds.value = rankingTargetUserIds.value.filter((item) => rankingCandidateMap.value.has(item));
  }
);

onMounted(async () => {
  try {
    await loadTerms();
    await loadOverview();
  } catch (err) {
    showError(err, t('classMatching.loadFailed'));
  }
});
</script>

<style scoped>
.panel {
  padding: 1rem;
}

.section-space {
  margin-top: 1rem;
}

.section-head {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
  align-items: flex-start;
}

.term-note {
  margin-top: 0.6rem;
}

.form {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.field-half {
  flex: 1;
}

.base-card,
.status-card,
.direct-box {
  margin-top: 0.9rem;
  padding: 0.85rem;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--panel-soft);
}

.base-head {
  display: flex;
  gap: 0.85rem;
  align-items: center;
}

.base-head h3 {
  margin: 0;
}

.avatar {
  width: 3.25rem;
  height: 3.25rem;
  border-radius: 12px;
  object-fit: cover;
  border: 1px solid var(--line);
}

.days {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.75rem;
}

.day-card {
  padding: 0.75rem;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--panel-soft);
}

.day-card h3 {
  margin: 0 0 0.55rem;
}

.slot-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.slot-row {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 0.5rem;
  align-items: center;
  font-size: 0.9rem;
}

.action-row {
  margin-top: 0.85rem;
  align-items: center;
  justify-content: space-between;
}

.grow {
  flex: 1;
}

.ranking-list {
  margin: 0.75rem 0;
  padding-left: 1.1rem;
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
}

.ranking-item {
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--panel-soft);
  padding: 0.7rem 0.85rem;
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
  align-items: center;
}

.ranking-item p {
  margin: 0.25rem 0 0;
}

.compact-row {
  gap: 0.4rem;
  align-items: center;
}

.compact-btn {
  min-width: 2.4rem;
  padding-inline: 0.7rem;
}

.result-table td {
  vertical-align: top;
}

.type-pill {
  display: inline-flex;
  padding: 0.18rem 0.5rem;
  border-radius: 999px;
  font-size: 0.78rem;
  font-weight: 700;
  border: 1px solid var(--line);
  background: #232831;
}

.type-locked {
  border-color: rgba(177, 208, 255, 0.45);
}

.type-algorithm {
  border-color: rgba(255, 255, 255, 0.24);
}

.type-manual {
  border-color: rgba(255, 201, 138, 0.45);
}

.approved {
  color: #90d4a7;
}

.rejected {
  color: #d58a8a;
}

.multiline-text {
  white-space: pre-wrap;
}

@media (max-width: 960px) {
  .days {
    grid-template-columns: 1fr;
  }

  .ranking-item {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>

<template>
  <section class="grid-2">
    <article class="card panel">
      <h2 class="section-title">{{ t('adminClassMatching.termTitle') }}</h2>
      <p class="subtle">{{ t('adminClassMatching.termSubtitle') }}</p>

      <div class="field">
        <label>{{ t('adminClassMatching.termSelect') }}</label>
        <select v-model.number="selectedTermId" :disabled="loadingTerms || terms.length === 0">
          <option :value="0">{{ t('common.choose') }}</option>
          <option v-for="item in terms" :key="item.id" :value="item.id">
            {{ item.name }}
          </option>
        </select>
      </div>

      <div class="term-list" v-if="terms.length">
        <button
          v-for="item in terms"
          :key="item.id"
          type="button"
          class="term-chip"
          :class="{ active: item.id === selectedTermId }"
          @click="selectedTermId = item.id"
        >
          <span>{{ item.name }}</span>
          <span class="subtle">{{ item.isActive ? t('adminClassMatching.activeTermBadge') : item.startDate }}</span>
        </button>
      </div>

      <form class="form section-space" @submit.prevent="submitTerm">
        <div class="field">
          <label for="class-term-semester">{{ t('adminClassMatching.inventorySemester') }}</label>
          <select id="class-term-semester" v-model.number="termForm.semesterId" required>
            <option :value="0" disabled>{{ t('common.choose') }}</option>
            <option v-for="semester in semesters" :key="semester.id" :value="semester.id">
              {{ semester.name }}
            </option>
          </select>
          <span class="subtle">{{ t('adminClassMatching.inventorySemesterHint') }}</span>
        </div>
        <div class="field">
          <label>{{ t('adminClassMatching.termName') }}</label>
          <input v-model.trim="termForm.name" required />
        </div>
        <div class="row">
          <div class="field field-half">
            <label>{{ t('adminClassMatching.termStart') }}</label>
            <input type="date" v-model="termForm.startDate" required />
          </div>
          <div class="field field-half">
            <label>{{ t('adminClassMatching.termEnd') }}</label>
            <input type="date" v-model="termForm.endDate" required />
          </div>
        </div>
        <label class="toggle">
          <input type="checkbox" v-model="termForm.activate" />
          {{ t('adminClassMatching.termActivate') }}
        </label>
        <div class="row">
          <button class="btn" :disabled="savingTerm">
            {{ savingTerm ? t('common.loading') : termSubmitLabel }}
          </button>
          <button class="btn secondary" type="button" :disabled="savingTerm" @click="resetTermForm">
            {{ t('adminClassMatching.resetTermForm') }}
          </button>
          <button class="btn warn" type="button" :disabled="!selectedTermId || deletingTerm" @click="removeTerm">
            {{ deletingTerm ? t('common.loading') : t('adminClassMatching.deleteTerm') }}
          </button>
        </div>
      </form>
    </article>

    <article class="card panel">
      <div class="section-head">
        <div>
          <h2 class="section-title">{{ t('adminClassMatching.summaryTitle') }}</h2>
          <p class="subtle" v-if="overview.term">
            {{
              t('adminClassMatching.summaryTermInfo', {
                name: overview.term.name,
                start: overview.term.startDate,
                end: overview.term.endDate
              })
            }}
          </p>
          <p class="subtle" v-else>{{ t('adminClassMatching.noTermSelected') }}</p>
        </div>
      </div>

      <div class="summary-grid" v-if="overview.summary">
        <article class="summary-box">
          <strong>{{ overview.summary.participantCount }}</strong>
          <span>{{ t('adminClassMatching.summaryParticipants') }}</span>
        </article>
        <article class="summary-box">
          <strong>{{ overview.summary.studentCount }}</strong>
          <span>{{ t('adminClassMatching.summaryStudents') }}</span>
        </article>
        <article class="summary-box">
          <strong>{{ overview.summary.teacherCount }}</strong>
          <span>{{ t('adminClassMatching.summaryTeachers') }}</span>
        </article>
        <article class="summary-box">
          <strong>{{ overview.summary.approvedTeacherCount }}</strong>
          <span>{{ t('adminClassMatching.summaryApprovedTeachers') }}</span>
        </article>
        <article class="summary-box">
          <strong>{{ overview.summary.matchedStudentCount }}</strong>
          <span>{{ t('adminClassMatching.summaryMatchedStudents') }}</span>
        </article>
        <article class="summary-box" v-if="overview.currentVersion">
          <strong>v{{ overview.currentVersion.versionNumber }}</strong>
          <span>{{ versionSourceLabel(overview.currentVersion.sourceType) }}</span>
        </article>
      </div>

      <div class="row action-row" v-if="selectedTermId">
        <button class="btn" :disabled="processingAction" @click="generateMatches">
          {{ generating ? t('common.loading') : t('adminClassMatching.generateMatches') }}
        </button>
        <button class="btn secondary" :disabled="processingAction" @click="incrementalMatchesRun">
          {{ incrementalSaving ? t('common.loading') : t('adminClassMatching.incrementalMatches') }}
        </button>
        <button class="btn secondary" :disabled="processingAction || !overview.currentVersion" @click="exportCurrentCsv">
          {{ exportingCsv ? t('common.loading') : t('adminClassMatching.exportCsv') }}
        </button>
      </div>
    </article>
  </section>

  <section class="grid-2 section-space" v-if="selectedTermId">
    <article class="card panel">
      <h2 class="section-title">{{ t('adminClassMatching.teacherReviewTitle') }}</h2>
      <p class="subtle">{{ t('adminClassMatching.teacherReviewSubtitle') }}</p>

      <div v-if="teacherProfiles.length" class="teacher-review-list">
        <div class="pager-row">
          <button class="btn secondary" type="button" :disabled="teacherReviewIndex === 0" @click="shiftTeacherReview(-1)">
            {{ t('adminClassMatching.reviewPrevious') }}
          </button>
          <p class="subtle">{{ t('adminClassMatching.reviewProgress', { current: teacherReviewIndex + 1, total: teacherProfiles.length }) }}</p>
          <button
            class="btn secondary"
            type="button"
            :disabled="teacherReviewIndex >= teacherProfiles.length - 1"
            @click="shiftTeacherReview(1)"
          >
            {{ t('adminClassMatching.reviewNext') }}
          </button>
        </div>

        <article v-if="activeTeacherProfile" :key="activeTeacherProfile.userId" class="teacher-card">
          <div class="teacher-head">
            <div>
              <h3>{{ activeTeacherProfile.displayName }} ({{ activeTeacherProfile.studentNumber }})</h3>
              <p class="subtle multiline-text">{{ activeTeacherProfile.skillSpecialization || t('adminClassMatching.noSpecialization') }}</p>
            </div>
            <span class="status-pill" :class="qualificationClass(qualificationDrafts[activeTeacherProfile.userId]?.status || activeTeacherProfile.qualificationStatus)">
              {{ qualificationLabel(qualificationDrafts[activeTeacherProfile.userId]?.status || activeTeacherProfile.qualificationStatus) }}
            </span>
          </div>
          <p class="subtle multiline-text">{{ activeTeacherProfile.teachingExperience || t('adminClassMatching.noTeachingExperience') }}</p>
          <div class="row">
            <div class="field field-half">
              <label>{{ t('common.status') }}</label>
              <select v-model="qualificationDrafts[activeTeacherProfile.userId].status">
                <option value="pending">{{ qualificationLabel('pending') }}</option>
                <option value="approved">{{ qualificationLabel('approved') }}</option>
                <option value="rejected">{{ qualificationLabel('rejected') }}</option>
              </select>
            </div>
            <div class="field field-half">
              <label>{{ t('adminClassMatching.teacherCapacity') }}</label>
              <input :value="activeTeacherProfile.capacity || 1" readonly />
            </div>
          </div>
          <div class="field">
            <label>{{ t('common.feedback') }}</label>
            <textarea v-model="qualificationDrafts[activeTeacherProfile.userId].feedback" rows="3" />
          </div>
          <button class="btn" :disabled="qualificationSavingUserId === activeTeacherProfile.userId" @click="saveQualification(activeTeacherProfile)">
            {{ qualificationSavingUserId === activeTeacherProfile.userId ? t('common.loading') : t('adminClassMatching.saveQualification') }}
          </button>
        </article>
      </div>
      <p v-else class="subtle">{{ t('adminClassMatching.noTeacherProfiles') }}</p>
    </article>

    <article class="card panel">
      <h2 class="section-title">{{ t('adminClassMatching.manualTitle') }}</h2>
      <p class="subtle">{{ t('adminClassMatching.manualSubtitle') }}</p>

      <form class="form" @submit.prevent="submitManualAdjustment">
        <div class="field">
          <label>{{ t('adminClassMatching.manualStudent') }}</label>
          <select v-model.number="manualForm.studentUserId">
            <option :value="0">{{ t('common.choose') }}</option>
            <option v-for="item in studentOptions" :key="item.userId" :value="item.userId">
              {{ item.displayName }} ({{ item.studentNumber }}){{ lockedStudentIds.has(item.userId) ? ` · ${t('adminClassMatching.lockedBadge')}` : '' }}
            </option>
          </select>
        </div>
        <div class="field">
          <label>{{ t('adminClassMatching.manualTeacher') }}</label>
          <select v-model.number="manualForm.teacherUserId">
            <option :value="0">{{ t('adminClassMatching.manualClearMatch') }}</option>
            <option v-for="item in approvedTeacherOptions" :key="item.userId" :value="item.userId">
              {{ item.displayName }} ({{ item.studentNumber }}) · {{ t('adminClassMatching.teacherCapacityUsage', {
                current: teacherLoadMap.get(item.userId) || 0,
                capacity: item.capacity || 1
              }) }}
            </option>
          </select>
        </div>
        <p class="subtle">{{ t('adminClassMatching.manualTeacherHint') }}</p>
        <p class="subtle" v-if="selectedManualMatch">
          {{
            t('adminClassMatching.manualCurrentMatch', {
              student: selectedManualMatch.studentName,
              teacher: selectedManualMatch.teacherName,
              type: matchTypeLabel(selectedManualMatch.matchType)
            })
          }}
        </p>
        <p class="subtle warn-text" v-if="selectedManualMatch?.matchType === 'locked' && !manualForm.teacherUserId">
          {{ t('adminClassMatching.manualLockedRule') }}
        </p>
        <p class="subtle" v-else-if="selectedManualMatch?.matchType === 'locked' && manualForm.teacherUserId">
          {{ t('adminClassMatching.manualLockedOverride') }}
        </p>
        <div class="field">
          <label>{{ t('common.note') }}</label>
          <textarea v-model="manualForm.notes" rows="3" />
        </div>
        <div class="field">
          <label>{{ t('adminClassMatching.changeSummary') }}</label>
          <input v-model.trim="manualForm.changeSummary" :placeholder="t('adminClassMatching.manualSummaryPlaceholder')" />
        </div>
        <button class="btn" :disabled="manualSaving || !manualForm.studentUserId">
          {{ manualSaving ? t('common.loading') : t('adminClassMatching.saveManualAdjustment') }}
        </button>
      </form>

      <article class="compare-box section-space">
        <h3>{{ t('adminClassMatching.compareTitle') }}</h3>
        <div class="row">
          <div class="field field-half">
            <label>{{ t('adminClassMatching.compareFrom') }}</label>
            <select v-model.number="compareFromVersionId">
              <option :value="0">{{ t('common.choose') }}</option>
              <option v-for="item in overview.versions" :key="item.id" :value="item.id">v{{ item.versionNumber }}</option>
            </select>
          </div>
          <div class="field field-half">
            <label>{{ t('adminClassMatching.compareTo') }}</label>
            <select v-model.number="compareToVersionId">
              <option :value="0">{{ t('common.choose') }}</option>
              <option v-for="item in overview.versions" :key="item.id" :value="item.id">v{{ item.versionNumber }}</option>
            </select>
          </div>
        </div>
        <button class="btn secondary" :disabled="!compareFromVersionId || !compareToVersionId || comparingVersions" @click="compareVersionsRun">
          {{ comparingVersions ? t('common.loading') : t('adminClassMatching.compareButton') }}
        </button>

        <div v-if="compareResult" class="compare-result">
          <p class="subtle">
            {{
              t('adminClassMatching.compareSummary', {
                added: compareResult.added.length,
                removed: compareResult.removed.length,
                changed: compareResult.changed.length
              })
            }}
          </p>
          <ul class="diff-list">
            <li v-for="item in compareResult.added" :key="`added-${item.studentUserId}`">
              + {{ item.studentName }} → {{ item.teacherName }}
            </li>
            <li v-for="item in compareResult.removed" :key="`removed-${item.studentUserId}`">
              - {{ item.studentName }} → {{ item.teacherName }}
            </li>
            <li v-for="item in compareResult.changed" :key="`changed-${item.studentUserId}`">
              * {{ item.studentName }}: {{ item.from.teacherName }} → {{ item.to.teacherName }}
            </li>
          </ul>
        </div>
      </article>
    </article>
  </section>

  <section class="grid-2 section-space" v-if="selectedTermId">
    <article class="card panel">
      <h2 class="section-title">{{ t('adminClassMatching.matchTableTitle') }}</h2>
      <p class="subtle">{{ t('adminClassMatching.matchTableSubtitle') }}</p>
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
              <span class="type-pill" :class="`type-${item.matchType}`">{{ matchTypeLabel(item.matchType) }}</span>
            </td>
            <td>{{ Number(item.matchingScore || 0).toFixed(1) }}</td>
            <td class="multiline-text">{{ item.notes || item.adminComment || '—' }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="subtle">{{ t('adminClassMatching.noMatches') }}</p>
    </article>

    <article class="card panel">
      <h2 class="section-title">{{ t('adminClassMatching.versionTitle') }}</h2>
      <p class="subtle">{{ t('adminClassMatching.versionSubtitle') }}</p>

      <div v-if="overview.versions?.length" class="version-list">
        <div class="pager-row">
          <button class="btn secondary" type="button" :disabled="versionHistoryIndex === 0" @click="shiftVersionHistory(-1)">
            {{ t('adminClassMatching.versionPrevious') }}
          </button>
          <p class="subtle">{{ t('adminClassMatching.versionProgress', { current: versionHistoryIndex + 1, total: overview.versions.length }) }}</p>
          <button
            class="btn secondary"
            type="button"
            :disabled="versionHistoryIndex >= overview.versions.length - 1"
            @click="shiftVersionHistory(1)"
          >
            {{ t('adminClassMatching.versionNext') }}
          </button>
        </div>

        <article v-if="activeVersion" :key="activeVersion.id" class="version-card">
          <div class="version-head">
            <div>
              <h3>v{{ activeVersion.versionNumber }}</h3>
              <p class="subtle">
                {{ versionSourceLabel(activeVersion.sourceType) }} · {{ activeVersion.createdAt }}
              </p>
            </div>
            <span v-if="activeVersion.isCurrent" class="current-badge">{{ t('adminClassMatching.currentVersionBadge') }}</span>
          </div>
          <p class="subtle multiline-text">{{ activeVersion.changeSummary || t('adminClassMatching.noSummary') }}</p>
          <p class="subtle">{{ t('adminClassMatching.versionMatchCount', { count: activeVersion.matchCount }) }}</p>
          <div class="row">
            <button class="btn secondary" :disabled="restoringVersionId === activeVersion.id" @click="restoreVersionRun(activeVersion.id)">
              {{ restoringVersionId === activeVersion.id ? t('common.loading') : t('adminClassMatching.restoreVersion') }}
            </button>
            <button class="btn secondary" :disabled="exportingVersionId === activeVersion.id" @click="exportSpecificCsv(activeVersion.id)">
              {{ exportingVersionId === activeVersion.id ? t('common.loading') : t('adminClassMatching.exportThisVersion') }}
            </button>
          </div>
        </article>
      </div>
      <p v-else class="subtle">{{ t('adminClassMatching.noVersions') }}</p>
    </article>
  </section>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue';
import api from '@/services/api';
import { useI18n } from '@/i18n';
import { useToast } from '@/composables/toast';

const { t } = useI18n();
const { showSuccess, showError } = useToast();

const terms = ref([]);
const semesters = ref([]);
const selectedTermId = ref(0);
const loadingTerms = ref(false);
const loadingOverview = ref(false);
const savingTerm = ref(false);
const deletingTerm = ref(false);
const generating = ref(false);
const incrementalSaving = ref(false);
const manualSaving = ref(false);
const qualificationSavingUserId = ref(0);
const comparingVersions = ref(false);
const restoringVersionId = ref(0);
const exportingCsv = ref(false);
const exportingVersionId = ref(0);

const termForm = reactive({
  semesterId: 0,
  name: '',
  startDate: '',
  endDate: '',
  activate: true
});

const overview = reactive({
  term: null,
  profiles: [],
  qualificationQueue: [],
  currentVersion: null,
  matches: [],
  versions: [],
  slots: [],
  summary: null
});

const qualificationDrafts = reactive({});
const manualForm = reactive({
  studentUserId: 0,
  teacherUserId: 0,
  notes: '',
  changeSummary: ''
});
const compareFromVersionId = ref(0);
const compareToVersionId = ref(0);
const compareResult = ref(null);
const teacherReviewIndex = ref(0);
const versionHistoryIndex = ref(0);

const teacherProfiles = computed(() => overview.qualificationQueue || []);
const activeTeacherProfile = computed(() => teacherProfiles.value[teacherReviewIndex.value] || null);
const studentOptions = computed(() =>
  (overview.profiles || []).filter((item) => item.participantType === 'student')
);
const approvedTeacherOptions = computed(() =>
  (overview.profiles || []).filter(
    (item) =>
      item.participantType === 'teacher'
      && item.qualificationStatus === 'approved'
      && item.matchingMode !== 'direct'
  )
);
const lockedStudentIds = computed(
  () => new Set((overview.matches || []).filter((item) => item.matchType === 'locked').map((item) => item.studentUserId))
);
const activeVersion = computed(() => (overview.versions || [])[versionHistoryIndex.value] || null);
const selectedManualMatch = computed(
  () => (overview.matches || []).find((item) => item.studentUserId === manualForm.studentUserId) || null
);
const teacherLoadMap = computed(() => {
  const map = new Map();
  for (const item of overview.matches || []) {
    map.set(item.teacherUserId, (map.get(item.teacherUserId) || 0) + 1);
  }
  return map;
});
const termSubmitLabel = computed(() =>
  selectedTermId.value ? t('adminClassMatching.updateTerm') : t('adminClassMatching.createTerm')
);
const processingAction = computed(
  () => loadingOverview.value || generating.value || incrementalSaving.value || exportingCsv.value
);

function qualificationClass(status) {
  return {
    approved: status === 'approved',
    rejected: status === 'rejected'
  };
}

function qualificationLabel(status) {
  return t(`classMatching.qualification${status?.[0]?.toUpperCase?.() || ''}${status?.slice?.(1) || ''}`);
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

function clampIndex(value, length) {
  if (!length) {
    return 0;
  }
  return Math.min(Math.max(Number(value || 0), 0), length - 1);
}

function shiftTeacherReview(direction) {
  teacherReviewIndex.value = clampIndex(teacherReviewIndex.value + direction, teacherProfiles.value.length);
}

function shiftVersionHistory(direction) {
  versionHistoryIndex.value = clampIndex(versionHistoryIndex.value + direction, overview.versions.length);
}

function resetOverview() {
  overview.term = null;
  overview.profiles = [];
  overview.qualificationQueue = [];
  overview.currentVersion = null;
  overview.matches = [];
  overview.versions = [];
  overview.slots = [];
  overview.summary = null;
  compareResult.value = null;
  teacherReviewIndex.value = 0;
  versionHistoryIndex.value = 0;
}

function fillQualificationDrafts() {
  Object.keys(qualificationDrafts).forEach((key) => {
    delete qualificationDrafts[key];
  });
  for (const teacher of teacherProfiles.value) {
    qualificationDrafts[teacher.userId] = {
      status: teacher.qualificationStatus,
      feedback: teacher.qualificationFeedback || ''
    };
  }
}

function syncTermFormFromSelected() {
  const selected = terms.value.find((item) => item.id === selectedTermId.value);
  if (!selected) {
    termForm.semesterId = Number(semesters.value.find((item) => item.isActive)?.id || semesters.value[0]?.id || 0);
    termForm.name = '';
    termForm.startDate = '';
    termForm.endDate = '';
    termForm.activate = true;
    return;
  }
  termForm.semesterId = Number(selected.semesterId || 0);
  termForm.name = selected.name || '';
  termForm.startDate = selected.startDate || '';
  termForm.endDate = selected.endDate || '';
  termForm.activate = Boolean(selected.isActive);
}

async function loadTerms() {
  loadingTerms.value = true;
  try {
    const [termsResponse, semestersResponse] = await Promise.all([
      api.get('/admin/class-matching/terms'),
      api.get('/admin/semesters')
    ]);
    const data = termsResponse.data;
    terms.value = data.items || [];
    semesters.value = semestersResponse.data.items || [];
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
    resetOverview();
    syncTermFormFromSelected();
    return;
  }
  loadingOverview.value = true;
  try {
    const { data } = await api.get(`/admin/class-matching/terms/${selectedTermId.value}/overview`);
    overview.term = data.term || null;
    overview.profiles = data.profiles || [];
    overview.qualificationQueue = data.qualificationQueue || [];
    overview.currentVersion = data.currentVersion || null;
    overview.matches = data.matches || [];
    overview.versions = data.versions || [];
    overview.slots = data.slots || [];
    overview.summary = data.summary || null;
    teacherReviewIndex.value = clampIndex(teacherReviewIndex.value, teacherProfiles.value.length);
    versionHistoryIndex.value = clampIndex(versionHistoryIndex.value, overview.versions.length);
    if (!studentOptions.value.some((item) => item.userId === manualForm.studentUserId)) {
      manualForm.studentUserId = 0;
    }
    if (!approvedTeacherOptions.value.some((item) => item.userId === manualForm.teacherUserId)) {
      manualForm.teacherUserId = 0;
    }
    fillQualificationDrafts();
    syncTermFormFromSelected();
  } finally {
    loadingOverview.value = false;
  }
}

async function refreshAll() {
  await loadTerms();
  await loadOverview();
}

function resetTermForm() {
  selectedTermId.value = 0;
  syncTermFormFromSelected();
}

async function submitTerm() {
  savingTerm.value = true;
  try {
    if (selectedTermId.value) {
      await api.patch(`/admin/class-matching/terms/${selectedTermId.value}`, {
        semesterId: termForm.semesterId,
        name: termForm.name,
        startDate: termForm.startDate,
        endDate: termForm.endDate,
        activate: termForm.activate
      });
      showSuccess(t('adminClassMatching.termUpdated'));
    } else {
      const { data } = await api.post('/admin/class-matching/terms', {
        semesterId: termForm.semesterId,
        name: termForm.name,
        startDate: termForm.startDate,
        endDate: termForm.endDate,
        activate: termForm.activate
      });
      selectedTermId.value = data.id;
      showSuccess(t('adminClassMatching.termCreated'));
    }
    await refreshAll();
  } catch (err) {
    showError(err, t('adminClassMatching.termSaveFailed'));
  } finally {
    savingTerm.value = false;
  }
}

async function removeTerm() {
  if (!selectedTermId.value) {
    return;
  }
  if (!window.confirm(t('adminClassMatching.confirmDeleteTerm'))) {
    return;
  }
  deletingTerm.value = true;
  try {
    await api.delete(`/admin/class-matching/terms/${selectedTermId.value}`);
    showSuccess(t('adminClassMatching.termDeleted'));
    selectedTermId.value = 0;
    await refreshAll();
  } catch (err) {
    showError(err, t('adminClassMatching.termDeleteFailed'));
  } finally {
    deletingTerm.value = false;
  }
}

async function saveQualification(teacher) {
  const draft = qualificationDrafts[teacher.userId];
  qualificationSavingUserId.value = teacher.userId;
  try {
    await api.patch(`/admin/class-matching/terms/${selectedTermId.value}/teachers/${teacher.userId}/qualification`, {
      status: draft.status,
      feedback: draft.feedback
    });
    showSuccess(t('adminClassMatching.qualificationSaved'));
    await loadOverview();
  } catch (err) {
    showError(err, t('adminClassMatching.qualificationSaveFailed'));
  } finally {
    qualificationSavingUserId.value = 0;
  }
}

async function generateMatches() {
  generating.value = true;
  try {
    await api.post(`/admin/class-matching/terms/${selectedTermId.value}/generate`, {
      changeSummary: t('adminClassMatching.generateSummary')
    });
    showSuccess(t('adminClassMatching.generateSuccess'));
    await loadOverview();
  } catch (err) {
    showError(err, t('adminClassMatching.generateFailed'));
  } finally {
    generating.value = false;
  }
}

async function incrementalMatchesRun() {
  incrementalSaving.value = true;
  try {
    await api.post(`/admin/class-matching/terms/${selectedTermId.value}/incremental`, {
      changeSummary: t('adminClassMatching.incrementalSummary')
    });
    showSuccess(t('adminClassMatching.incrementalSuccess'));
    await loadOverview();
  } catch (err) {
    showError(err, t('adminClassMatching.incrementalFailed'));
  } finally {
    incrementalSaving.value = false;
  }
}

async function submitManualAdjustment() {
  manualSaving.value = true;
  try {
    await api.post(`/admin/class-matching/terms/${selectedTermId.value}/manual`, {
      studentUserId: manualForm.studentUserId,
      teacherUserId: manualForm.teacherUserId || null,
      notes: manualForm.notes,
      changeSummary: manualForm.changeSummary || t('adminClassMatching.manualSummaryFallback')
    });
    showSuccess(t('adminClassMatching.manualSaved'));
    manualForm.notes = '';
    manualForm.changeSummary = '';
    await loadOverview();
  } catch (err) {
    showError(err, t('adminClassMatching.manualSaveFailed'));
  } finally {
    manualSaving.value = false;
  }
}

function parseDownloadFileName(contentDisposition, fallback) {
  if (!contentDisposition) {
    return fallback;
  }
  const utfMatch = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utfMatch?.[1]) {
    return decodeURIComponent(utfMatch[1]);
  }
  const plainMatch = contentDisposition.match(/filename="?([^"]+)"?/i);
  return plainMatch?.[1] || fallback;
}

async function exportCsv(versionId = null) {
  const response = await api.get(`/admin/class-matching/terms/${selectedTermId.value}/export`, {
    params: versionId ? { versionId } : {},
    responseType: 'blob'
  });
  const fallbackName = `class_matching_${selectedTermId.value}.csv`;
  const fileName = parseDownloadFileName(response.headers['content-disposition'], fallbackName);
  const url = window.URL.createObjectURL(new Blob([response.data], { type: 'text/csv;charset=utf-8;' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.URL.revokeObjectURL(url);
}

async function exportCurrentCsv() {
  exportingCsv.value = true;
  try {
    await exportCsv();
    showSuccess(t('adminClassMatching.exportSuccess'));
  } catch (err) {
    showError(err, t('adminClassMatching.exportFailed'));
  } finally {
    exportingCsv.value = false;
  }
}

async function exportSpecificCsv(versionId) {
  exportingVersionId.value = versionId;
  try {
    await exportCsv(versionId);
    showSuccess(t('adminClassMatching.exportSuccess'));
  } catch (err) {
    showError(err, t('adminClassMatching.exportFailed'));
  } finally {
    exportingVersionId.value = 0;
  }
}

async function compareVersionsRun() {
  comparingVersions.value = true;
  try {
    const { data } = await api.get(`/admin/class-matching/terms/${selectedTermId.value}/compare`, {
      params: {
        fromVersionId: compareFromVersionId.value,
        toVersionId: compareToVersionId.value
      }
    });
    compareResult.value = data;
  } catch (err) {
    showError(err, t('adminClassMatching.compareFailed'));
  } finally {
    comparingVersions.value = false;
  }
}

async function restoreVersionRun(versionId) {
  restoringVersionId.value = versionId;
  try {
    await api.post(`/admin/class-matching/terms/${selectedTermId.value}/versions/${versionId}/restore`, {
      changeSummary: t('adminClassMatching.restoreSummary')
    });
    showSuccess(t('adminClassMatching.restoreSuccess'));
    await loadOverview();
  } catch (err) {
    showError(err, t('adminClassMatching.restoreFailed'));
  } finally {
    restoringVersionId.value = 0;
  }
}

watch(selectedTermId, async () => {
  try {
    syncTermFormFromSelected();
    await loadOverview();
  } catch (err) {
    showError(err, t('adminClassMatching.loadFailed'));
  }
});

onMounted(async () => {
  try {
    await loadTerms();
    syncTermFormFromSelected();
    await loadOverview();
  } catch (err) {
    showError(err, t('adminClassMatching.loadFailed'));
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

.form {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.field-half {
  flex: 1;
}

.toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  font-size: 0.92rem;
  color: var(--muted);
}

.section-head {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
  align-items: flex-start;
}

.term-list,
.teacher-review-list,
.version-list {
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
}

.term-list {
  margin-top: 0.85rem;
}

.term-chip,
.teacher-card,
.version-card,
.summary-box,
.compare-box {
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--panel-soft);
}

.term-chip {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.75rem;
  padding: 0.7rem 0.85rem;
  cursor: pointer;
  color: var(--ink);
}

.term-chip.active {
  border-color: var(--accent);
}

.summary-grid {
  margin-top: 0.85rem;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.75rem;
}

.summary-box {
  padding: 0.8rem 0.9rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.summary-box strong {
  font-size: 1.3rem;
}

.action-row {
  margin-top: 0.85rem;
}

.pager-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 0.75rem;
}

.pager-row .subtle {
  margin: 0;
  text-align: center;
}

.teacher-card,
.version-card,
.compare-box {
  padding: 0.85rem;
}

.teacher-head,
.version-head {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
  align-items: flex-start;
}

.teacher-head h3,
.version-head h3 {
  margin: 0;
}

.status-pill,
.type-pill,
.current-badge {
  display: inline-flex;
  padding: 0.18rem 0.5rem;
  border-radius: 999px;
  font-size: 0.78rem;
  font-weight: 700;
  border: 1px solid var(--line);
  background: #232831;
}

.status-pill.approved {
  border-color: rgba(117, 189, 138, 0.5);
  color: #9ed7ae;
}

.status-pill.rejected {
  border-color: rgba(209, 122, 122, 0.5);
  color: #de9a9a;
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

.current-badge {
  border-color: rgba(255, 255, 255, 0.32);
}

.compare-result {
  margin-top: 0.75rem;
}

.diff-list {
  margin: 0.5rem 0 0;
  padding-left: 1.1rem;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.result-table td {
  vertical-align: top;
}

.multiline-text {
  white-space: pre-wrap;
}

@media (max-width: 960px) {
  .summary-grid {
    grid-template-columns: 1fr 1fr;
  }
}

@media (max-width: 640px) {
  .summary-grid {
    grid-template-columns: 1fr;
  }
}
</style>

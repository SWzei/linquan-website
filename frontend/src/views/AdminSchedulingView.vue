<template>
  <section class="card panel preview-panel" v-if="draftReady && calendarPreviewRows.length">
    <h2 class="section-title">{{ t('admin.calendarPreviewTitle') }}</h2>
    <p class="subtle">{{ t('admin.calendarPreviewSubtitle') }}</p>
    <div class="preview-wrap">
      <table class="preview-table">
        <thead>
          <tr>
            <th>{{ t('schedule.headerTime') }}</th>
            <th v-for="item in previewHeaders" :key="`${item.day}-${item.roomNo}`">
              {{ item.label }} · {{ item.roomLabel }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in calendarPreviewRows" :key="row.hour">
            <td class="time-col">{{ row.time }}</td>
            <td v-for="cell in row.cells" :key="cell.key" :class="{ empty: !cell.member }">
              {{ cell.member || '—' }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>

  <section class="grid-2">
    <article class="card panel">
      <h2 class="section-title">{{ t('admin.schedulingControl') }}</h2>
      <p class="subtle" v-if="currentSemester">
        {{
          t('admin.currentSemesterInfo', {
            name: currentSemester.name,
            start: currentSemester.startDate,
            end: currentSemester.endDate
          })
        }}
      </p>
      <p class="subtle" v-else>{{ t('admin.noCurrentSemester') }}</p>
      <p class="subtle" v-if="currentSemester && currentSemester.id !== activeSemesterId && activeSemesterName">
        {{ t('admin.activeSemesterHint', { name: activeSemesterName }) }}
      </p>
      <p class="subtle" v-if="draftReady">{{ t('admin.draftScheduleReady') }}</p>
      <p class="subtle" v-else>{{ t('admin.noDraftSchedule') }}</p>

      <div class="row controls">
        <button class="btn" :disabled="!currentSemester" @click="runSchedule">{{ t('admin.runScheduleWithWarning') }}</button>
        <button class="btn secondary" :disabled="!currentSemester" @click="updateSchedule">
          {{ t('admin.updateSchedule') }}
        </button>
        <button class="btn warn" :disabled="!draftReady" @click="publishSchedule">{{ t('admin.publishSchedule') }}</button>
        <button class="btn secondary" :disabled="exporting || !draftReady" @click="downloadCalendar">
          {{ exporting ? t('admin.downloading') : t('admin.downloadCalendar') }}
        </button>
        <button class="btn secondary" :disabled="exportingPreferences || !currentSemester" @click="downloadPreferences">
          {{ exportingPreferences ? t('admin.downloading') : t('admin.downloadPreferenceCsv') }}
        </button>
      </div>

      <article class="guidance-panel" v-if="currentSemester && showPreferenceGuidance">
        <h3>{{ t('admin.preferenceGuidanceTitle') }}</h3>
        <p class="subtle">{{ preferenceGuidanceMessage }}</p>
        <p class="subtle">
          {{
            t('admin.preferenceGuidanceCounts', {
              submitted: preferenceSummary?.membersWithPreferences || 0,
              total: preferenceSummary?.totalMembers || 0,
              missing: preferenceSummary?.membersWithoutPreferences || 0
            })
          }}
        </p>
      </article>

      <article class="compliance-panel" v-if="compliance">
        <h3>{{ t('admin.requirementCheckTitle') }}</h3>
        <p class="subtle">
          {{
            t('admin.requirementOverall', {
              state: compliance.basicRequirementSatisfied
                ? t('admin.requirementSatisfied')
                : t('admin.requirementUnsatisfied')
            })
          }}
        </p>
        <p class="subtle">
          {{
            t('admin.requirementFairness', {
              achieved: compliance.fairness?.achievedMembersWithAtLeastOne || 0,
              target: compliance.fairness?.expectedMaxFairMembers || 0
            })
          }}
        </p>
        <p class="subtle">
          {{
            t('admin.requirementHours', {
              over: compliance.overTwoMembers || 0
            })
          }}
        </p>
        <p class="subtle">
          {{
            t('admin.requirementUtilization', {
              assigned: compliance.totalAssignedSlots || 0,
              total: compliance.totalSlots || 0,
              rate: `${Math.round((Number(compliance.utilization || 0) || 0) * 100)}%`
            })
          }}
        </p>
      </article>

      <article class="slot-editor" v-if="activeSlot && draftReady">
        <h3>{{ t('admin.slotEditorTitle') }}</h3>
        <p class="subtle">
          {{
            t('admin.slotEditorTarget', {
              day: dayMap[activeSlot.dayOfWeek],
              hour: activeSlot.hour,
              room: activeSlot.roomNo,
              selected: activeSlot.selectedCount || 0
            })
          }}
        </p>

        <template v-if="activeAssignment">
          <p class="subtle">
            {{ t('admin.slotEditorOccupiedBy', { name: activeAssignment.displayName, student: activeAssignment.studentNumber }) }}
          </p>
          <p class="subtle">{{ t('admin.slotEditorMoveHint') }}</p>
          <button class="btn warn" :disabled="moving" @click="deleteActiveAssignment">{{ t('admin.deleteSelectedSlot') }}</button>
        </template>

        <template v-else>
          <div class="field">
            <label>{{ t('admin.slotEditorMemberSearch') }}</label>
            <input v-model.trim="slotMemberKeyword" :placeholder="t('admin.memberSearchPlaceholder')" />
          </div>
          <div class="field">
            <label>
              {{
                t('admin.slotEditorChooseMember', {
                  shown: slotMemberOptions.length,
                  total: slotMemberCandidates.length
                })
              }}
            </label>
            <div class="member-picker-grid" v-if="slotMemberOptions.length">
              <button
                v-for="member in slotMemberOptions"
                :key="member.userId"
                type="button"
                class="member-chip"
                :class="{ active: slotMemberId === member.userId }"
                @click="slotMemberId = member.userId"
              >
                <span>{{ member.displayName }} ({{ member.studentNumber }})</span>
                <span class="chip-meta">{{ t('admin.assignedHours', { count: member.assignedCount }) }}</span>
              </button>
            </div>
            <p class="subtle" v-else>{{ t('admin.noMemberMatch') }}</p>
            <p class="subtle" v-if="slotMemberCandidates.length > slotMemberOptions.length">
              {{ t('admin.slotEditorNarrowHint') }}
            </p>
            <p class="subtle" v-if="slotMemberId">
              {{
                t('admin.selectedMember', {
                  name: members.find((item) => item.userId === slotMemberId)?.displayName || '-'
                })
              }}
            </p>
          </div>
          <div class="row">
            <button class="btn secondary" type="button" :disabled="moving || !slotMemberId" @click="slotMemberId = 0">
              {{ t('admin.clearSelectedMember') }}
            </button>
            <button class="btn" type="button" :disabled="moving || !slotMemberId" @click="assignToActiveSlot">
              {{ t('admin.slotEditorAssign') }}
            </button>
          </div>
        </template>
      </article>

      <div class="row action-row" v-if="draftReady">
        <button class="btn secondary" :disabled="moving || !canUndo" @click="undoLastOperation">
          {{ t('admin.undoOperation') }}
        </button>
        <button class="btn secondary" :disabled="moving || !canRedo" @click="redoLastOperation">
          {{ t('admin.redoOperation') }}
        </button>
      </div>

      <article class="operation-panel" v-if="operations.length">
        <h3>{{ t('admin.operationHistory') }}</h3>
        <ul class="operation-list">
          <li v-for="item in operations" :key="item.id">
            {{ describeOperation(item) }}
          </li>
        </ul>
      </article>
    </article>

    <article class="card panel">
      <h2 class="section-title">{{ t('admin.semesterManagementTitle') }}</h2>
      <p class="subtle">{{ t('admin.semesterManagementSubtitle') }}</p>

      <div class="field">
        <label>{{ t('admin.semesterSelect') }}</label>
        <select
          v-model.number="selectedSemesterId"
          :disabled="loadingSemesters || semesterList.length === 0"
          @change="onSemesterSelect(selectedSemesterId)"
        >
          <option :value="0">{{ t('common.choose') }}</option>
          <option v-for="item in semesterList" :key="item.id" :value="item.id">
            {{ item.name }}{{ item.isActive ? ` · ${t('admin.activeSemesterBadge')}` : '' }}
          </option>
        </select>
      </div>

      <div class="semester-list" v-if="semesterList.length">
        <button
          v-for="item in semesterList"
          :key="item.id"
          type="button"
          class="semester-chip"
          :class="{ active: item.id === selectedSemesterId }"
          @click="onSemesterSelect(item.id)"
        >
          <span>{{ item.name }}</span>
          <span class="subtle">{{ item.isActive ? t('admin.activeSemesterBadge') : item.startDate }}</span>
        </button>
      </div>

      <form class="form section-space" @submit.prevent="submitSemester">
        <div class="field">
          <label>{{ t('admin.semesterName') }}</label>
          <input v-model.trim="semester.name" required />
        </div>
        <div class="row">
          <div class="field field-half">
            <label>{{ t('admin.startDate') }}</label>
            <input type="date" v-model="semester.startDate" required />
          </div>
          <div class="field field-half">
            <label>{{ t('admin.endDate') }}</label>
            <input type="date" v-model="semester.endDate" required />
          </div>
        </div>
        <label class="toggle">
          <input type="checkbox" v-model="semester.activate" />
          {{ t('admin.setActive') }}
        </label>
        <div class="row">
          <button class="btn" :disabled="savingSemester">{{ semesterSubmitLabel }}</button>
          <button class="btn secondary" type="button" :disabled="savingSemester" @click="resetSemesterForm">
            {{ t('admin.resetSemesterForm') }}
          </button>
          <button class="btn warn" type="button" :disabled="!selectedSemesterId || deletingSemester" @click="deleteSemester">
            {{ deletingSemester ? t('common.loading') : t('admin.deleteSemester') }}
          </button>
        </div>
      </form>

      <article class="unsatisfied-panel" v-if="draftReady">
        <h3>{{ t('admin.unsatisfiedListTitle') }}</h3>
        <table>
          <thead>
            <tr>
              <th>{{ t('common.name') }}</th>
              <th>{{ t('common.student') }}</th>
              <th>{{ t('admin.assignedHoursShort') }}</th>
              <th>{{ t('admin.preferenceCountShort') }}</th>
              <th>{{ t('admin.unsatisfiedReason') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in unsatisfiedMembers" :key="item.userId">
              <td>{{ item.displayName }}</td>
              <td>{{ item.studentNumber }}</td>
              <td>{{ item.assignedCount }}</td>
              <td>{{ item.preferenceCount }}</td>
              <td>
                {{
                  item.reason === 'over_limit'
                    ? t('admin.unsatisfiedReasonOverLimit')
                    : t('admin.unsatisfiedReasonNoAssignment')
                }}
              </td>
            </tr>
            <tr v-if="unsatisfiedMembers.length === 0">
              <td colspan="5" class="subtle">{{ t('admin.unsatisfiedAllGood') }}</td>
            </tr>
          </tbody>
        </table>
      </article>
    </article>
  </section>

  <button
    v-if="quickActionToggleVisible"
    type="button"
    class="btn secondary quick-action-toggle"
    @click="quickActionExpanded = !quickActionExpanded"
  >
    {{ quickActionExpanded ? t('admin.quickActionsHide') : t('admin.quickActionsShow') }}
  </button>

  <section class="quick-action-bar card" v-if="quickActionToggleVisible && quickActionExpanded">
    <h3>{{ t('admin.quickActionsTitle') }}</h3>
    <div class="row controls compact">
      <button class="btn" :disabled="moving" @click="runSchedule">{{ t('admin.runScheduleWithWarning') }}</button>
      <button class="btn secondary" :disabled="moving" @click="updateSchedule">
        {{ t('admin.updateSchedule') }}
      </button>
      <button class="btn warn" :disabled="moving || !draftReady" @click="publishSchedule">{{ t('admin.publishSchedule') }}</button>
      <button class="btn secondary" :disabled="moving || !canUndo || !draftReady" @click="undoLastOperation">
        {{ t('admin.undoOperation') }}
      </button>
      <button class="btn secondary" :disabled="moving || !canRedo || !draftReady" @click="redoLastOperation">
        {{ t('admin.redoOperation') }}
      </button>
    </div>

    <div class="quick-member" v-if="draftReady">
      <div class="field">
        <label>{{ t('admin.slotEditorMemberSearch') }}</label>
        <input v-model.trim="slotMemberKeyword" :placeholder="t('admin.memberSearchPlaceholder')" />
      </div>
      <div class="field">
        <label>
          {{
            t('admin.slotEditorChooseMember', {
              shown: slotMemberOptions.length,
              total: slotMemberCandidates.length
            })
          }}
        </label>
        <select v-model.number="slotMemberId">
          <option :value="0">{{ t('common.choose') }}</option>
          <option v-for="member in slotMemberOptions" :key="member.userId" :value="member.userId">
            {{ member.displayName }} ({{ member.studentNumber }}) · {{ t('admin.assignedHours', { count: member.assignedCount }) }}
          </option>
        </select>
      </div>
    </div>

    <div class="quick-summary" v-if="draftReady">
      <p class="subtle" v-if="activeSlot">
        {{
          t('admin.slotEditorTarget', {
            day: dayMap[activeSlot.dayOfWeek],
            hour: activeSlot.hour,
            room: activeSlot.roomNo,
            selected: activeSlot.selectedCount || 0
          })
        }}
      </p>
      <p class="subtle" v-if="activeAssignment">
        {{ t('admin.slotEditorOccupiedBy', { name: activeAssignment.displayName, student: activeAssignment.studentNumber }) }}
      </p>
      <p class="subtle" v-else-if="activeSlot && selectedMember">
        {{ t('admin.selectedMember', { name: selectedMember.displayName }) }}
      </p>
      <p class="subtle" v-if="selectedAssignment">
        {{
          t('admin.selectedAssignment', {
            name: selectedAssignment.displayName,
            day: dayMap[getSlotMeta(selectedAssignment.slotId)?.dayOfWeek || 0],
            hour: getSlotMeta(selectedAssignment.slotId)?.hour ?? '-',
            room: getSlotMeta(selectedAssignment.slotId)?.roomNo ?? '-'
          })
        }}
      </p>
    </div>

    <div class="row controls compact" v-if="draftReady">
      <button
        class="btn"
        type="button"
        :disabled="moving || !activeSlot || !!activeAssignment || !slotMemberId"
        @click="assignToActiveSlot"
      >
        {{ t('admin.slotEditorAssign') }}
      </button>
      <button
        class="btn warn"
        type="button"
        :disabled="moving || !activeAssignment"
        @click="deleteActiveAssignment"
      >
        {{ t('admin.deleteSelectedSlot') }}
      </button>
      <button
        class="btn secondary"
        type="button"
        :disabled="moving || !slotMemberId"
        @click="slotMemberId = 0"
      >
        {{ t('admin.clearSelectedMember') }}
      </button>
      <button
        class="btn secondary"
        type="button"
        :disabled="moving || !selectedAssignmentId"
        @click="selectedAssignmentId = 0"
      >
        {{ t('admin.clearMoveSelection') }}
      </button>
    </div>
  </section>

  <section class="calendar-board" ref="calendarBoardRef" v-if="draftReady && slots.length">
    <article class="card arrange-card">
      <div class="arrange-head">
        <div>
          <h3>{{ t('admin.slotEditorTitle') }}</h3>
          <p class="subtle">{{ t('admin.slotEditorMoveHint') }}</p>
        </div>
      </div>
      <div class="arrange-wrap">
        <table class="arrange-table">
          <thead>
            <tr>
              <th rowspan="2" class="time-col sticky-col">{{ t('schedule.headerTime') }}</th>
              <th v-for="day in dayOptions" :key="`head-${day.value}`" colspan="2" class="day-header">
                {{ day.label }}
              </th>
            </tr>
            <tr>
              <template v-for="day in dayOptions" :key="`rooms-${day.value}`">
                <th class="room-header">{{ t('schedule.headerRoom1') }}</th>
                <th class="room-header">{{ t('schedule.headerRoom2') }}</th>
              </template>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in calendarArrangeRows" :key="row.hour">
              <td class="time-col sticky-col">{{ row.time }}</td>
              <template v-for="day in row.days" :key="`day-${row.hour}-${day.dayValue}`">
                <td v-for="cell in day.rooms" :key="cell.key" class="arrange-cell">
                  <button
                    v-if="cell.slot"
                    class="slot-btn"
                    :class="slotClass(cell.slot)"
                    :disabled="moving"
                    @click="onSlotClick(cell.slot)"
                  >
                    <span class="slot-top">
                      <span class="count-badge" :title="t('schedule.selectedCount', { count: cell.slot.selectedCount })">
                        {{ cell.slot.selectedCount }}
                      </span>
                      <span class="hint">
                        {{ cell.assignment?.studentNumber || t('admin.slotEditorClickToArrange') }}
                      </span>
                    </span>
                    <span class="name">
                      {{ cell.assignment?.displayName || t('admin.unassigned') }}
                    </span>
                  </button>
                </td>
              </template>
            </tr>
          </tbody>
        </table>
      </div>
    </article>
  </section>
</template>

<script setup>
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch
} from 'vue';
import api from '@/services/api';
import { useI18n } from '@/i18n';
import { useToast } from '@/composables/toast';

const { t } = useI18n();
const { showSuccess, showError } = useToast();

const semesterList = ref([]);
const selectedSemesterId = ref(0);
const editingSemesterId = ref(0);
const activeSemesterId = ref(0);
const loadingSemesters = ref(false);
const savingSemester = ref(false);
const deletingSemester = ref(false);

const semester = reactive({
  name: '',
  startDate: '',
  endDate: '',
  activate: true
});

const draftBatch = ref(null);
const draftAssignments = ref([]);
const members = ref([]);
const unsatisfiedMembers = ref([]);
const currentSemester = ref(null);
const selectedAssignmentId = ref(0);
const activeSlotId = ref(0);
const slotMemberId = ref(0);
const slotMemberKeyword = ref('');
const calendarBoardRef = ref(null);
const inArrangeInterface = ref(false);
const quickActionExpanded = ref(true);

const moving = ref(false);
const exporting = ref(false);
const exportingPreferences = ref(false);
const slots = ref([]);
const compliance = ref(null);
const operations = ref([]);
const preferenceSummary = ref(null);

const historyStack = ref([]);
const redoStack = ref([]);

const SLOT_MEMBER_LIMIT = 24;
const hours = Array.from({ length: 14 }, (_, index) => 8 + index);

const dayMap = computed(() => ({
  0: t('day.sunShort'),
  1: t('day.monShort'),
  2: t('day.tueShort'),
  3: t('day.wedShort'),
  4: t('day.thuShort'),
  5: t('day.friShort'),
  6: t('day.satShort')
}));

const dayOptions = computed(() =>
  [0, 1, 2, 3, 4, 5, 6].map((day) => ({
    value: day,
    label: dayMap.value[day]
  }))
);

const slotByKey = computed(() => {
  const map = new Map();
  for (const slot of slots.value) {
    map.set(`${slot.dayOfWeek}-${slot.hour}-${slot.roomNo}`, slot);
  }
  return map;
});

const slotById = computed(() => {
  const map = new Map();
  for (const slot of slots.value) {
    map.set(slot.id, slot);
  }
  return map;
});

const assignmentBySlotId = computed(() => {
  const map = new Map();
  for (const assignment of draftAssignments.value) {
    map.set(assignment.slotId, assignment);
  }
  return map;
});

const selectedAssignment = computed(() =>
  draftAssignments.value.find((assignment) => assignment.id === selectedAssignmentId.value) || null
);
const selectedMember = computed(() =>
  members.value.find((member) => member.userId === slotMemberId.value) || null
);

const activeSlot = computed(() => slotById.value.get(activeSlotId.value) || null);
const activeAssignment = computed(() => {
  if (!activeSlot.value) {
    return null;
  }
  return assignmentBySlotId.value.get(activeSlot.value.id) || null;
});

const slotMemberCandidates = computed(() => {
  const keyword = slotMemberKeyword.value.trim().toLowerCase();
  return members.value
    .filter((member) => {
      if (!keyword) {
        return true;
      }
      const fields = [member.displayName, member.studentNumber];
      return fields.some((field) => String(field || '').toLowerCase().includes(keyword));
    })
    .sort((a, b) => {
      const assignedDiff = Number(a.assignedCount || 0) - Number(b.assignedCount || 0);
      if (assignedDiff !== 0) {
        return assignedDiff;
      }
      const prefDiff = Number(b.preferenceCount || 0) - Number(a.preferenceCount || 0);
      if (prefDiff !== 0) {
        return prefDiff;
      }
      return String(a.studentNumber || '').localeCompare(String(b.studentNumber || ''));
    });
});

const slotMemberOptions = computed(() =>
  slotMemberCandidates.value.slice(0, SLOT_MEMBER_LIMIT)
);

const previewDayLabelsZh = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const previewHeaders = computed(() => {
  const headers = [];
  for (let day = 0; day <= 6; day += 1) {
    headers.push({ day, roomNo: 1, label: previewDayLabelsZh[day], roomLabel: '324琴房' });
    headers.push({ day, roomNo: 2, label: previewDayLabelsZh[day], roomLabel: '325琴房' });
  }
  return headers;
});

const calendarPreviewRows = computed(() =>
  hours.map((hour) => ({
    hour,
    time: `${String(hour).padStart(2, '0')}:00`,
    cells: previewHeaders.value.map((header) => {
      const slot = getSlot(header.day, hour, header.roomNo);
      const assignment = slot ? getAssignment(slot.id) : null;
      return {
        key: `${header.day}-${header.roomNo}-${hour}`,
        member: assignment ? `${assignment.displayName} (${assignment.studentNumber})` : ''
      };
    })
  }))
);

const calendarArrangeRows = computed(() =>
  hours.map((hour) => ({
    hour,
    time: `${String(hour).padStart(2, '0')}:00`,
    days: dayOptions.value.map((day) => ({
      dayValue: day.value,
      rooms: [1, 2].map((roomNo) => {
        const slot = getSlot(day.value, hour, roomNo);
        const assignment = slot ? getAssignment(slot.id) : null;
        return {
          key: `${day.value}-${hour}-${roomNo}`,
          roomNo,
          slot,
          assignment
        };
      })
    }))
  }))
);

const draftReady = computed(() => Boolean(draftBatch.value));
const canUndo = computed(() => historyStack.value.length > 0);
const canRedo = computed(() => redoStack.value.length > 0);
const quickActionToggleVisible = computed(() =>
  Boolean(currentSemester.value) && draftReady.value && slots.value.length > 0 && inArrangeInterface.value
);
const activeSemesterName = computed(
  () => semesterList.value.find((item) => item.id === activeSemesterId.value)?.name || ''
);
const semesterSubmitLabel = computed(() =>
  editingSemesterId.value ? t('admin.updateSemesterButton') : t('admin.createSemesterButton')
);
const showPreferenceGuidance = computed(
  () =>
    Boolean(currentSemester.value)
    && Boolean(preferenceSummary.value)
    && (
      !preferenceSummary.value.readyForGeneration
      || Number(preferenceSummary.value.membersWithoutPreferences || 0) > 0
    )
);
const preferenceGuidanceMessage = computed(() => {
  if (!currentSemester.value || !preferenceSummary.value) {
    return '';
  }
  if (!preferenceSummary.value.readyForGeneration) {
    return t('admin.preferenceGuidanceMissing', { name: currentSemester.value.name });
  }
  if (Number(preferenceSummary.value.membersWithoutPreferences || 0) > 0) {
    return t('admin.preferenceGuidancePartial', { name: currentSemester.value.name });
  }
  return t('admin.preferenceGuidanceReady', { name: currentSemester.value.name });
});

function clearSemesterForm() {
  semester.name = '';
  semester.startDate = '';
  semester.endDate = '';
  semester.activate = true;
}

function syncCurrentSemesterFromList() {
  currentSemester.value = semesterList.value.find((item) => item.id === selectedSemesterId.value) || null;
}

function syncSemesterFormFromEditing() {
  const selected = semesterList.value.find((item) => item.id === editingSemesterId.value) || null;
  if (!selected) {
    clearSemesterForm();
    return;
  }
  semester.name = selected.name || '';
  semester.startDate = selected.startDate || '';
  semester.endDate = selected.endDate || '';
  semester.activate = Boolean(selected.isActive);
}

function resetSchedulingInteractionState() {
  selectedAssignmentId.value = 0;
  activeSlotId.value = 0;
  slotMemberId.value = 0;
  slotMemberKeyword.value = '';
  historyStack.value = [];
  redoStack.value = [];
}

function setMessage(text) {
  showSuccess(text);
}

function setError(err) {
  const rawText = typeof err === 'string' ? err : err?.response?.data?.message || '';
  let text = rawText || t('admin.errorRequest');
  if (rawText === 'No member preferences found for this semester') {
    text = t('admin.preferenceGuidanceMissing', {
      name: currentSemester.value?.name || t('admin.currentSemesterFallback')
    });
  }
  showError(text);
}

function getSlot(dayOfWeek, hour, roomNo) {
  return slotByKey.value.get(`${dayOfWeek}-${hour}-${roomNo}`) || null;
}

function getAssignment(slotId) {
  return assignmentBySlotId.value.get(slotId) || null;
}

function getSlotMeta(slotId) {
  return slotById.value.get(slotId) || null;
}

function updateArrangeInterfaceState() {
  const board = calendarBoardRef.value;
  if (!board) {
    inArrangeInterface.value = false;
    return;
  }

  const rect = board.getBoundingClientRect();
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  const topThreshold = 120;
  inArrangeInterface.value = rect.top < viewportHeight - 120 && rect.bottom > topThreshold;
}

function slotClass(slot) {
  const assignment = getAssignment(slot.id);
  const selected = selectedAssignment.value;
  const active = activeSlot.value;
  return {
    occupied: Boolean(assignment),
    source: Boolean(selected && selected.slotId === slot.id),
    target: Boolean(selected && selected.slotId !== slot.id),
    active: Boolean(active && active.id === slot.id)
  };
}

function parseFileName(contentDisposition, fallback) {
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

function pushHistory(entry) {
  historyStack.value.push({ ...entry, at: Date.now() });
  if (historyStack.value.length > 100) {
    historyStack.value.shift();
  }
  redoStack.value = [];
}

function describeOperation(item) {
  const payload = item?.payload || {};
  switch (item?.operationType) {
    case 'run_schedule':
      return t('admin.opRunSchedule');
    case 'update_schedule':
      return t('admin.opUpdateSchedule', { count: payload.addedAssignments || 0 });
    case 'manual_assign':
      return t('admin.opManualAssign', {
        userId: payload.userId || '-',
        slotId: payload.slotId || '-'
      });
    case 'move_assignment':
      return t('admin.opMoveAssign', {
        userId: payload.userId || '-',
        from: payload.fromSlotId || '-',
        to: payload.toSlotId || '-'
      });
    case 'swap_assignment':
      return t('admin.opSwapAssign', {
        source: payload.sourceUserId || '-',
        target: payload.targetUserId || '-'
      });
    case 'delete_assignment':
      return t('admin.opDeleteAssign', {
        userId: payload.userId || '-',
        slotId: payload.slotId || '-'
      });
    case 'publish_schedule':
      return t('admin.opPublishSchedule');
    default:
      return `${item.operationType || 'operation'} #${item.id}`;
  }
}

async function loadSlots(semesterId) {
  if (!semesterId) {
    slots.value = [];
    return;
  }
  const { data } = await api.get('/scheduling/slots', { params: { semesterId } });
  slots.value = data.items || [];
}

async function loadSemesters({ keepCreateMode = false, preferredSemesterId = selectedSemesterId.value } = {}) {
  loadingSemesters.value = true;
  try {
    const { data } = await api.get('/admin/semesters');
    semesterList.value = data.items || [];
    activeSemesterId.value = Number(data.currentSemesterId || 0);

    if (!semesterList.value.length) {
      selectedSemesterId.value = 0;
      editingSemesterId.value = 0;
      currentSemester.value = null;
      clearSemesterForm();
      return;
    }

    const resolvedSemesterId = semesterList.value.some((item) => item.id === preferredSemesterId)
      ? Number(preferredSemesterId)
      : Number(activeSemesterId.value || semesterList.value[0].id || 0);
    selectedSemesterId.value = resolvedSemesterId;
    syncCurrentSemesterFromList();

    if (keepCreateMode) {
      editingSemesterId.value = 0;
      clearSemesterForm();
    } else {
      editingSemesterId.value = resolvedSemesterId;
      syncSemesterFormFromEditing();
    }
  } finally {
    loadingSemesters.value = false;
  }
}

async function loadDraftSchedule(semesterId = selectedSemesterId.value) {
  if (!semesterId) {
    currentSemester.value = null;
    draftBatch.value = null;
    draftAssignments.value = [];
    members.value = [];
    unsatisfiedMembers.value = [];
    compliance.value = null;
    operations.value = [];
    preferenceSummary.value = null;
    await loadSlots(0);
    return;
  }

  const { data } = await api.get('/admin/scheduling/proposed', {
    params: { semesterId }
  });
  selectedSemesterId.value = data.semesterId || Number(semesterId);
  currentSemester.value = data.semester || null;
  draftBatch.value = data.batch || null;
  draftAssignments.value = data.assignments || [];
  members.value = data.members || [];
  unsatisfiedMembers.value = data.unsatisfiedMembers || [];
  compliance.value = data.compliance || null;
  operations.value = data.operations || [];
  preferenceSummary.value = data.preferenceSummary || null;

  if (selectedAssignmentId.value) {
    const exists = draftAssignments.value.some((assignment) => assignment.id === selectedAssignmentId.value);
    if (!exists) {
      selectedAssignmentId.value = 0;
    }
  }
  if (slotMemberId.value) {
    const exists = members.value.some((member) => member.userId === slotMemberId.value);
    if (!exists) {
      slotMemberId.value = 0;
    }
  }
  await loadSlots(data.semesterId || semesterId);
  if (activeSlotId.value) {
    const exists = slots.value.some((slot) => slot.id === activeSlotId.value);
    if (!exists) {
      activeSlotId.value = 0;
    }
  }
}

function resetSemesterForm() {
  editingSemesterId.value = 0;
  clearSemesterForm();
}

async function onSemesterSelect(semesterId) {
  selectedSemesterId.value = Number(semesterId) || 0;
  editingSemesterId.value = selectedSemesterId.value;
  syncCurrentSemesterFromList();
  syncSemesterFormFromEditing();
  resetSchedulingInteractionState();
  try {
    await loadDraftSchedule(selectedSemesterId.value);
  } catch (err) {
    setError(err);
  }
}

async function submitSemester() {
  const confirmKey = editingSemesterId.value ? 'admin.confirmUpdateSemester' : 'admin.confirmCreateSemester';
  if (!window.confirm(t(confirmKey))) {
    return;
  }
  savingSemester.value = true;
  try {
    const payload = {
      name: semester.name,
      startDate: semester.startDate,
      endDate: semester.endDate,
      activate: semester.activate
    };
    if (editingSemesterId.value) {
      await api.patch(`/admin/semesters/${editingSemesterId.value}`, payload);
      setMessage(t('admin.semesterUpdated'));
      await loadSemesters({
        keepCreateMode: false,
        preferredSemesterId: selectedSemesterId.value
      });
      await loadDraftSchedule(selectedSemesterId.value);
    } else {
      const { data } = await api.post('/admin/semesters', payload);
      setMessage(t('admin.semesterCreated', { id: data.id }));
      await loadSemesters({
        keepCreateMode: false,
        preferredSemesterId: data.id
      });
      await loadDraftSchedule(data.id);
    }
  } catch (err) {
    setError(err);
  } finally {
    savingSemester.value = false;
  }
}

async function deleteSemester() {
  if (!selectedSemesterId.value) {
    return;
  }
  if (!window.confirm(t('admin.confirmDeleteSemester'))) {
    return;
  }
  deletingSemester.value = true;
  try {
    const { data } = await api.delete(`/admin/semesters/${selectedSemesterId.value}`);
    setMessage(t('admin.semesterDeleted'));
    resetSchedulingInteractionState();
    await loadSemesters({
      keepCreateMode: false,
      preferredSemesterId: data?.replacementSemesterId || activeSemesterId.value
    });
    await loadDraftSchedule(selectedSemesterId.value);
  } catch (err) {
    setError(err);
  } finally {
    deletingSemester.value = false;
  }
}

async function runSchedule() {
  if (!window.confirm(t('admin.confirmRunSchedule'))) {
    return;
  }
  try {
    await api.post('/admin/scheduling/run', { semesterId: currentSemester.value?.id });
    setMessage(t('admin.scheduleDraftCreated'));
    await loadDraftSchedule();
  } catch (err) {
    setError(err);
  }
}

async function updateSchedule() {
  if (!window.confirm(t('admin.confirmUpdateSchedule'))) {
    return;
  }
  try {
    const { data } = await api.post('/admin/scheduling/update', {
      semesterId: currentSemester.value?.id
    });
    setMessage(t('admin.scheduleDraftUpdated', { count: data.addedAssignments || 0 }));
    await loadDraftSchedule();
  } catch (err) {
    setError(err);
  }
}

async function publishSchedule() {
  if (!window.confirm(t('admin.confirmPublishSchedule'))) {
    return;
  }
  try {
    const { data } = await api.post('/admin/scheduling/publish', {
      semesterId: currentSemester.value?.id
    });
    setMessage(t('admin.schedulePublished', { count: data.notification?.sent || 0 }));
    await loadDraftSchedule();
  } catch (err) {
    setError(err);
  }
}

async function downloadCalendar() {
  if (!currentSemester.value?.id) {
    setError(t('admin.noCurrentSemester'));
    return;
  }
  exporting.value = true;
  try {
    const response = await api.get('/admin/scheduling/export', {
      params: { semesterId: currentSemester.value.id },
      responseType: 'blob'
    });
    const fallbackName = `linquan_schedule_${currentSemester.value.id}.csv`;
    const fileName = parseFileName(response.headers['content-disposition'], fallbackName);
    const blob = new Blob([response.data], { type: 'text/csv;charset=utf-8;' });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
    setMessage(t('admin.calendarExported'));
  } catch (err) {
    setError(err?.response?.data?.message || t('admin.calendarExportFailed'));
  } finally {
    exporting.value = false;
  }
}

async function downloadPreferences() {
  if (!currentSemester.value?.id) {
    setError(t('admin.noCurrentSemester'));
    return;
  }
  exportingPreferences.value = true;
  try {
    const response = await api.get('/admin/scheduling/preferences/export', {
      params: { semesterId: currentSemester.value.id },
      responseType: 'blob'
    });
    const fallbackName = `linquan_preferences_semester_${currentSemester.value.id}.csv`;
    const fileName = parseFileName(response.headers['content-disposition'], fallbackName);
    const blob = new Blob([response.data], { type: 'text/csv;charset=utf-8;' });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
    setMessage(t('admin.preferenceCsvExported'));
  } catch (err) {
    setError(err?.response?.data?.message || t('admin.preferenceCsvExportFailed'));
  } finally {
    exportingPreferences.value = false;
  }
}

async function deleteAssignment(assignment) {
  const { data } = await api.delete(`/admin/scheduling/assignments/${assignment.id}`);
  const deleted = data?.deleted || {};
  pushHistory({
    type: 'delete',
    assignmentId: deleted.id || assignment.id,
    userId: deleted.userId || assignment.userId,
    slotId: deleted.slotId || assignment.slotId
  });
}

async function deleteActiveAssignment() {
  if (!activeAssignment.value) {
    return;
  }
  if (!window.confirm(t('admin.confirmDeleteSelectedSlot'))) {
    return;
  }
  moving.value = true;
  try {
    await deleteAssignment(activeAssignment.value);
    setMessage(t('admin.slotDeleted'));
    selectedAssignmentId.value = 0;
    await loadDraftSchedule();
  } catch (err) {
    setError(err);
  } finally {
    moving.value = false;
  }
}

async function assignToActiveSlot() {
  if (!activeSlot.value || activeAssignment.value) {
    return;
  }
  if (!slotMemberId.value) {
    setError(t('admin.memberRequired'));
    return;
  }

  const member = members.value.find((item) => item.userId === slotMemberId.value);
  if (!member) {
    setError(t('admin.noMemberMatch'));
    return;
  }

  if (
    !window.confirm(
      t('admin.confirmAssignMember', {
        name: member.displayName,
        day: dayMap.value[activeSlot.value.dayOfWeek],
        hour: activeSlot.value.hour,
        room: activeSlot.value.roomNo
      })
    )
  ) {
    return;
  }

  moving.value = true;
  try {
    const { data } = await api.post('/admin/scheduling/assignments', {
      userId: member.userId,
      slotId: activeSlot.value.id
    });
    pushHistory({
      type: 'assign',
      assignmentId: data.id,
      userId: member.userId,
      slotId: activeSlot.value.id
    });
    setMessage(t('admin.memberAssigned'));
    await loadDraftSchedule();
  } catch (err) {
    setError(err);
  } finally {
    moving.value = false;
  }
}

async function applyHistory(entry, mode) {
  if (entry.type === 'assign') {
    if (mode === 'undo') {
      await api.delete(`/admin/scheduling/assignments/${entry.assignmentId}`);
      return;
    }
    const { data } = await api.post('/admin/scheduling/assignments', {
      userId: entry.userId,
      slotId: entry.slotId
    });
    entry.assignmentId = data.id;
    return;
  }

  if (entry.type === 'delete') {
    if (mode === 'undo') {
      const { data } = await api.post('/admin/scheduling/assignments', {
        userId: entry.userId,
        slotId: entry.slotId
      });
      entry.assignmentId = data.id;
      return;
    }
    await api.delete(`/admin/scheduling/assignments/${entry.assignmentId}`);
    return;
  }

  if (entry.type === 'move') {
    const slotId = mode === 'undo' ? entry.fromSlotId : entry.toSlotId;
    await api.patch(`/admin/scheduling/assignments/${entry.assignmentId}`, {
      slotId,
      swapIfOccupied: true
    });
  }
}

async function undoLastOperation() {
  if (!canUndo.value) {
    return;
  }
  const entry = historyStack.value[historyStack.value.length - 1];
  moving.value = true;
  try {
    await applyHistory(entry, 'undo');
    historyStack.value.pop();
    redoStack.value.push(entry);
    setMessage(t('admin.undoDone'));
    await loadDraftSchedule();
  } catch (err) {
    setError(err);
  } finally {
    moving.value = false;
  }
}

async function redoLastOperation() {
  if (!canRedo.value) {
    return;
  }
  const entry = redoStack.value[redoStack.value.length - 1];
  moving.value = true;
  try {
    await applyHistory(entry, 'redo');
    redoStack.value.pop();
    historyStack.value.push(entry);
    setMessage(t('admin.redoDone'));
    await loadDraftSchedule();
  } catch (err) {
    setError(err);
  } finally {
    moving.value = false;
  }
}

async function onSlotClick(slot) {
  if (!slot || moving.value || !draftReady.value) {
    return;
  }

  activeSlotId.value = slot.id;
  const targetAssignment = getAssignment(slot.id);

  if (!selectedAssignment.value) {
    if (targetAssignment) {
      selectedAssignmentId.value = targetAssignment.id;
    } else {
      selectedAssignmentId.value = 0;
    }
    return;
  }

  if (selectedAssignment.value.slotId === slot.id) {
    selectedAssignmentId.value = 0;
    return;
  }

  const selected = selectedAssignment.value;
  const shouldMove = window.confirm(
    t('admin.confirmMoveAssignment', {
      name: selected.displayName,
      day: dayMap.value[slot.dayOfWeek],
      hour: slot.hour,
      room: slot.roomNo
    })
  );
  if (!shouldMove) {
    return;
  }

  moving.value = true;
  try {
    await api.patch(`/admin/scheduling/assignments/${selected.id}`, {
      slotId: slot.id,
      swapIfOccupied: true
    });
    pushHistory({
      type: 'move',
      assignmentId: selected.id,
      fromSlotId: selected.slotId,
      toSlotId: slot.id
    });
    setMessage(targetAssignment ? t('admin.assignmentSwapped') : t('admin.assignmentMoved'));
    selectedAssignmentId.value = 0;
    await loadDraftSchedule();
  } catch (err) {
    setError(err);
  } finally {
    moving.value = false;
  }
}

onMounted(async () => {
  try {
    await loadSemesters();
    await loadDraftSchedule(selectedSemesterId.value);
    await nextTick();
    updateArrangeInterfaceState();
    window.addEventListener('scroll', updateArrangeInterfaceState, { passive: true });
    window.addEventListener('resize', updateArrangeInterfaceState);
  } catch (err) {
    setError(err);
  }
});

onBeforeUnmount(() => {
  window.removeEventListener('scroll', updateArrangeInterfaceState);
  window.removeEventListener('resize', updateArrangeInterfaceState);
});

watch(
  () => [draftReady.value, slots.value.length],
  async () => {
    await nextTick();
    updateArrangeInterfaceState();
  }
);
</script>

<style scoped>
.panel {
  padding: 1rem;
}

.controls {
  margin-bottom: 0.65rem;
  flex-wrap: wrap;
}

.controls.compact {
  margin: 0;
}

.warn-text {
  color: #ffb8b8;
}

.action-row {
  margin-top: 0.55rem;
}

.section-space {
  margin-top: 0.85rem;
}

.form {
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
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

.calendar-board {
  margin-top: 1rem;
}

.preview-panel {
  margin-bottom: 1rem;
}

.quick-action-toggle {
  position: fixed;
  right: 1rem;
  bottom: 1rem;
  z-index: 36;
}

.quick-action-bar {
  margin-top: 0;
  position: fixed;
  right: 1rem;
  top: 92px;
  bottom: auto;
  width: 320px;
  max-height: calc(100vh - 108px);
  overflow: auto;
  z-index: 35;
  padding: 0.7rem 0.9rem;
  border: 1px solid var(--line);
  background: rgba(15, 18, 21, 0.94);
  backdrop-filter: blur(8px);
  box-shadow: 0 14px 28px rgba(0, 0, 0, 0.32);
}

.quick-action-bar h3 {
  margin: 0 0 0.55rem;
  font-size: 0.92rem;
}

.quick-summary {
  margin-top: 0.65rem;
  padding-top: 0.55rem;
  border-top: 1px solid var(--line);
}

.quick-member {
  margin-top: 0.55rem;
  padding-top: 0.55rem;
  border-top: 1px solid var(--line);
}

.semester-list {
  margin-top: 0.85rem;
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}

.semester-chip {
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--panel-soft);
  color: var(--ink);
  padding: 0.7rem 0.85rem;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.75rem;
  text-align: left;
  cursor: pointer;
}

.semester-chip.active {
  border-color: var(--accent);
}

.compliance-panel,
.guidance-panel,
.slot-editor,
.operation-panel,
.unsatisfied-panel {
  margin-top: 0.75rem;
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 0.6rem 0.7rem;
  background: var(--panel-soft);
}

.compliance-panel h3,
.guidance-panel h3,
.slot-editor h3,
.operation-panel h3,
.unsatisfied-panel h3 {
  margin: 0;
  font-size: 0.95rem;
}

.compliance-panel p,
.guidance-panel p,
.slot-editor p {
  margin: 0.35rem 0 0;
}

.operation-list {
  margin: 0.5rem 0 0;
  padding-left: 1.1rem;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.member-picker-grid {
  margin-top: 0.35rem;
  max-height: 270px;
  overflow: auto;
  display: grid;
  gap: 0.35rem;
}

.member-chip {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel-soft);
  color: var(--ink);
  padding: 0.4rem 0.5rem;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.45rem;
  text-align: left;
  cursor: pointer;
}

.member-chip.active {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px rgba(240, 240, 240, 0.28);
}

.chip-meta {
  color: var(--muted);
  font-size: 0.78rem;
  white-space: nowrap;
}

.preview-wrap {
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: 10px;
}

.preview-table {
  min-width: 1160px;
}

.preview-table th {
  white-space: nowrap;
  font-size: 0.8rem;
  color: var(--muted);
  background: #11151a;
}

.preview-table td {
  font-size: 0.83rem;
  vertical-align: middle;
}

.preview-table td.empty {
  color: var(--muted);
}

.time-col {
  width: 82px;
  white-space: nowrap;
  color: var(--muted);
  font-size: 0.83rem;
}

.arrange-card {
  padding: 0.8rem 0.85rem 0.9rem;
}

.arrange-head {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
  align-items: flex-start;
  margin-bottom: 0.55rem;
}

.arrange-head h3 {
  margin: 0;
  font-size: 1rem;
}

.arrange-head .subtle {
  margin: 0.25rem 0 0;
}

.arrange-wrap {
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: rgba(7, 9, 12, 0.3);
}

.arrange-table {
  min-width: 1320px;
}

.arrange-table th,
.arrange-table td {
  padding: 0.38rem;
  border-bottom: 1px solid var(--line);
  vertical-align: middle;
}

.arrange-table thead th {
  position: sticky;
  top: 0;
  z-index: 2;
  background: #101318;
}

.sticky-col {
  position: sticky;
  left: 0;
  z-index: 3;
  background: #101318;
}

.arrange-table tbody .sticky-col {
  background: #0f1215;
}

.day-header,
.room-header {
  text-align: center;
  color: var(--muted);
  font-size: 0.78rem;
  letter-spacing: 0.02em;
}

.arrange-cell {
  width: 146px;
}

.slot-btn {
  width: 100%;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: rgba(24, 28, 33, 0.88);
  color: var(--ink);
  min-height: 54px;
  padding: 0.36rem 0.42rem;
  display: flex;
  flex-direction: column;
  gap: 0.14rem;
  text-align: left;
  cursor: pointer;
}

.slot-btn.occupied {
  border-color: #4b5159;
}

.slot-btn.source {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px rgba(240, 240, 240, 0.2);
}

.slot-btn.target {
  border-style: dashed;
}

.slot-btn.active {
  outline: 1px solid rgba(255, 255, 255, 0.44);
}

.slot-btn:disabled {
  cursor: wait;
  opacity: 0.8;
}

.slot-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.35rem;
}

.name {
  font-size: 0.82rem;
  font-weight: 700;
  line-height: 1.2;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hint {
  font-size: 0.72rem;
  color: var(--muted);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.count-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 1.4rem;
  height: 1.2rem;
  padding: 0 0.35rem;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.06);
  color: var(--muted);
  font-size: 0.69rem;
  font-weight: 700;
}

.unsatisfied-panel table th,
.unsatisfied-panel table td {
  font-size: 0.83rem;
}

@media (max-width: 900px) {
  .quick-action-toggle {
    right: 0.75rem;
    bottom: 0.75rem;
  }

  .quick-action-bar {
    top: auto;
    right: 0.75rem;
    left: 0.75rem;
    bottom: 4rem;
    width: auto;
    max-height: 58vh;
    padding: 0.65rem 0.75rem;
  }

  .member-chip {
    flex-direction: column;
    align-items: flex-start;
  }

  .arrange-card {
    padding: 0.7rem;
  }
}
</style>

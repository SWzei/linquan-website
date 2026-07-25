<template>
  <section class="grid-2">
    <article class="card panel">
      <h2 class="section-title">{{ t('schedule.title') }}</h2>
      <p class="subtle">{{ t('schedule.subtitle') }}</p>

      <div class="field semester-field">
        <label>{{ t('schedule.semesterSelect') }}</label>
        <select v-model.number="selectedSemesterId" :disabled="loadingSemesters || semesters.length === 0">
          <option :value="0">{{ t('common.choose') }}</option>
          <option v-for="item in semesters" :key="item.id" :value="item.id">
            {{ item.name }}
          </option>
        </select>
      </div>

      <p v-if="currentSemester" class="subtle semester-note">
        {{ t('schedule.currentSemesterInfo', {
          name: currentSemester.name,
          start: currentSemester.startDate,
          end: currentSemester.endDate
        }) }}
      </p>
      <p v-else class="subtle semester-note">{{ t('schedule.noSemesters') }}</p>

      <label class="toggle class-matching-toggle" v-if="selectedSemesterId">
        <input type="checkbox" v-model="classMatchingPriority" />
        {{ t('schedule.classMatchingPriority') }}
      </label>
      <p v-if="selectedSemesterId" class="subtle">{{ t('schedule.classMatchingPriorityHint') }}</p>

      <div class="days">
        <section v-for="day in days" :key="day.value" class="day-card">
          <h3>{{ day.label }}</h3>
          <table>
            <thead>
              <tr>
                <th>{{ t('schedule.headerTime') }}</th>
                <th>{{ t('schedule.headerRoom1') }}</th>
                <th>{{ t('schedule.headerRoom2') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="hour in hours" :key="hour">
                <td>{{ toHourRange(hour) }}</td>
                <td>
                  <label v-if="slotAt(day.value, hour, 1)" class="slot-cell">
                    <input
                      type="checkbox"
                      :checked="selectedSlotIds.includes(slotAt(day.value, hour, 1).id)"
                      @change="toggleSlot(slotAt(day.value, hour, 1).id, $event.target.checked)"
                    />
                    <span>{{ t('schedule.selectedCount', { count: slotAt(day.value, hour, 1).selectedCount }) }}</span>
                  </label>
                </td>
                <td>
                  <label v-if="slotAt(day.value, hour, 2)" class="slot-cell">
                    <input
                      type="checkbox"
                      :checked="selectedSlotIds.includes(slotAt(day.value, hour, 2).id)"
                      @change="toggleSlot(slotAt(day.value, hour, 2).id, $event.target.checked)"
                    />
                    <span>{{ t('schedule.selectedCount', { count: slotAt(day.value, hour, 2).selectedCount }) }}</span>
                  </label>
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>

      <div class="row">
        <button class="btn" @click="submitPreferences" :disabled="saving || !selectedSemesterId">
          {{ saving ? t('schedule.saving') : t('schedule.save') }}
        </button>
        <span class="subtle">{{ t('schedule.selectedSlots', { count: selectedSlotIds.length }) }}</span>
      </div>
    </article>

    <article class="card panel">
      <h2 class="section-title">{{ t('schedule.assignmentTitle') }}</h2>
      <p class="subtle">{{ t('schedule.assignmentSubtitle') }}</p>
      <ul v-if="assignmentList.length" class="assignment-list">
        <li v-for="item in assignmentList" :key="item.id">
          <strong>{{ daysByValue[item.dayOfWeek] }}</strong>
          {{ toHourRange(item.hour) }} · {{ t('common.room') }} {{ item.roomNo }}
        </li>
      </ul>
      <p v-else class="subtle">{{ t('schedule.noAssignment') }}</p>
    </article>
  </section>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import api from '@/services/api';
import { useI18n } from '@/i18n';
import { useToast } from '@/composables/toast';

const { t } = useI18n();
const { showSuccess, showError } = useToast();

const days = computed(() => [
  { value: 0, label: t('day.sun') },
  { value: 1, label: t('day.mon') },
  { value: 2, label: t('day.tue') },
  { value: 3, label: t('day.wed') },
  { value: 4, label: t('day.thu') },
  { value: 5, label: t('day.fri') },
  { value: 6, label: t('day.sat') }
]);

const daysByValue = computed(() => {
  const map = {};
  for (const item of days.value) {
    map[item.value] = item.label;
  }
  return map;
});

const hours = Array.from({ length: 14 }, (_, index) => 8 + index);

const semesters = ref([]);
const selectedSemesterId = ref(0);
const loadingSemesters = ref(false);
const slots = ref([]);
const selectedSlotIds = ref([]);
const assignmentList = ref([]);
const saving = ref(false);
const classMatchingPriority = ref(false);

const currentSemester = computed(
  () => semesters.value.find((item) => item.id === selectedSemesterId.value) || null
);

const slotMap = computed(() => {
  const map = new Map();
  for (const slot of slots.value) {
    map.set(`${slot.dayOfWeek}-${slot.hour}-${slot.roomNo}`, slot);
  }
  return map;
});

function slotAt(day, hour, room) {
  return slotMap.value.get(`${day}-${hour}-${room}`) || null;
}

function toHourRange(hour) {
  const start = `${String(hour).padStart(2, '0')}:00`;
  const end = `${String(hour + 1).padStart(2, '0')}:00`;
  return `${start} - ${end}`;
}

function toggleSlot(slotId, checked) {
  if (checked) {
    if (!selectedSlotIds.value.includes(slotId)) {
      selectedSlotIds.value = [...selectedSlotIds.value, slotId];
    }
    return;
  }
  selectedSlotIds.value = selectedSlotIds.value.filter((id) => id !== slotId);
}

async function loadSemesters() {
  loadingSemesters.value = true;
  try {
    const { data } = await api.get('/scheduling/semesters');
    semesters.value = data.items || [];
    if (semesters.value.length === 0) {
      selectedSemesterId.value = 0;
      return;
    }
    if (!semesters.value.some((item) => item.id === selectedSemesterId.value)) {
      selectedSemesterId.value = Number(data.currentSemesterId || semesters.value[0]?.id || 0);
    }
  } finally {
    loadingSemesters.value = false;
  }
}

async function loadSlots() {
  if (!selectedSemesterId.value) {
    slots.value = [];
    selectedSlotIds.value = [];
    classMatchingPriority.value = false;
    return;
  }
  const { data } = await api.get('/scheduling/slots', {
    params: { semesterId: selectedSemesterId.value }
  });
  slots.value = data.items || [];
  classMatchingPriority.value = Boolean(data.classMatchingPriority);
  selectedSlotIds.value = slots.value
    .filter((slot) => Number(slot.selectedByMe) === 1)
    .map((slot) => slot.id);
}

async function loadAssignment() {
  if (!selectedSemesterId.value) {
    assignmentList.value = [];
    return;
  }
  const { data } = await api.get('/scheduling/my-assignment', {
    params: { semesterId: selectedSemesterId.value }
  });
  assignmentList.value = data.assignments || [];
}

async function loadScheduleData() {
  if (!selectedSemesterId.value) {
    slots.value = [];
    selectedSlotIds.value = [];
    assignmentList.value = [];
    classMatchingPriority.value = false;
    return;
  }
  await Promise.all([loadSlots(), loadAssignment()]);
}

async function submitPreferences() {
  if (!selectedSemesterId.value) {
    showError(t('schedule.noSemesters'));
    return;
  }
  if (!window.confirm(t('schedule.confirmSave'))) {
    return;
  }
  saving.value = true;
  try {
    await api.post('/scheduling/preferences', {
      semesterId: selectedSemesterId.value,
      slotIds: selectedSlotIds.value,
      classMatchingPriority: classMatchingPriority.value
    });
    showSuccess(t('schedule.saveSuccess'));
    await loadSlots();
  } catch (err) {
    showError(err, t('schedule.saveFailed'));
  } finally {
    saving.value = false;
  }
}

watch(selectedSemesterId, async () => {
  try {
    await loadScheduleData();
  } catch (err) {
    showError(err, t('schedule.loadFailed'));
  }
});

onMounted(async () => {
  try {
    await loadSemesters();
    await loadScheduleData();
  } catch (err) {
    showError(err, t('schedule.loadFailed'));
  }
});
</script>

<style scoped>
.panel {
  padding: 1rem;
}

.semester-field {
  max-width: 320px;
}

.semester-note {
  margin-top: 0.4rem;
}

.days {
  max-height: 68vh;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 0.8rem;
  margin: 0.8rem 0;
}

.day-card {
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 0.75rem;
  background: var(--panel-soft);
}

.day-card h3 {
  margin: 0 0 0.45rem;
  font-size: 1rem;
}

.slot-cell {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.9rem;
}

.assignment-list {
  list-style: none;
  padding: 0;
  margin: 1rem 0 0;
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
}

.assignment-list li {
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--panel-soft);
  padding: 0.65rem;
}

.toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  margin: 0.35rem 0 0.15rem;
  font-size: 0.92rem;
  color: var(--muted);
}

.class-matching-toggle {
  margin-top: 0.85rem;
}
</style>

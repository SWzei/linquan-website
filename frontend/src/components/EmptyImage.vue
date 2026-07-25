<template>
  <div class="empty-image" :class="{ compact }" role="img" :aria-label="label">
    <span aria-hidden="true">♪</span>
    <small v-if="!compact">{{ label }}</small>
  </div>
</template>

<script setup>
defineProps({
  label: { type: String, required: true },
  compact: { type: Boolean, default: false }
});
</script>

<style scoped>
.empty-image {
  min-height: 10rem;
  width: 100%;
  display: grid;
  place-content: center;
  gap: .45rem;
  text-align: center;
  color: var(--muted);
  border: 1px dashed var(--line);
  border-radius: 12px;
  background: linear-gradient(145deg, var(--panel-soft), rgba(255, 255, 255, .02));
}
.empty-image span { font-size: 2rem; }
.empty-image small { font-size: .8rem; }
.empty-image.compact { min-height: 0; width: 3rem; height: 3rem; border-radius: 50%; }
.empty-image.compact span { font-size: 1.1rem; }
</style>

<template>
  <transition name="center-toast-fade">
    <div v-if="toastState.visible" class="center-toast" :class="toastState.type" role="status" aria-live="polite">
      {{ toastState.text }}
    </div>
  </transition>
</template>

<script setup>
import { useToast } from '@/composables/toast';

const { toastState } = useToast();
</script>

<style scoped>
.center-toast {
  position: fixed;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  z-index: 1200;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: rgba(18, 20, 24, 0.92);
  color: var(--ink);
  min-width: min(86vw, 320px);
  max-width: min(90vw, 560px);
  padding: 0.85rem 1rem;
  text-align: center;
  box-shadow: 0 20px 46px rgba(0, 0, 0, 0.5);
  font-weight: 700;
  backdrop-filter: blur(8px);
}

.center-toast.success {
  border-color: #4f9a5f;
}

.center-toast.error {
  border-color: #c16363;
}

.center-toast-fade-enter-active,
.center-toast-fade-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.center-toast-fade-enter-from,
.center-toast-fade-leave-to {
  opacity: 0;
  transform: translate(-50%, calc(-50% + 8px));
}
</style>

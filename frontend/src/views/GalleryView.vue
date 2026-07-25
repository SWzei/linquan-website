<template>
  <PhotoGallery
    :title="t('gallery.title')"
    :subtitle="t('gallery.subtitle')"
    :hint="t('gallery.hint')"
    :items="galleryItems"
    :empty-text="t('gallery.empty')"
  />
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import api from '@/services/api';
import PhotoGallery from '@/components/PhotoGallery.vue';
import { useI18n } from '@/i18n';
import { useToast } from '@/composables/toast';

const { t, locale } = useI18n();
const { showError } = useToast();
const remoteItems = ref([]);
const loaded = ref(false);
const meaninglessAlt = /^(?:无|没有|none|n\/?a|-+)$/i;

function accessibleAlt(primary, secondary, title) {
  for (const candidate of [primary, secondary, title]) {
    const value = String(candidate || '').trim();
    if (value && !meaninglessAlt.test(value)) return value;
  }
  return '';
}

const galleryItems = computed(() => {
  if (!loaded.value) return [];
  const useZh = locale.value === 'zh';
  return remoteItems.value.map((item) => {
    const title = useZh ? (item.titleZh || item.titleEn || '') : (item.titleEn || item.titleZh || '');
    const primaryAlt = useZh ? item.altZh : item.altEn;
    const secondaryAlt = useZh ? item.altEn : item.altZh;
    return {
      id: item.id,
      src: item.src,
      fallback: item.fallback || '',
      title,
      description: useZh ? (item.descriptionZh || item.descriptionEn || '') : (item.descriptionEn || item.descriptionZh || ''),
      alt: accessibleAlt(primaryAlt, secondaryAlt, title)
    };
  });
});

onMounted(async () => {
  try {
    const { data } = await api.get('/gallery');
    remoteItems.value = data.items || [];
    loaded.value = remoteItems.value.length > 0;
  } catch (err) {
    showError(err, t('gallery.loadFailed'));
  }
});
</script>

<template>
  <section class="card panel gallery-panel">
    <div class="gallery-header">
      <div>
        <h2>{{ title }}</h2>
        <p class="subtle">{{ subtitle }}</p>
      </div>
      <p v-if="hint" class="subtle gallery-hint">{{ hint }}</p>
    </div>

    <p v-if="items.length === 0" class="gallery-empty" role="status">{{ emptyText }}</p>
    <div v-else class="gallery-grid">
      <figure v-for="item in items" :key="item.id" class="photo-card">
        <img
          :src="item.src"
          :alt="item.alt || item.title"
          loading="lazy"
          @error="onImageError($event, item.fallback)"
        />
        <figcaption>
          <strong>{{ item.title }}</strong>
          <span>{{ item.description }}</span>
        </figcaption>
      </figure>
    </div>
  </section>
</template>

<script setup>
defineProps({
  title: {
    type: String,
    required: true
  },
  subtitle: {
    type: String,
    default: ''
  },
  hint: {
    type: String,
    default: ''
  },
  items: {
    type: Array,
    default: () => []
  },
  emptyText: { type: String, default: 'No images available.' }
});

function onImageError(event, fallback) {
  const image = event.target;
  if (!image || typeof image !== 'object') {
    return;
  }
  if (!fallback || image.dataset.fallbackApplied === '1') {
    return;
  }
  image.dataset.fallbackApplied = '1';
  image.src = fallback;
}
</script>

<style scoped>
.gallery-panel {
  padding: 1rem;
  margin-top: 1rem;
}

.gallery-header {
  display: flex;
  justify-content: space-between;
  gap: 0.9rem;
  flex-wrap: wrap;
}

.gallery-header h2 {
  margin: 0;
  font-size: 1.15rem;
}

.gallery-header p {
  margin: 0.2rem 0 0;
}

.gallery-hint {
  max-width: 340px;
}

.gallery-grid {
  margin-top: 0.9rem;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.75rem;
}

.gallery-empty {
  margin: .9rem 0 0;
  padding: 2.2rem 1rem;
  text-align: center;
  color: var(--muted);
  border: 1px dashed var(--line);
  border-radius: 12px;
  background: var(--panel-soft);
}

.photo-card {
  margin: 0;
  border: 1px solid var(--line);
  border-radius: 12px;
  overflow: hidden;
  background: var(--panel-soft);
}

.photo-card img {
  width: 100%;
  aspect-ratio: 4 / 3;
  object-fit: cover;
  display: block;
}

.photo-card figcaption {
  padding: 0.58rem 0.62rem 0.68rem;
  display: flex;
  flex-direction: column;
  gap: 0.22rem;
}

.photo-card strong {
  font-size: 0.9rem;
}

.photo-card span {
  font-size: 0.82rem;
  color: var(--muted);
  white-space: pre-wrap;
}

@media (max-width: 980px) {
  .gallery-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 620px) {
  .gallery-grid {
    grid-template-columns: 1fr;
  }
}
</style>

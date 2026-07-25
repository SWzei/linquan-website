import { reactive } from 'vue';

const toastState = reactive({
  visible: false,
  text: '',
  type: 'info'
});

let hideTimer = null;

function clearHideTimer() {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
}

function hideToast() {
  clearHideTimer();
  toastState.visible = false;
}

function showToast(text, type = 'info', duration = 2400) {
  const content = String(text || '').trim();
  if (!content) {
    return;
  }
  clearHideTimer();
  toastState.text = content;
  toastState.type = type;
  toastState.visible = true;
  hideTimer = setTimeout(() => {
    toastState.visible = false;
    hideTimer = null;
  }, duration);
}

function showSuccess(text, duration = 2200) {
  showToast(text, 'success', duration);
}

function isInternalErrorMessage(text) {
  return /SQLITE_|constraint failed|duplicate key|better-sqlite3|no such table|syntax error|SELECT |INSERT |UPDATE /i.test(String(text || ''));
}

export function extractApiError(err, fallback = '') {
  if (typeof err === 'string') return err;
  const payload = err?.response?.data;
  const message = String(payload?.message || '').trim();
  const details = payload?.details;
  const detail = Array.isArray(details)
    ? details.map((item) => item?.message || item).find(Boolean)
    : typeof details === 'string'
      ? details
      : '';
  const combined = [message, detail && detail !== message ? detail : ''].filter(Boolean).join(': ');
  return combined || String(fallback || err?.message || '').trim();
}

function showError(err, fallback = '') {
  const rawText = extractApiError(err, fallback);
  const text = fallback && isInternalErrorMessage(rawText) ? String(fallback) : rawText;
  showToast(text, 'error', 2800);
}

export function useToast() {
  return {
    toastState,
    showToast,
    showSuccess,
    showError,
    hideToast
  };
}

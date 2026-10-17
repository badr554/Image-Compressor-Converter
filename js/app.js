/**
 * PixelSqueeze — app.js (v2)
 * UI controller, state, ZIP/fallback download, comparison slider, progress, accessibility.
 */

import { processFile, formatBytes, mimeToExt, getOutputFilename, MAX_FILE_SIZE } from '/js/processor.js';

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  files: [],
  activeTab: 'compress',
  debounceTimer: null,
  zipNamesUsed: new Set(),   // track ZIP filenames for dedup
  singleNamesUsed: new Set(),
};

// ── DOM helpers ───────────────────────────────────────────────────────────────
const $  = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

// ── Element refs ──────────────────────────────────────────────────────────────
const dropZone       = $('#drop-zone');
const fileInput      = $('#file-input');
const resultsList    = $('#results-list');
const tabBtns        = $$('.tab-btn');
const settingPanels  = $$('.settings-panel');
const qualitySlider  = $('#quality-slider');
const qualityVal     = $('#quality-val');
const formatSelect   = $('#format-select');
const maxWidthIn     = $('#max-width');
const maxHeightIn    = $('#max-height');
const aspectChk      = $('#aspect-ratio');
const targetKBIn     = $('#target-kb');
const pngColorsIn    = $('#png-colors');
const pngColorsVal   = $('#png-colors-val');
const btnDownloadAll = $('#btn-download-all');
const btnClearAll    = $('#btn-clear-all');
const resultsSection = $('#results-section');
const resultsCount   = $('#results-count');
const overallBar     = $('#overall-progress-bar');
const overallWrap    = $('#overall-progress');
const themeToggle    = $('#theme-toggle');
const mobileMenuBtn  = $('#mobile-menu-btn');
const siteNav        = $('#site-nav');
const modal          = $('#comparison-modal');
const modalClose     = $('#modal-close');

// ── Theme ─────────────────────────────────────────────────────────────────────
function initTheme() {
  const saved = localStorage.getItem('ps-theme') || 'light';
  document.documentElement.setAttribute('data-theme', saved);
}

themeToggle?.addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('ps-theme', next);
});

// ── Mobile nav ────────────────────────────────────────────────────────────────
mobileMenuBtn?.addEventListener('click', () => {
  const open = siteNav?.classList.toggle('open');
  mobileMenuBtn.setAttribute('aria-expanded', String(open));
});

// ── Tabs ──────────────────────────────────────────────────────────────────────
tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    state.activeTab = btn.dataset.tab;
    tabBtns.forEach(b => {
      b.classList.remove('active');
      b.setAttribute('aria-selected', 'false');
    });
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');
    settingPanels.forEach(p => {
      p.classList.toggle('visible', p.dataset.tab === state.activeTab);
    });
    scheduleReprocess();
  });
});

// ── Quality sliders ───────────────────────────────────────────────────────────
$$('.quality-slider').forEach(slider => {
  const valEl = $('#' + slider.id.replace('slider', 'val'));
  slider.addEventListener('input', () => {
    if (valEl) valEl.textContent = slider.value;
    if (slider.id === 'quality-slider') scheduleReprocess();
  });
});

// PNG colors slider
pngColorsIn?.addEventListener('input', () => {
  if (pngColorsVal) pngColorsVal.textContent = pngColorsIn.value;
  scheduleReprocess();
});

// Format/input changes
[formatSelect, maxWidthIn, maxHeightIn, targetKBIn, aspectChk].forEach(el => {
  el?.addEventListener('change', scheduleReprocess);
  el?.addEventListener('input', scheduleReprocess);
});
const pngColorGroup = $('#png-colors-group');
function updatePngColorVisibility() {
  if (pngColorGroup) pngColorGroup.style.display = formatSelect?.value === 'png' ? '' : 'none';
}
formatSelect?.addEventListener('change', updatePngColorVisibility);
updatePngColorVisibility();

function scheduleReprocess() {
  if (state.files.length === 0) return;
  clearTimeout(state.debounceTimer);
  state.debounceTimer = setTimeout(processAll, 600);
}

// ── Drop zone ─────────────────────────────────────────────────────────────────
dropZone?.addEventListener('click', (e) => {
  if (e.target.closest('.btn-choose') || e.target === dropZone || e.target.closest('.drop-zone-icon')) {
    fileInput?.click();
  }
});

// Keyboard accessible drop zone
dropZone?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fileInput?.click();
  }
});

dropZone?.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
  dropZone.setAttribute('aria-dropeffect', 'copy');
});

dropZone?.addEventListener('dragleave', (e) => {
  if (!dropZone.contains(e.relatedTarget)) {
    dropZone.classList.remove('drag-over');
    dropZone.removeAttribute('aria-dropeffect');
  }
});

dropZone?.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  handleFiles([...e.dataTransfer.files]);
});

fileInput?.addEventListener('change', () => {
  handleFiles([...fileInput.files]);
  fileInput.value = '';
});

// Clipboard paste
document.addEventListener('paste', (e) => {
  const items = [...(e.clipboardData?.items || [])];
  const imageFiles = items
    .filter(i => i.kind === 'file' && i.type.startsWith('image/'))
    .map(i => i.getAsFile())
    .filter(Boolean);
  if (imageFiles.length) handleFiles(imageFiles);
});

// ── File validation ───────────────────────────────────────────────────────────
const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp'];
const MAX_FILES = 50;

function handleFiles(files) {
  const errors = new Set();
  const warnings = new Set();
  let addedCount = 0;

  if (files.length + state.files.length > MAX_FILES) {
    errors.add(`Maximum ${MAX_FILES} files allowed. Only the first ${MAX_FILES - state.files.length} were added.`);
    files = files.slice(0, MAX_FILES - state.files.length);
  }

  files.forEach(file => {
    if (!ACCEPTED_TYPES.includes(file.type)) {
      errors.add(`"${file.name}": Unsupported format (${file.type || 'unknown'}). Accepted: JPG, PNG, WebP, GIF, BMP.`);
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      errors.add(`"${file.name}" is ${formatBytes(file.size)} — exceeds the 50 MB limit.`);
      return;
    }
    if (state.files.find(f => f.file.name === file.name && f.file.size === file.size)) return;

    // GIF animation warning
    if (file.type === 'image/gif') {
      warnings.add('Animated GIFs: only the first frame will be processed. Animation will be lost.');
    }

    addFile(file);
    addedCount++;
  });

  errors.forEach(msg => showToast(msg, 'error', 6000));
  warnings.forEach(msg => showToast(msg, 'warning', 7000));

  if (addedCount > 0) {
    resultsSection?.classList.remove('hidden');
    processAll();
  }
}

function addFile(file) {
  const id = `f-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const entry = { file, id, card: null, result: null, objectUrl: null, _thumbUrl: null };
  state.files.push(entry);
  const card = createCard(entry);
  entry.card = card;
  resultsList?.appendChild(card);
  updateCount();
}

// ── Result card DOM ───────────────────────────────────────────────────────────
function createCard(entry) {
  const card = document.createElement('article');
  card.className = 'result-card processing';
  card.dataset.id = entry.id;
  card.setAttribute('role', 'listitem');
  card.innerHTML = `
    <img class="result-thumb" src="" alt="" loading="lazy">
    <div class="result-info">
      <div class="result-name"></div>
      <div class="result-sizes">
        <span class="size-original"></span>
        <span class="size-arrow" aria-hidden="true">→</span>
        <span class="size-new" aria-live="polite">Processing…</span>
      </div>
      <div class="result-progress" role="progressbar" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100">
        <div class="result-progress-bar" style="width:0%"></div>
      </div>
    </div>
    <div class="result-card-actions">
      <button class="btn-icon btn-preview" title="Compare before/after" aria-label="Open before/after comparison" disabled>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      </button>
      <button class="btn-icon btn-download" title="Download" aria-label="Download processed image" disabled>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      </button>
      <button class="btn-icon danger btn-remove" title="Remove" aria-label="Remove image">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
  `;

  const filename = entry.file.name;
  const nameNode = card.querySelector('.result-name');
  const thumb = card.querySelector('.result-thumb');
  nameNode.textContent = filename;
  nameNode.title = filename;
  card.querySelector('.size-original').textContent = formatBytes(entry.file.size);
  card.querySelector('.result-progress').setAttribute('aria-label', `Processing ${filename}`);
  card.querySelector('.btn-preview').setAttribute('aria-label', `Open before/after comparison for ${filename}`);
  card.querySelector('.btn-download').setAttribute('aria-label', `Download ${filename}`);
  card.querySelector('.btn-remove').setAttribute('aria-label', `Remove ${filename}`);

  const thumbUrl = URL.createObjectURL(entry.file);
  thumb.alt = `Preview of ${filename}`;
  thumb.src = thumbUrl;
  entry._thumbUrl = thumbUrl;

  card.querySelector('.btn-preview').addEventListener('click', () => openComparison(entry));
  card.querySelector('.btn-remove').addEventListener('click', () => removeFile(entry.id));
  card.querySelector('.btn-download').addEventListener('click', () => downloadSingle(entry));
  return card;
}
function updateCardProgress(entry, pct) {
  const bar = entry.card?.querySelector('.result-progress-bar');
  const wrap = entry.card?.querySelector('.result-progress');
  if (bar) bar.style.width = pct + '%';
  if (wrap) wrap.setAttribute('aria-valuenow', String(pct));
}

function updateCardDone(entry) {
  const card = entry.card;
  if (!card) return;
  card.classList.remove('processing');

  const sizeNew  = card.querySelector('.size-new');
  const bar      = card.querySelector('.result-progress-bar');
  const wrap     = card.querySelector('.result-progress');
  const btnDl    = card.querySelector('.btn-download');
  const btnPrev  = card.querySelector('.btn-preview');
  const { originalSize, newSize, keptOriginal } = entry.result;

  const savedPct = ((originalSize - newSize) / originalSize * 100).toFixed(1);
  const bigger   = newSize >= originalSize;

  const badge = document.createElement('span');
  badge.className = `badge-saved${keptOriginal || bigger ? ' badge-larger' : ''}`;
  badge.textContent = keptOriginal ? 'Already optimized' : bigger ? 'Output larger' : `↓ ${savedPct}% saved`;
  sizeNew.textContent = formatBytes(keptOriginal ? originalSize : newSize) + ' ';
  sizeNew.appendChild(badge);

  const ratio = keptOriginal || bigger ? 0 : parseFloat(savedPct);
  bar.style.width = Math.min(ratio, 100) + '%';
  wrap.setAttribute('aria-valuenow', String(Math.min(ratio, 100)));

  btnDl.disabled = false;
  btnPrev.disabled = false;

  // Update thumb to processed version
  if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
  entry.objectUrl = URL.createObjectURL(entry.result.blob);
  const thumb = card.querySelector('.result-thumb');
  thumb.src = entry.objectUrl;
}

function updateCardError(entry, msg) {
  const card = entry.card;
  if (!card) return;
  card.classList.remove('processing');
  const status = card.querySelector('.size-new');
  status.textContent = msg;
  status.style.color = 'var(--rose-500)';
  status.style.fontSize = '0.8rem';
}

// ── Process all ───────────────────────────────────────────────────────────────
async function processAll() {
  if (state.files.length === 0) return;

  const opts = getOptions();

  // Reset cards
  state.files.forEach(entry => {
    entry.card?.classList.add('processing');
    const sizeNew = entry.card?.querySelector('.size-new');
    if (sizeNew) sizeNew.textContent = 'Processing…';
    updateCardProgress(entry, 0);
    entry.card?.querySelector('.btn-download')?.setAttribute('disabled', '');
    entry.card?.querySelector('.btn-preview')?.setAttribute('disabled', '');
    if (entry.objectUrl) { URL.revokeObjectURL(entry.objectUrl); entry.objectUrl = null; }
    entry.result = null;
  });

  showOverallProgress(0);

  const BATCH = 3;
  let completed = 0;

  for (let i = 0; i < state.files.length; i += BATCH) {
    const batch = state.files.slice(i, i + BATCH);
    await Promise.all(batch.map(async entry => {
      await processSingle(entry, opts);
      completed++;
      showOverallProgress(Math.round(completed / state.files.length * 100));
    }));
  }

  hideOverallProgress();
  updateBulkButtons();
  updateCount();
}

async function processSingle(entry, opts) {
  try {
    const result = await processFile(
      entry.file,
      opts,
      (pct) => updateCardProgress(entry, pct)
    );
    entry.result = result;
    updateCardDone(entry);
    if (result.warning) showToast(result.warning, 'warning', 7000);
  } catch (err) {
    updateCardError(entry, err.message || 'Processing failed. Try a different file.');
  }
}

function getOptions() {
  const tab = state.activeTab;

  // Unified: gather from active tab panel
  const activePanel = $(`.settings-panel[data-tab="${tab}"]`);
  const fmtEl = activePanel ? $('select', activePanel) : formatSelect;
  const qualEl = activePanel ? $('.quality-slider', activePanel) : qualitySlider;

  return {
    quality: parseInt(qualEl?.value ?? 80),
    format: fmtEl?.value ?? 'original',
    keepAspectRatio: aspectChk?.checked !== false,
    maxWidth: tab === 'resize' ? (parseInt(maxWidthIn?.value) || null) : null,
    maxHeight: tab === 'resize' ? (parseInt(maxHeightIn?.value) || null) : null,
    targetKB: tab === 'compress' ? (parseFloat(targetKBIn?.value) || null) : null,
    pngColors: parseInt(pngColorsIn?.value ?? 256),
    mode: tab,  // 'compress' | 'convert' | 'resize'
  };
}

// ── Overall progress bar ──────────────────────────────────────────────────────
function showOverallProgress(pct) {
  overallWrap?.classList.remove('hidden');
  if (overallBar) overallBar.style.width = pct + '%';
  overallWrap?.setAttribute('aria-valuenow', String(pct));
}

function hideOverallProgress() {
  setTimeout(() => overallWrap?.classList.add('hidden'), 800);
}

// ── Bulk actions ──────────────────────────────────────────────────────────────
function updateBulkButtons() {
  const hasResults = state.files.some(f => f.result);
  if (btnDownloadAll) btnDownloadAll.disabled = !hasResults;
  if (btnClearAll) btnClearAll.disabled = state.files.length === 0;
}

function updateCount() {
  if (resultsCount) {
    resultsCount.textContent = state.files.length;
  }
}

btnDownloadAll?.addEventListener('click', downloadAll);
btnClearAll?.addEventListener('click', clearAll);

async function downloadAll() {
  const readyFiles = state.files.filter(f => f.result?.blob);
  if (!readyFiles.length) return;

  // Check JSZip availability
  if (typeof JSZip === 'undefined') {
    showToast('ZIP library not available. Downloading files individually…', 'warning', 5000);
    downloadAllIndividually(readyFiles);
    return;
  }

  showToast('Preparing ZIP archive…');
  try {
    const zip = new JSZip();
    state.zipNamesUsed.clear();

    readyFiles.forEach(entry => {
      const fname = getOutputFilename(
        entry.file.name,
        entry.result.outputMime,
        entry.result.mode || state.activeTab,
        state.zipNamesUsed
      );
      zip.file(fname, entry.result.blob);
    });

    const content = await zip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 1 }
    });

    triggerDownload(content, 'pixelsqueeze-images.zip');
    showToast(`✓ Downloaded ${readyFiles.length} files as ZIP`, 'success');
  } catch (err) {
    showToast('ZIP failed: ' + err.message + '. Downloading individually…', 'error', 5000);
    downloadAllIndividually(readyFiles);
  }
}

function downloadAllIndividually(files) {
  const DELAY = 300; // ms between downloads to avoid browser blocking
  files.forEach((entry, i) => {
    setTimeout(() => downloadSingle(entry), i * DELAY);
  });
  showToast(`Downloading ${files.length} files individually…`, 'warning', 4000);
}

function clearAll() {
  state.files.forEach(freeEntry);
  state.files = [];
  state.singleNamesUsed.clear();
  state.zipNamesUsed.clear();
  if (resultsList) resultsList.innerHTML = '';
  resultsSection?.classList.add('hidden');
  updateBulkButtons();
  updateCount();
}

// ── Per-file actions ──────────────────────────────────────────────────────────
function removeFile(id) {
  const idx = state.files.findIndex(f => f.id === id);
  if (idx === -1) return;
  freeEntry(state.files[idx]);
  state.files[idx].card?.remove();
  state.files.splice(idx, 1);
  if (state.files.length === 0) resultsSection?.classList.add('hidden');
  updateBulkButtons();
  updateCount();
}

function freeEntry(entry) {
  if (entry.objectUrl) { URL.revokeObjectURL(entry.objectUrl); entry.objectUrl = null; }
  if (entry._thumbUrl) { URL.revokeObjectURL(entry._thumbUrl); entry._thumbUrl = null; }
  entry.result = null;
}

function downloadSingle(entry) {
  if (!entry.result?.blob) return;
  const fname = getOutputFilename(
    entry.file.name,
    entry.result.outputMime,
    entry.result.mode || state.activeTab,
    state.singleNamesUsed
  );
  triggerDownload(entry.result.blob, fname);
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}

// ── Before/After modal ────────────────────────────────────────────────────────
function openComparison(entry) {
  if (!entry.result?.blob) return;

  const container  = $('#comparison-container');
  const beforeImg  = $('#comparison-before-img');
  const afterImg   = $('#comparison-after-img');
  const divider    = $('#comparison-divider');
  const beforeDiv  = container?.querySelector('.comparison-before');
  const lblBefore  = $('#label-before');
  const lblAfter   = $('#label-after');

  if (!container || !beforeImg || !afterImg || !divider) return;

  beforeImg.src = entry._thumbUrl || '';
  afterImg.src  = entry.objectUrl || '';
  if (lblBefore) lblBefore.textContent = `Original – ${formatBytes(entry.file.size)}`;
  if (lblAfter)  lblAfter.textContent  = `Processed – ${formatBytes(entry.result.newSize)}`;

  divider.style.left = '50%';
  if (beforeDiv) beforeDiv.style.width = '50%';

  modal?.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  modal?.querySelector('.modal-box').focus();

  setupDividerDrag(container, divider, beforeDiv);
}

function setupDividerDrag(container, divider, beforeDiv) {
  // Remove previous listeners by cloning
  const newDiv = divider.cloneNode(true);
  divider.parentNode?.replaceChild(newDiv, divider);

  const move = (clientX) => {
    const rect = container.getBoundingClientRect();
    const pct = Math.max(2, Math.min(98, (clientX - rect.left) / rect.width * 100));
    newDiv.style.left = pct + '%';
    if (beforeDiv) beforeDiv.style.width = pct + '%';
  };

  let dragging = false;
  container.addEventListener('mousedown', (e) => { dragging = true; move(e.clientX); });
  document.addEventListener('mousemove', (e) => { if (dragging) move(e.clientX); });
  document.addEventListener('mouseup', () => { dragging = false; });
  container.addEventListener('touchstart', (e) => { dragging = true; move(e.touches[0].clientX); }, { passive: true });
  container.addEventListener('touchmove', (e) => { if (dragging) move(e.touches[0].clientX); }, { passive: false });
  container.addEventListener('touchend', () => { dragging = false; });
}

modalClose?.addEventListener('click', closeModal);
modal?.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

function closeModal() {
  modal?.classList.add('hidden');
  document.body.style.overflow = '';
}

// ── FAQ accordion ─────────────────────────────────────────────────────────────
$$('.faq-question').forEach(btn => {
  btn.addEventListener('click', () => {
    const item = btn.closest('.faq-item');
    const isOpen = item.classList.contains('open');
    $$('.faq-item.open').forEach(i => {
      i.classList.remove('open');
      i.querySelector('.faq-question')?.setAttribute('aria-expanded', 'false');
    });
    if (!isOpen) {
      item.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
    }
  });
});

// ── Toast ─────────────────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg, type = '', duration = 3500) {
  let toast = document.getElementById('ps-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'ps-toast';
    toast.setAttribute('role', 'alert');
    toast.setAttribute('aria-live', 'assertive');
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.className = `toast${type ? ' ' + type : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.remove(), duration);
}

// ── Presets from page (for SEO tool pages) ────────────────────────────────────
function applyPresets() {
  let presets = window.PS_PRESETS;
  if (!presets && document.body.dataset.psPresets) {
    try { presets = JSON.parse(document.body.dataset.psPresets); }
    catch { presets = null; }
  }
  if (!presets) return;

  if (presets.tab) {
    const btn = $(`.tab-btn[data-tab="${presets.tab}"]`);
    btn?.click();
  }

  // Apply format to ALL format selects
  if (presets.format) {
    $$('select[id^="format-select"]').forEach(el => { el.value = presets.format; });
  }

  if (presets.quality) {
    $$('.quality-slider').forEach(el => { el.value = presets.quality; });
    $$('[id$="quality-val"]').forEach(el => { el.textContent = presets.quality; });
  }

  if (presets.targetKB && targetKBIn) targetKBIn.value = presets.targetKB;
}

// ── Init ──────────────────────────────────────────────────────────────────────
function init() {
  initTheme();

  // Activate compress tab by default
  const defaultTab = $('.tab-btn[data-tab="compress"]');
  if (defaultTab && !defaultTab.classList.contains('active')) {
    defaultTab.click();
  } else {
    // Ensure panel is visible
    $('.settings-panel[data-tab="compress"]')?.classList.add('visible');
  }

  updateBulkButtons();
  applyPresets();
}

init();

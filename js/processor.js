/**
 * PixelSqueeze — processor.js (v2)
 * Worker bridge with full main-thread fallback using chunked async processing.
 * Handles: UPNG.js for PNG, EXIF orientation, large image protection,
 * progress callbacks, memory cleanup.
 */

const WORKER_URL = new URL('/js/worker.js', location.href).href;
const MAX_DIMENSION = 16000;
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

// Check for OffscreenCanvas support
const SUPPORTS_OFFSCREEN = (() => {
  try {
    new OffscreenCanvas(1, 1).getContext('2d');
    return true;
  } catch (e) {
    return false;
  }
})();

let worker = null;
const pendingCallbacks = new Map();
let callbackId = 0;
let upngLoadPromise = null;

// ── Worker pool (single persistent worker) ────────────────────────────────────
function getWorker() {
  if (!SUPPORTS_OFFSCREEN) return null;
  if (worker) return worker;

  try {
    worker = new Worker(WORKER_URL);
    worker.onmessage = handleWorkerMessage;
    worker.onerror = (err) => {
      console.warn('PixelSqueeze worker error, falling back to main thread:', err);
      // Reject all pending and disable worker
      pendingCallbacks.forEach(({ reject }) => reject(new Error('Worker failed')));
      pendingCallbacks.clear();
      worker = null;
    };
    return worker;
  } catch (e) {
    worker = null;
    return null;
  }
}

function handleWorkerMessage(e) {
  const { id, type, ...data } = e.data;
  const cb = pendingCallbacks.get(id);
  if (!cb) return;

  if (type === 'progress') {
    cb.onProgress?.(data.pct);
    return;
  }

  // type === 'done'
  pendingCallbacks.delete(id);
  if (data.success) cb.resolve(data);
  else cb.reject(new Error(data.error));
}

// ── Public API ────────────────────────────────────────────────────────────────
/**
 * Process a single image file.
 * @param {File} file
 * @param {object} options
 * @param {function} onProgress  - called with 0-100
 * @returns {Promise<{blob, originalSize, newSize, outputMime, width, height, keptOriginal}>}
 */
export async function processFile(file, options, onProgress = () => {}) {
  const w = getWorker();

  if (w) {
    const id = ++callbackId;
    return new Promise((resolve, reject) => {
      pendingCallbacks.set(id, { resolve, reject, onProgress });
      w.postMessage({ id, file, options });
    });
  }

  // Fallback: main-thread chunked processing
  return processOnMainThread(file, options, onProgress);
}

// ── Main-thread fallback ──────────────────────────────────────────────────────
async function processOnMainThread(file, options, onProgress) {
  const {
    quality = 80,
    format = 'original',
    maxWidth = null,
    maxHeight = null,
    keepAspectRatio = true,
    targetKB = null,
    pngColors = 256,
    mode = 'compress',
  } = options;

  const inputMime = file.type;
  const outputMime = resolveOutputMime(format, inputMime);

  onProgress(10);

  // Decode with orientation fix — yield to browser between steps
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (err) {
    throw new Error(`Cannot decode "${file.name}". The file may be corrupt.`);
  }

  // Yield to keep UI responsive
  await yieldToMain();
  onProgress(30);

  let { width, height } = bitmap;

  // Cap large images
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    const ratio = Math.min(MAX_DIMENSION / width, MAX_DIMENSION / height);
    width = Math.round(width * ratio);
    height = Math.round(height * ratio);
  }

  if (maxWidth || maxHeight) {
    ({ width, height } = computeDimensions(width, height, maxWidth, maxHeight, keepAspectRatio));
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  if (outputMime === 'image/jpeg') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
  }

  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close(); // release memory

  await yieldToMain();
  onProgress(60);

  let blob;

  if (targetKB && outputMime !== 'image/png') {
    blob = await binarySearchMainThread(canvas, outputMime, targetKB);
  } else if (outputMime === 'image/png') {
    // UPNG quantizes PNG colors on the main thread when its CDN libraries load.
    try {
      const upng = await loadUPNG();
      if (upng && typeof upng.encode === 'function') {
        const imageData = ctx.getImageData(0, 0, width, height);
        const encoded = upng.encode([imageData.data.buffer], width, height, pngColors);
        blob = new Blob([encoded], { type: 'image/png' });
      }
    } catch (err) {
      console.warn('UPNG unavailable in main-thread fallback; using canvas PNG encoder:', err);
    }
    if (!blob) blob = await canvasToBlob(canvas, 'image/png', undefined);
  } else {
    blob = await canvasToBlob(canvas, outputMime, quality / 100);
  }

  onProgress(90);

  // Keep original if output is larger (compress-only mode)
  if (blob.size >= file.size && format === 'original' && !targetKB && !maxWidth && !maxHeight) {
    const origBlob = file.slice(0, file.size, file.type);
    return {
      blob: origBlob,
      originalSize: file.size,
      newSize: file.size,
      outputMime: inputMime,
      width,
      height,
      keptOriginal: true,
    };
  }

  return { blob, originalSize: file.size, newSize: blob.size, outputMime, width, height, keptOriginal: false };
}


// Load pako and UPNG once per page; if loading fails, PNG falls back to canvas.
function loadUPNG() {
  if (window.UPNG && typeof window.UPNG.encode === 'function') return Promise.resolve(window.UPNG);
  if (upngLoadPromise) return upngLoadPromise;

  upngLoadPromise = (async () => {
    const loadScript = (src) => new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = false;
      script.onload = resolve;
      script.onerror = () => reject(new Error(`Could not load ${src}`));
      document.head.appendChild(script);
    });

    try {
      await loadScript('https://cdnjs.cloudflare.com/ajax/libs/pako/2.1.0/pako.min.js');
      await loadScript('https://cdn.jsdelivr.net/npm/upng-js@2.1.0/UPNG.js');
      return window.UPNG && typeof window.UPNG.encode === 'function' ? window.UPNG : null;
    } catch (error) {
      console.warn('Could not load UPNG dependencies:', error);
      return null;
    }
  })();

  return upngLoadPromise;
}

// ── Binary search quality (main thread) ───────────────────────────────────────
async function binarySearchMainThread(canvas, mime, targetKB) {
  const targetBytes = targetKB * 1024;
  let lo = 1, hi = 92, bestBlob = null;

  let blob = await canvasToBlob(canvas, mime, hi / 100);
  if (blob.size <= targetBytes) return blob;

  for (let i = 0; i < 12; i++) {
    const mid = Math.round((lo + hi) / 2);
    blob = await canvasToBlob(canvas, mime, mid / 100);
    if (blob.size <= targetBytes) { bestBlob = blob; lo = mid + 1; }
    else hi = mid - 1;
    if (lo > hi) break;
    await yieldToMain();
  }

  return bestBlob ?? await canvasToBlob(canvas, mime, 0.01);
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => { blob ? resolve(blob) : reject(new Error('Encoding failed')); },
      type,
      quality
    );
  });
}

function resolveOutputMime(format, inputMime) {
  if (format === 'original') {
    return inputMime === 'image/gif' ? 'image/png' : inputMime;
  }
  const map = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
  return map[format] || inputMime;
}

function computeDimensions(srcW, srcH, maxW, maxH, keepAspect) {
  if (!keepAspect) {
    return { width: Math.min(maxW || srcW, srcW), height: Math.min(maxH || srcH, srcH) };
  }
  const ratioW = maxW ? maxW / srcW : Infinity;
  const ratioH = maxH ? maxH / srcH : Infinity;
  const ratio = Math.min(ratioW, ratioH, 1);
  return {
    width: Math.round(srcW * ratio),
    height: Math.round(srcH * ratio),
  };
}

// Yield to main thread between heavy operations
function yieldToMain() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

// ── Exported helpers ──────────────────────────────────────────────────────────
export function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

export function mimeToExt(mime) {
  const map = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/bmp': 'bmp',
  };
  return map[mime] || 'jpg';
}

/**
 * Build output filename with mode suffix and handle duplicates.
 * @param {string} originalName
 * @param {string} outputMime
 * @param {string} mode - 'compress' | 'convert' | 'resize'
 * @param {Set} usedNames - tracks names already used in this session
 */
export function getOutputFilename(originalName, outputMime, mode, usedNames = new Set()) {
  const base = originalName.replace(/\.[^.]+$/, '');
  const ext = mimeToExt(outputMime);
  const suffix = mode === 'compress' ? 'compressed' : mode === 'convert' ? 'converted' : 'resized';
  let name = `${base}-${suffix}.${ext}`;

  // Handle duplicates
  let counter = 2;
  while (usedNames.has(name)) {
    name = `${base}-${suffix}-${counter}.${ext}`;
    counter++;
  }
  usedNames.add(name);
  return name;
}

export { MAX_FILE_SIZE };

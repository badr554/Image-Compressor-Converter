/**
 * PixelSqueeze — processor.js (v2)
 * Worker bridge with full main-thread fallback using chunked async processing.
 * Handles: UPNG.js for PNG, EXIF orientation, large image protection,
 * progress callbacks, memory cleanup.
 */

const WORKER_URL = new URL('/js/worker.js', location.href).href;
const MAX_CANVAS_SIDE = 16000;
const MAX_DESKTOP_PIXELS = 32_000_000;
const MAX_MOBILE_SAFARI_PIXELS = 16_000_000;
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
    worker.onerror = (event) => {
      event.preventDefault?.();
      const failedWorker = worker;
      worker = null;
      failedWorker?.terminate();
      const jobs = [...pendingCallbacks.entries()];
      pendingCallbacks.clear();
      jobs.forEach(([, job]) => {
        processOnMainThread(job.file, job.options, job.onProgress)
          .then(job.resolve, job.reject);
      });
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
  if (file.size > MAX_FILE_SIZE) throw new Error('This image is larger than the 50 MB processing limit.');
  const w = getWorker();

  if (w) {
    const id = ++callbackId;
    return new Promise((resolve, reject) => {
      pendingCallbacks.set(id, { resolve, reject, onProgress, file, options });
      try {
        w.postMessage({ id, file, options });
      } catch {
        pendingCallbacks.delete(id);
        processOnMainThread(file, options, onProgress).then(resolve, reject);
      }
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
  const sourceWidth = width;
  const sourceHeight = height;
  const pixelBudget = getPixelBudget();
  const pixelScale = Math.min(1, MAX_CANVAS_SIDE / width, MAX_CANVAS_SIDE / height, Math.sqrt(pixelBudget / (width * height)));
  if (pixelScale < 1) {
    width = Math.max(1, Math.floor(width * pixelScale));
    height = Math.max(1, Math.floor(height * pixelScale));
  }
  const wasPixelCapped = width !== sourceWidth || height !== sourceHeight;

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

  try {
    ctx.drawImage(bitmap, 0, 0, width, height);
  } finally {
    bitmap.close(); // release decoded bitmap memory even if drawing fails
  }

  await yieldToMain();
  onProgress(60);

  let blob;
  let warning = wasPixelCapped
    ? `This image exceeded the safe ${Math.round(pixelBudget / 1_000_000)} MP processing limit and was resized to ${width} × ${height} pixels.`
    : '';

  if (targetKB && outputMime !== 'image/png') {
    const targetResult = await fitTargetMainThread(canvas, outputMime, targetKB);
    blob = targetResult.blob;
    if (!targetResult.met) warning = `${warning} The requested ${targetKB} KB limit could not be reached; this output is ${formatBytes(blob.size)}.`.trim();
  } else if (outputMime === 'image/png') {
    try {
      const upng = await loadUPNG();
      if (upng && typeof upng.encode === 'function') {
        const imageData = ctx.getImageData(0, 0, width, height);
        const encoded = upng.encode([imageData.data.buffer], width, height, pngColors);
        blob = new Blob([encoded], { type: 'image/png' });
      }
    } catch {
      // The same-origin UPNG bundle is optional; canvas remains the PNG fallback.
    }
    if (!blob) blob = await canvasToBlob(canvas, 'image/png', undefined);
    if (targetKB) warning = `${warning} Target size is supported for JPEG and WebP; PNG output may exceed the target.`.trim();
  } else {
    blob = await canvasToBlob(canvas, outputMime, quality / 100);
  }

  onProgress(90);

  // Keep original if output is larger (compress-only mode)
  if (blob.size >= file.size && format === 'original' && outputMime === inputMime && inputMime !== 'image/gif' && !targetKB && !maxWidth && !maxHeight) {
    const origBlob = file.slice(0, file.size, file.type);
    return {
      blob: origBlob,
      originalSize: file.size,
      newSize: file.size,
      outputMime: inputMime,
      width,
      height,
      keptOriginal: true,
      mode,
      warning,
    };
  }

  return { blob, originalSize: file.size, newSize: blob.size, outputMime, width, height, keptOriginal: false, mode, warning };
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
      await loadScript('/js/vendor/pako.min.js');
      await loadScript('/js/vendor/UPNG.js');
      return window.UPNG && typeof window.UPNG.encode === 'function' ? window.UPNG : null;
    } catch (error) {
      return null;
    }
  })();

  return upngLoadPromise;
}

// Reduce quality first, then dimensions if needed, until a JPEG/WebP target fits.
async function fitTargetMainThread(sourceCanvas, mime, targetKB) {
  const targetBytes = targetKB * 1024;
  let working = sourceCanvas;
  let blob = null;

  for (let attempt = 0; attempt < 12; attempt++) {
    blob = await binarySearchMainThread(working, mime, targetKB);
    if (blob.size <= targetBytes) return { blob, met: true };
    if (working.width <= 1 && working.height <= 1) break;

    const scale = Math.min(0.85, Math.sqrt(targetBytes / blob.size) * 0.92);
    const width = Math.max(1, Math.floor(working.width * scale));
    const height = Math.max(1, Math.floor(working.height * scale));
    if (width === working.width && height === working.height) break;
    const smaller = document.createElement('canvas');
    smaller.width = width;
    smaller.height = height;
    smaller.getContext('2d').drawImage(sourceCanvas, 0, 0, width, height);
    working = smaller;
  }

  return { blob, met: Boolean(blob && blob.size <= targetBytes) };
}

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


function getPixelBudget() {
  const ua = navigator.userAgent || '';
  const mobileSafari = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
  return mobileSafari ? MAX_MOBILE_SAFARI_PIXELS : MAX_DESKTOP_PIXELS;
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


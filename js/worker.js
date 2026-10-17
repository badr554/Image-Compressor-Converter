/**
 * PixelSqueeze — worker.js (v2)
 * OffscreenCanvas Web Worker.
 * Handles: compression, conversion, resize, PNG via UPNG.js, binary-search for target KB.
 * UPNG.js is loaded via importScripts from cdnjs.
 */

// Load pako before UPNG for PNG encoding support.
try {
  importScripts(
    '/js/vendor/pako.min.js',
    '/js/vendor/UPNG.js'
  );
} catch (e) {
  // If either dependency is unavailable, PNG uses the canvas fallback.
  self.UPNG = null;
}

const MAX_CANVAS_SIDE = 16000;
const MAX_DESKTOP_PIXELS = 32_000_000;
const MAX_MOBILE_SAFARI_PIXELS = 16_000_000;

self.onmessage = async function (e) {
  const { id, file, options } = e.data;

  // Send progress updates
  const progress = (pct) => self.postMessage({ id, type: 'progress', pct });

  try {
    progress(10);
    const result = await processImage(file, options, progress);
    self.postMessage({ id, type: 'done', success: true, ...result });
  } catch (err) {
    self.postMessage({ id, type: 'done', success: false, error: err.message });
  }
};

async function processImage(file, options, progress) {
  const {
    quality = 80,
    format = 'original',
    maxWidth = null,
    maxHeight = null,
    keepAspectRatio = true,
    targetKB = null,
    pngColors = 256,      // PNG quantization color count (16-256)
    mode = 'compress',    // 'compress' | 'convert' | 'resize'
  } = options;

  // Determine output MIME
  const inputMime = file.type;
  let outputMime = resolveOutputMime(format, inputMime);

  // Decode image
  let bitmap;
  try {
    // imageOrientation: 'from-image' respects EXIF rotation on phone photos
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (err) {
    throw new Error(`Cannot decode image "${file.name}". The file may be corrupt or use an unsupported encoding.`);
  }

  progress(30);

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

  // Apply resize constraints
  if (maxWidth || maxHeight) {
    ({ width, height } = computeDimensions(width, height, maxWidth, maxHeight, keepAspectRatio));
  }

  // Draw to OffscreenCanvas
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // White background for JPEG (no alpha)
  if (outputMime === 'image/jpeg') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
  }

  try {
    ctx.drawImage(bitmap, 0, 0, width, height);
  } finally {
    bitmap.close();
  }

  progress(60);

  let blob;
  let warning = wasPixelCapped
    ? `This image exceeded the safe ${Math.round(pixelBudget / 1_000_000)} MP processing limit and was resized to ${width} × ${height} pixels.`
    : '';

  if (outputMime === 'image/png' && self.UPNG) {
    blob = await encodeWithUPNG(canvas, width, height, pngColors);
    if (targetKB) warning = `${warning} Target size is supported for JPEG and WebP; PNG output may exceed the target.`.trim();
  } else if (targetKB && outputMime !== 'image/png') {
    const targetResult = await fitTargetWorker(canvas, outputMime, targetKB);
    blob = targetResult.blob;
    if (!targetResult.met) warning = `${warning} The requested ${targetKB} KB limit could not be reached; this output is ${(blob.size / 1024).toFixed(1)} KB.`.trim();
  } else {
    const q = outputMime === 'image/png' ? undefined : quality / 100;
    blob = await canvas.convertToBlob({ type: outputMime, quality: q });
    if (outputMime === 'image/png' && targetKB) warning = `${warning} Target size is supported for JPEG and WebP; PNG output may exceed the target.`.trim();
  }

  progress(90);

  // If output is LARGER than original, keep original
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

// ── UPNG PNG encoding ──────────────────────────────────────────────────────────
async function encodeWithUPNG(canvas, width, height, pngColors) {
  const ctx = canvas.getContext('2d');
  const imageData = ctx.getImageData(0, 0, width, height);

  // UPNG.encode limits the palette to pngColors; 0 requests full-color lossless encoding.
  const encoded = UPNG.encode(
    [imageData.data.buffer],
    width,
    height,
    pngColors // 0 = lossless; 1-256 = palette color limit (may be lossy)
  );

  return new Blob([encoded], { type: 'image/png' });
}

async function fitTargetWorker(sourceCanvas, mime, targetKB) {
  const targetBytes = targetKB * 1024;
  let working = sourceCanvas;
  let blob = null;
  for (let attempt = 0; attempt < 12; attempt++) {
    blob = await binarySearchQuality(working, mime, targetKB);
    if (blob.size <= targetBytes) return { blob, met: true };
    if (working.width <= 1 && working.height <= 1) break;
    const scale = Math.min(0.85, Math.sqrt(targetBytes / blob.size) * 0.92);
    const width = Math.max(1, Math.floor(working.width * scale));
    const height = Math.max(1, Math.floor(working.height * scale));
    if (width === working.width && height === working.height) break;
    const smaller = new OffscreenCanvas(width, height);
    smaller.getContext('2d').drawImage(sourceCanvas, 0, 0, width, height);
    working = smaller;
  }
  return { blob, met: Boolean(blob && blob.size <= targetBytes) };
}

async function binarySearchQuality(canvas, mime, targetKB) {
  const targetBytes = targetKB * 1024;
  let lo = 1, hi = 92, bestBlob = null;
  let blob = await canvas.convertToBlob({ type: mime, quality: hi / 100 });
  if (blob.size <= targetBytes) return blob;
  for (let i = 0; i < 12; i++) {
    const mid = Math.round((lo + hi) / 2);
    blob = await canvas.convertToBlob({ type: mime, quality: mid / 100 });
    if (blob.size <= targetBytes) { bestBlob = blob; lo = mid + 1; }
    else hi = mid - 1;
    if (lo > hi) break;
  }
  return bestBlob ?? await canvas.convertToBlob({ type: mime, quality: 0.01 });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getPixelBudget() {
  const ua = navigator.userAgent || '';
  const mobileSafari = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
  return mobileSafari ? MAX_MOBILE_SAFARI_PIXELS : MAX_DESKTOP_PIXELS;
}

function resolveOutputMime(format, inputMime) {
  if (format === 'original') {
    // GIF → PNG (canvas can't re-encode GIF multi-frame)
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
  const ratio = Math.min(ratioW, ratioH, 1); // never upscale
  return {
    width: Math.round(srcW * ratio),
    height: Math.round(srcH * ratio),
  };
}


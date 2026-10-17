/**
 * PixelSqueeze — worker.js (v2)
 * OffscreenCanvas Web Worker.
 * Handles: compression, conversion, resize, PNG via UPNG.js, binary-search for target KB.
 * UPNG.js is loaded via importScripts from cdnjs.
 */

// Load pako before UPNG for PNG encoding support.
try {
  importScripts(
    'https://cdnjs.cloudflare.com/ajax/libs/pako/2.1.0/pako.min.js',
    'https://cdn.jsdelivr.net/npm/upng-js@2.1.0/UPNG.js'
  );
} catch (e) {
  // If either dependency is unavailable, PNG uses the canvas fallback.
  self.UPNG = null;
}

const MAX_DIMENSION = 16000;

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

  // Guard against huge images
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    const ratio = Math.min(MAX_DIMENSION / width, MAX_DIMENSION / height);
    width = Math.round(width * ratio);
    height = Math.round(height * ratio);
  }

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

  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  progress(60);

  let blob;

  // ── PNG branch: use UPNG.js for real quantization ──────────────────────────
  if (outputMime === 'image/png' && self.UPNG) {
    blob = await encodeWithUPNG(canvas, width, height, pngColors);
  } else if (targetKB && outputMime !== 'image/png') {
    blob = await binarySearchQuality(canvas, outputMime, targetKB);
  } else {
    const q = outputMime === 'image/png' ? undefined : quality / 100;
    blob = await canvas.convertToBlob({ type: outputMime, quality: q });
  }

  progress(90);

  // If output is LARGER than original, keep original
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

  return {
    blob,
    originalSize: file.size,
    newSize: blob.size,
    outputMime,
    width,
    height,
    keptOriginal: false,
  };
}

// ── UPNG PNG encoding ──────────────────────────────────────────────────────────
async function encodeWithUPNG(canvas, width, height, pngColors) {
  const ctx = canvas.getContext('2d');
  const imageData = ctx.getImageData(0, 0, width, height);

  // UPNG.encode: quantize to pngColors colors, lossless
  const encoded = UPNG.encode(
    [imageData.data.buffer],
    width,
    height,
    pngColors // 0 = lossless, 1-256 = lossy quantization
  );

  return new Blob([encoded], { type: 'image/png' });
}

// ── Binary search quality ──────────────────────────────────────────────────────
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

import { FFmpeg } from 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js';
import { fetchFile } from 'https://unpkg.com/@ffmpeg/util@0.12.1/dist/esm/index.js';

const fileInput = document.getElementById('fileInput');
const dropzone = document.getElementById('dropzone');
const fileNameEl = document.getElementById('fileName');
const convertBtn = document.getElementById('convertBtn');
const modeSelect = document.getElementById('modeSelect');
const tiktokPreset = document.getElementById('tiktokPreset');
const sharpenToggle = document.getElementById('sharpen');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const progressBar = document.getElementById('progressBar');
const logEl = document.getElementById('log');
const resultCard = document.getElementById('resultCard');
const preview = document.getElementById('preview');
const downloadLink = document.getElementById('downloadLink');
const resetBtn = document.getElementById('resetBtn');

let selectedFile = null;
let ffmpeg = null;
let ffmpegLoaded = false;
let busy = false;
let resultUrl = null;

const BASE_LOCAL = new URL('./ffmpeg/', import.meta.url);

function setStatus(text, state = '') {
  statusText.textContent = text;
  statusDot.className = 'status-dot' + (state ? ' ' + state : '');
}

function setProgress(ratio) {
  const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)));
  progressBar.style.width = pct + '%';
}

function log(message) {
  const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
  const line = `[${time}] ${message}`;
  if (logEl.textContent.startsWith('سجل المعالجة')) logEl.textContent = '';
  logEl.textContent += (logEl.textContent ? '\n' : '') + line;
  logEl.scrollTop = logEl.scrollHeight;
}

function resetResult() {
  if (resultUrl) {
    URL.revokeObjectURL(resultUrl);
    resultUrl = null;
  }
  preview.removeAttribute('src');
  preview.load();
  downloadLink.removeAttribute('href');
  resultCard.classList.add('hidden');
}

function pickFile(file) {
  if (!file) return;
  if (!file.type.startsWith('video/')) {
    setStatus('الملف المختار ليس فيديو. اختر ملف فيديو.', 'error');
    log('خطأ: الملف ليس فيديو.');
    return;
  }
  resetResult();
  selectedFile = file;
  fileNameEl.textContent = `${file.name} (${formatBytes(file.size)})`;
  dropzone.classList.add('has-file');
  convertBtn.disabled = busy;
  setStatus('جاهز للتحويل — اضغط "ابدأ التحويل"', 'ready');
  log(`تم اختيار الملف: ${file.name} (${formatBytes(file.size)})`);
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function safeName(name) {
  const dot = name.lastIndexOf('.');
  const base = (dot > 0 ? name.slice(0, dot) : name)
    .replace(/[^\w\u0600-\u06FF\- ]+/g, '_')
    .trim()
    .slice(0, 60) || 'video';
  return base;
}

async function ensureFFmpeg() {
  if (ffmpegLoaded && ffmpeg) return ffmpeg;
  if (!ffmpeg) ffmpeg = new FFmpeg();

  let lastFrameLog = 0;
  ffmpeg.on('log', ({ message }) => {
    if (!message) return;
    // Show frame progress in status without spamming the log.
    if (/^frame=\s*\d+/.test(message)) {
      const now = Date.now();
      if (now - lastFrameLog > 1000) {
        lastFrameLog = now;
        setStatus(`جاري التحويل... ${message.trim().slice(0, 80)}`, 'loading');
      }
      return;
    }
    log(message);
  });

  ffmpeg.on('progress', ({ progress }) => {
    if (typeof progress === 'number' && progress >= 0) {
      setProgress(Math.min(progress, 0.99));
      setStatus(`جاري التحويل... ${Math.round(Math.min(progress, 0.99) * 100)}%`, 'loading');
    }
  });

  setStatus('جاري تحميل محرك FFmpeg (أول مرة فقط)...', 'loading');
  log('تحميل ffmpeg-core من نفس الموقع...');
  await ffmpeg.load({
    classWorkerURL: new URL('worker.js', BASE_LOCAL).href,
    coreURL: new URL('ffmpeg-core.js', BASE_LOCAL).href,
    wasmURL: new URL('ffmpeg-core.wasm', BASE_LOCAL).href,
  });
  ffmpegLoaded = true;
  log('تم تحميل FFmpeg بنجاح.');
  return ffmpeg;
}

function buildVideoFilter() {
  const mode = modeSelect.value;
  const filters = [];

  // Frame interpolation / fps conversion
  if (mode === 'mci') {
    filters.push('minterpolate=fps=60:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1');
  } else if (mode === 'dup') {
    filters.push('fps=60');
  } else {
    filters.push('minterpolate=fps=60:mi_mode=blend');
  }

  if (sharpenToggle.checked) {
    filters.push('unsharp=5:5:0.6:3:3:0.0');
  }

  if (tiktokPreset.checked) {
    // Fit into 1080x1920 vertical canvas, preserve aspect, pad.
    filters.push('scale=1080:1920:force_original_aspect_ratio=decrease');
    filters.push('pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black');
    filters.push('setsar=1');
    filters.push('format=yuv420p');
  } else {
    filters.push('format=yuv420p');
  }

  return filters.join(',');
}

async function convert() {
  if (!selectedFile || busy) return;
  busy = true;
  convertBtn.disabled = true;
  resetResult();
  setProgress(0);
  logEl.textContent = '';

  const inputExt = (selectedFile.name.split('.').pop() || 'mp4').toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp4';
  const inputName = `input.${inputExt}`;
  const outputName = `output_60fps.mp4`;
  const outputDownload = `${safeName(selectedFile.name)}_60fps_tiktok.mp4`;

  try {
    const ff = await ensureFFmpeg();

    setStatus('جاري قراءة الملف...', 'loading');
    log(`حجم الملف: ${formatBytes(selectedFile.size)}`);
    if (selectedFile.size > 500 * 1024 * 1024) {
      log('تنبيه: الملف كبير وقد يفشل في المتصفح بسبب الذاكرة. يفضل مقطع أقصر.');
    }

    await ff.writeFile(inputName, await fetchFile(selectedFile));
    log('تم تحميل الملف داخل محرك المعالجة.');

    const vf = buildVideoFilter();
    log(`فلتر الفيديو: ${vf}`);

    const args = ['-i', inputName, '-vf', vf];

    // Encoding settings
    args.push('-c:v', 'libx264');
    args.push('-preset', tiktokPreset.checked ? 'slow' : 'medium');
    args.push('-crf', tiktokPreset.checked ? '18' : '20');
    if (tiktokPreset.checked) {
      args.push('-b:v', '12M', '-maxrate', '16M', '-bufsize', '24M');
      args.push('-profile:v', 'high', '-level', '4.2');
    }
    args.push('-pix_fmt', 'yuv420p');
    args.push('-movflags', '+faststart');

    // Audio
    args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2');

    // Output
    args.push('-r', '60', '-y', outputName);

    setStatus('جاري التحويل... قد يأخذ وقت حسب طول الفيديو وجهازك', 'loading');
    log('بدء أمر FFmpeg...');
    log('ffmpeg ' + args.map(a => a.includes(' ') ? `"${a}"` : a).join(' '));

    const code = await ff.exec(args);
    if (code !== 0) {
      throw new Error(`FFmpeg انتهى بكود خطأ: ${code}`);
    }

    setProgress(1);
    setStatus('جاري تجهيز ملف التحميل...', 'loading');
    const data = await ff.readFile(outputName);
    const blob = new Blob([data.buffer], { type: 'video/mp4' });
    resultUrl = URL.createObjectURL(blob);

    preview.src = resultUrl;
    downloadLink.href = resultUrl;
    downloadLink.download = outputDownload;
    resultCard.classList.remove('hidden');

    setStatus(`تم التحويل بنجاح — ${formatBytes(blob.size)}`, 'done');
    log(`تم: ${outputDownload} (${formatBytes(blob.size)})`);

    // Cleanup FS
    try { await ff.deleteFile(inputName); } catch {}
    try { await ff.deleteFile(outputName); } catch {}

    resultCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    console.error(err);
    const msg = err && err.message ? err.message : String(err);
    setStatus('فشل التحويل. شوف السجل للتفاصيل.', 'error');
    log(`خطأ: ${msg}`);
    if (/memory|Out of memory|OOM/i.test(msg)) {
      log('يبدو أن المتصفح نفدت ذاكرته. جرّب مقطع أقصر أو دقة أقل.');
    }
  } finally {
    busy = false;
    convertBtn.disabled = !selectedFile;
  }
}

// Events
fileInput.addEventListener('change', (e) => pickFile(e.target.files && e.target.files[0]));

['dragenter', 'dragover'].forEach(evt => {
  dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
});
['dragleave', 'drop'].forEach(evt => {
  dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); });
});
dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  pickFile(file);
});

convertBtn.addEventListener('click', convert);

resetBtn.addEventListener('click', () => {
  resetResult();
  selectedFile = null;
  fileInput.value = '';
  fileNameEl.textContent = 'MP4, MOV, MKV — يفضل مقطع قصير للتجربة';
  dropzone.classList.remove('has-file');
  convertBtn.disabled = true;
  setProgress(0);
  setStatus('جاهز — اختر فيديو للبدء', '');
  logEl.textContent = 'سجل المعالجة سيظهر هنا...';
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

// Initial state
setStatus('جاهز — اختر فيديو للبدء', '');
log('ملاحظة: أول تحويل قد يأخذ وقت إضافي لتحميل محرك FFmpeg (~30MB).');

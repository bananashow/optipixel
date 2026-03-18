import { useState, useRef, useCallback, useEffect } from 'react';
import imageCompression from 'browser-image-compression';
import JSZip from 'jszip';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';
import PreviewModal from './PreviewModal';
import './App.css';

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function getSavingPercent(original, compressed) {
  if (!original || !compressed) return 0;
  return Math.round((1 - compressed / original) * 100);
}

function uid() {
  return Math.random().toString(36).slice(2, 9);
}

function getExtLabel(file) {
  if (!file) return '원본';
  if (file.type === 'image/jpeg') return 'JPG';
  if (file.type === 'image/png')  return 'PNG';
  if (file.type === 'image/webp') return 'WebP';
  return file.name.split('.').pop().toUpperCase();
}

function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function convertToFormat(src, format, q) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width  = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (format === 'jpeg') {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      ctx.drawImage(img, 0, 0);
      canvas.toBlob(resolve, `image/${format}`, q);
    };
    img.src = src;
  });
}

function getVideoThumbnail(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'metadata';

    video.onloadedmetadata = () => {
      video.currentTime = Math.min(0.5, video.duration * 0.1);
    };

    video.onseeked = () => {
      const canvas = document.createElement('canvas');
      canvas.width  = video.videoWidth  || 640;
      canvas.height = video.videoHeight || 360;
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(
        (blob) => {
          URL.revokeObjectURL(url);
          resolve({
            thumbUrl: blob ? URL.createObjectURL(blob) : null,
            width:    video.videoWidth,
            height:   video.videoHeight,
            duration: video.duration,
          });
        },
        'image/jpeg',
        0.85
      );
    };

    video.onerror = () => {
      URL.revokeObjectURL(url);
      resolve({ thumbUrl: null, width: 0, height: 0, duration: 0 });
    };

    video.src = url;
    video.load();
  });
}

const STATIC_FORMATS = [
  { id: 'jpeg', label: 'JPG'  },
  { id: 'png',  label: 'PNG'  },
  { id: 'webp', label: 'WebP' },
];

// FFmpeg core URLs (shared binary, separate instances per video)
let ffmpegCoreBase = null;

function getFFmpegBase() {
  if (!ffmpegCoreBase) {
    ffmpegCoreBase = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
  }
  return ffmpegCoreBase;
}

const MAX_VIDEO_CONCURRENCY = 2;

// 동시 실행 수를 limit 개로 제한하는 헬퍼
function withConcurrency(items, limit, fn) {
  const queue = items.slice();
  async function worker() {
    while (queue.length > 0) await fn(queue.shift());
  }
  return Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
}

// 비디오당 독립 인스턴스 생성 (병렬 처리용)
async function createFFmpegInstance() {
  const ffmpeg = new FFmpeg();
  const base   = getFFmpegBase();
  await ffmpeg.load({
    coreURL: `${base}/ffmpeg/ffmpeg-core.js`,
    wasmURL: `${base}/ffmpeg/ffmpeg-core.wasm`,
  });
  return ffmpeg;
}

// preload 전용 싱글턴 (UI "로딩 중" 표시 목적)
let ffmpegPreloadPromise = null;
function loadFFmpeg() {
  if (!ffmpegPreloadPromise) ffmpegPreloadPromise = createFFmpegInstance();
  return ffmpegPreloadPromise;
}

export default function App() {
  const [items, setItems]               = useState([]);
  const [quality, setQuality]           = useState(50);
  const [downloadFormat, setDownloadFormat] = useState('original');
  const [isZipping, setIsZipping]       = useState(false);
  const [isDragging, setIsDragging]     = useState(false);
  const [ffmpegReady, setFfmpegReady]   = useState(false);

  const [previewItem, setPreviewItem] = useState(null);

  const fileInputRef = useRef(null);

  // Preload FFmpeg in background
  useEffect(() => {
    loadFFmpeg().then(() => setFfmpegReady(true)).catch(() => {});
  }, []);

  const openPreview  = useCallback((item) => setPreviewItem(item), []);
  const closePreview = useCallback(() => setPreviewItem(null), []);

  const applyItemQuality = useCallback((id, q) => {
    setItems(prev => prev.map(it => it.id === id ? { ...it, customQuality: q } : it));
    setPreviewItem(null);
  }, []);

  const resetItemQuality = (id) =>
    setItems(prev => prev.map(it => it.id === id ? { ...it, customQuality: null } : it));

  const addFiles = useCallback((fileList) => {
    const newItems = [];

    for (const file of Array.from(fileList)) {
      if (file.type.startsWith('image/')) {
        const originalPreview = URL.createObjectURL(file);
        const item = {
          id: uid(), file, mediaType: 'image',
          originalPreview, dimensions: null,
          compressedFile: null, compressedPreview: null,
          formatSizes: {}, status: 'idle', progress: null, duration: null,
          customQuality: null,
        };
        const img = new Image();
        img.onload = () => {
          setItems(prev => prev.map(it =>
            it.id === item.id
              ? { ...it, dimensions: { width: img.naturalWidth, height: img.naturalHeight } }
              : it
          ));
        };
        img.src = originalPreview;
        newItems.push(item);

      } else if (file.type.startsWith('video/')) {
        const item = {
          id: uid(), file, mediaType: 'video',
          originalPreview: null, dimensions: null,
          compressedFile: null, compressedPreview: null,
          formatSizes: {}, status: 'idle', progress: null, duration: null,
        };
        newItems.push(item);

        getVideoThumbnail(file).then(({ thumbUrl, width, height, duration }) => {
          setItems(prev => prev.map(it =>
            it.id === item.id
              ? { ...it, originalPreview: thumbUrl, dimensions: { width, height }, duration }
              : it
          ));
        });
      }
    }

    if (newItems.length > 0) setItems(prev => [...prev, ...newItems]);
  }, []);

  const removeItem = (id) => setItems(prev => prev.filter(it => it.id !== id));
  const clearAll   = () => setItems([]);

  const measureFormatSizes = useCallback((id, imgSrc, originalSize, q) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width  = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);

      const canvasJpeg = document.createElement('canvas');
      canvasJpeg.width  = img.naturalWidth;
      canvasJpeg.height = img.naturalHeight;
      const ctxJ = canvasJpeg.getContext('2d');
      ctxJ.fillStyle = '#ffffff';
      ctxJ.fillRect(0, 0, canvasJpeg.width, canvasJpeg.height);
      ctxJ.drawImage(img, 0, 0);

      const sizes = { original: originalSize };
      let done = 0;
      const check = () => {
        if (++done === 3) {
          setItems(prev => prev.map(it => it.id === id ? { ...it, formatSizes: { ...sizes } } : it));
        }
      };
      canvasJpeg.toBlob(b => { sizes.jpeg = b?.size ?? 0; check(); }, 'image/jpeg', q);
      canvas.toBlob(b     => { sizes.png  = b?.size ?? 0; check(); }, 'image/png');
      canvas.toBlob(b     => { sizes.webp = b?.size ?? 0; check(); }, 'image/webp', q);
    };
    img.src = imgSrc;
  }, []);

  const compressAll = async () => {
    const toCompress  = items.filter(it => it.status !== 'compressing');
    const imageItems  = toCompress.filter(it => it.mediaType === 'image');
    const videoItems  = toCompress.filter(it => it.mediaType === 'video');

    setItems(prev => prev.map(it =>
      toCompress.find(i => i.id === it.id)
        ? {
            ...it,
            status: 'compressing',
            compressedFile: null, compressedPreview: null,
            formatSizes: {},
            progress: it.mediaType === 'video' ? 0 : null,
          }
        : it
    ));

    // ── Images (병렬 처리) ──
    await Promise.all(imageItems.map(async (item) => {
      try {
        const q = (item.customQuality ?? quality) / 100;
        const options = {
          maxSizeMB: (item.file.size / 1024 / 1024) * q,
          maxWidthOrHeight: Math.max(item.dimensions?.width || 9999, item.dimensions?.height || 9999),
          useWebWorker: true,
          alwaysKeepResolution: true,
          initialQuality: q,
          fileType: item.file.type,
        };
        const compressed = await imageCompression(item.file, options);
        const previewUrl = URL.createObjectURL(compressed);
        setItems(prev => prev.map(it =>
          it.id === item.id
            ? { ...it, compressedFile: compressed, compressedPreview: previewUrl, status: 'done' }
            : it
        ));
        measureFormatSizes(item.id, previewUrl, compressed.size, q);
      } catch (err) {
        console.error(err);
        setItems(prev => prev.map(it =>
          it.id === item.id ? { ...it, status: 'error' } : it
        ));
      }
    }));

    // ── Videos (MAX_VIDEO_CONCURRENCY 개 동시 처리) ──
    if (videoItems.length > 0) {
      await withConcurrency(videoItems, MAX_VIDEO_CONCURRENCY, async (item) => {
        // quality 10 → CRF 38 / quality 50 → CRF 29 / quality 99 → CRF 18
        const crf = Math.round(40 - ((item.customQuality ?? quality) / 100) * 22);
        let ffmpeg = null;
        const ext        = item.file.name.split('.').pop().toLowerCase() || 'mp4';
        const inputName  = `in_${item.id}.${ext}`;
        const outputName = `out_${item.id}.mp4`;
        let progressHandler = null;

        try {
          ffmpeg = await createFFmpegInstance();

          await ffmpeg.writeFile(inputName, await fetchFile(item.file));

          progressHandler = ({ progress }) => {
            setItems(prev => prev.map(it =>
              it.id === item.id
                ? { ...it, progress: Math.min(99, Math.round(progress * 100)) }
                : it
            ));
          };
          ffmpeg.on('progress', progressHandler);

          await ffmpeg.exec([
            '-i', inputName,
            '-c:v', 'libx264',
            '-crf', String(crf),
            '-preset', 'fast',
            '-c:a', 'aac',
            '-b:a', '128k',
            '-movflags', '+faststart',
            outputName,
          ]);

          ffmpeg.off('progress', progressHandler);
          progressHandler = null;

          const data       = await ffmpeg.readFile(outputName);
          const blob       = new Blob([data.buffer], { type: 'video/mp4' });
          const previewUrl = URL.createObjectURL(blob);

          try { await ffmpeg.deleteFile(inputName);  } catch {}
          try { await ffmpeg.deleteFile(outputName); } catch {}

          setItems(prev => prev.map(it =>
            it.id === item.id
              ? { ...it, compressedFile: blob, compressedPreview: previewUrl, status: 'done', progress: 100 }
              : it
          ));
        } catch (err) {
          console.error('동영상 압축 오류:', err);
          if (ffmpeg && progressHandler) ffmpeg.off('progress', progressHandler);
          if (ffmpeg) {
            try { await ffmpeg.deleteFile(inputName);  } catch {}
            try { await ffmpeg.deleteFile(outputName); } catch {}
          }
          setItems(prev => prev.map(it =>
            it.id === item.id ? { ...it, status: 'error' } : it
          ));
        }
      });
    }
  };

  const downloadSingle = async (item) => {
    if (!item.compressedFile) return;
    const baseName = item.file.name.replace(/\.[^.]+$/, '');

    if (item.mediaType === 'video') {
      const link = document.createElement('a');
      link.href     = item.compressedPreview;
      link.download = `${baseName}_compressed.mp4`;
      link.click();
      return;
    }

    if (downloadFormat === 'original') {
      const ext  = item.file.name.split('.').pop();
      const link = document.createElement('a');
      link.href     = item.compressedPreview;
      link.download = `${baseName}_compressed.${ext}`;
      link.click();
      return;
    }
    const extMap = { jpeg: 'jpg', png: 'png', webp: 'webp' };
    const blob   = await convertToFormat(item.compressedPreview, downloadFormat, quality / 100);
    const url    = URL.createObjectURL(blob);
    const link   = document.createElement('a');
    link.href     = url;
    link.download = `${baseName}_compressed.${extMap[downloadFormat]}`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const downloadZip = async () => {
    const doneItems = items.filter(it => it.status === 'done' && it.compressedFile);
    if (!doneItems.length) return;
    setIsZipping(true);
    try {
      const zip    = new JSZip();
      const extMap = { jpeg: 'jpg', png: 'png', webp: 'webp' };
      for (const item of doneItems) {
        let blob, ext;
        if (item.mediaType === 'video') {
          blob = item.compressedFile;
          ext  = 'mp4';
        } else if (downloadFormat === 'original') {
          blob = item.compressedFile;
          ext  = item.file.name.split('.').pop();
        } else {
          blob = await convertToFormat(item.compressedPreview, downloadFormat, quality / 100);
          ext  = extMap[downloadFormat];
        }
        const baseName = item.file.name.replace(/\.[^.]+$/, '');
        zip.file(`${baseName}_compressed.${ext}`, blob);
      }
      const content = await zip.generateAsync({ type: 'blob' });
      const url  = URL.createObjectURL(content);
      const link = document.createElement('a');
      link.href     = url;
      link.download = 'optipixel_compressed.zip';
      link.click();
      URL.revokeObjectURL(url);
    } finally {
      setIsZipping(false);
    }
  };

  const handleDrop        = useCallback((e) => { e.preventDefault(); setIsDragging(false); addFiles(e.dataTransfer.files); }, [addFiles]);
  const handleDragOver    = (e) => { e.preventDefault(); setIsDragging(true); };
  const handleDragLeave   = () => setIsDragging(false);
  const handleInputChange = (e) => { addFiles(e.target.files); e.target.value = ''; };

  const doneItems        = items.filter(it => it.status === 'done');
  const isCompressingAny = items.some(it => it.status === 'compressing');
  const imageItems       = items.filter(it => it.mediaType === 'image');
  const videoItems       = items.filter(it => it.mediaType === 'video');
  const doneImageItems   = doneItems.filter(it => it.mediaType === 'image');

  const allSameExt          = imageItems.length > 0 && imageItems.every(it => getExtLabel(it.file) === getExtLabel(imageItems[0].file));
  const originalFormatLabel = allSameExt ? getExtLabel(imageItems[0]?.file) : '원본';

  const FORMATS = [
    { id: 'original', label: originalFormatLabel },
    ...STATIC_FORMATS,
  ];

  const totalFormatSizes = doneImageItems.reduce((acc, item) => {
    Object.entries(item.formatSizes).forEach(([fmt, size]) => {
      acc[fmt] = (acc[fmt] || 0) + size;
    });
    return acc;
  }, {});

  const totalOriginalSize   = items.reduce((s, it) => s + it.file.size, 0);
  const totalCompressedSize = doneItems.reduce((s, it) => s + (it.compressedFile?.size || 0), 0);
  const totalSaving         = getSavingPercent(totalOriginalSize, totalCompressedSize);

  const compressLabel = [
    imageItems.length > 0 ? `이미지 ${imageItems.length}장` : '',
    videoItems.length > 0 ? `동영상 ${videoItems.length}개` : '',
  ].filter(Boolean).join(' · ');

  return (
    <div className="app">
      <header className="app-header">
        <div className="logo-mark">⚡</div>
        <h1>OptiPixel</h1>
        <p>이미지 & 동영상 · 해상도 유지 · 용량 최적화</p>
      </header>

      <main className="app-main">
        {/* 업로드 영역 */}
        <div
          className={`drop-zone ${items.length > 0 ? 'drop-zone--compact' : ''} ${isDragging ? 'dragging' : ''}`}
          onClick={() => fileInputRef.current.click()}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
        >
          {items.length === 0 ? (
            <>
              <div className="drop-zone-icon">🖼️</div>
              <p className="drop-zone-title">이미지 또는 동영상을 드래그하거나 클릭해서 업로드</p>
              <p className="drop-zone-sub">JPG, PNG, WebP · MP4, MOV, WebM · 여러 파일 동시 선택 가능</p>
            </>
          ) : (
            <p className="drop-zone-add">+ 파일 추가</p>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,video/*"
            multiple
            onChange={handleInputChange}
            hidden
          />
        </div>

        {items.length > 0 && (
          <>
            {/* 컨트롤 바 */}
            <div className="controls-bar">
              <div className="quality-control">
                <label>
                  압축률
                  <span className="quality-value">{100 - quality}%</span>
                </label>
                <input
                  type="range"
                  min={1}
                  max={90}
                  value={100 - quality}
                  onChange={e => setQuality(100 - Number(e.target.value))}
                  className="quality-slider"
                />
                <div className="quality-labels">
                  <span>화질 우선</span>
                  <span>용량 우선</span>
                </div>
              </div>
              <div className="controls-actions">
                {videoItems.length > 0 && !ffmpegReady && (
                  <span className="ffmpeg-hint">
                    <span className="spinner spinner--sm" /> 엔진 로딩 중…
                  </span>
                )}
                <button className="btn-primary" onClick={compressAll} disabled={isCompressingAny}>
                  {isCompressingAny
                    ? <><span className="spinner" /> 압축 중...</>
                    : `전체 압축 (${compressLabel})`}
                </button>
                <button className="btn-ghost" onClick={clearAll} disabled={isCompressingAny}>
                  초기화
                </button>
              </div>
            </div>

            {/* 파일 그리드 */}
            <div className="files-grid">
              {items.map(item => (
                <div key={item.id} className={`file-card file-card--${item.status}`}>
                  <button className="file-card-remove" onClick={() => removeItem(item.id)}>×</button>

                  <div className="file-card-img">
                    {item.originalPreview ? (
                      <img
                        src={item.originalPreview}
                        alt={item.file.name}
                      />
                    ) : (
                      <div className="file-card-thumb-placeholder">
                        <span>🎬</span>
                      </div>
                    )}

                    {/* VIDEO 타입 뱃지 */}
                    {item.mediaType === 'video' && (
                      <div className="video-type-badge">VIDEO</div>
                    )}

                    {/* 동영상 길이 표시 */}
                    {item.mediaType === 'video' && item.duration && item.status === 'idle' && (
                      <div className="video-duration-badge">{formatDuration(item.duration)}</div>
                    )}

                    {/* 이미지 압축 중 */}
                    {item.status === 'compressing' && item.mediaType === 'image' && (
                      <div className="file-card-overlay">
                        <div className="loading-ring" />
                      </div>
                    )}

                    {/* 동영상 압축 중 — 진행률 바 */}
                    {item.status === 'compressing' && item.mediaType === 'video' && (
                      <div className="file-card-overlay">
                        <div className="video-compress-wrap">
                          {item.progress != null && item.progress > 0 ? (
                            <>
                              <div className="video-progress-track">
                                <div
                                  className="video-progress-fill"
                                  style={{ width: `${item.progress}%` }}
                                />
                              </div>
                              <span className="video-progress-text">{item.progress}%</span>
                            </>
                          ) : (
                            <>
                              <div className="loading-ring" />
                              <span className="video-progress-text">준비 중…</span>
                            </>
                          )}
                        </div>
                      </div>
                    )}

                    {item.status === 'done' && (
                      <div className="file-card-badge">
                        -{getSavingPercent(item.file.size, item.compressedFile.size)}%
                      </div>
                    )}
                    {item.status === 'error' && (
                      <div className="file-card-badge file-card-badge--error">오류</div>
                    )}

                    {/* 커스텀 품질 배지 (클릭 시 초기화) */}
                    {item.customQuality !== null && item.status !== 'compressing' && (
                      <button
                        className="file-card-quality-badge"
                        onClick={(e) => { e.stopPropagation(); resetItemQuality(item.id); }}
                        title="클릭하여 글로벌 설정으로 초기화"
                      >
                        압축 {100 - item.customQuality}%
                      </button>
                    )}

                    {/* 이미지 미리보기 버튼 */}
                    {item.mediaType === 'image' && item.status !== 'compressing' && (
                      <button
                        className="file-card-preview-btn"
                        onClick={(e) => { e.stopPropagation(); openPreview(item); }}
                        title="품질 미리보기"
                      >
                        👁
                      </button>
                    )}
                  </div>

                  <div className="file-card-info">
                    <p className="file-card-name" title={item.file.name}>{item.file.name}</p>
                    <div className="file-card-sizes">
                      <span className="size-original">{formatBytes(item.file.size)}</span>
                      {item.status === 'done' && (
                        <>
                          <span className="size-arrow">→</span>
                          <span className="size-compressed">{formatBytes(item.compressedFile.size)}</span>
                        </>
                      )}
                    </div>
                  </div>

                  {item.status === 'done' && (
                    <button className="file-card-dl" onClick={() => downloadSingle(item)} title="개별 다운로드">
                      ↓
                    </button>
                  )}
                </div>
              ))}
            </div>

            {/* 액션 바 */}
            {doneItems.length > 0 && (
              <div className="action-bar">
                <div className="action-bar-summary">
                  <span className="saving-percent">-{totalSaving}%</span>
                  <span className="saving-detail">
                    {formatBytes(totalOriginalSize)} → {formatBytes(totalCompressedSize)}
                    <span className="saving-count"> · {doneItems.length}개 완료</span>
                  </span>
                </div>
                <div className="format-download">
                  {doneImageItems.length > 0 && (
                    <div className="format-selector">
                      {FORMATS.map(f => (
                        <button
                          key={f.id}
                          className={`format-btn ${downloadFormat === f.id ? 'active' : ''}`}
                          onClick={() => setDownloadFormat(f.id)}
                        >
                          <span className="format-btn-label">{f.label}</span>
                          {totalFormatSizes[f.id] != null && (
                            <span className="format-btn-size">{formatBytes(totalFormatSizes[f.id])}</span>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                  <button className="btn-download" onClick={downloadZip} disabled={isZipping}>
                    {isZipping
                      ? <><span className="spinner" /> 생성 중...</>
                      : `⬇ ZIP (${doneItems.length}개)`}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </main>

      {/* 품질 미리보기 모달 */}
      {previewItem && (
        <PreviewModal
          item={previewItem}
          onClose={closePreview}
          onApply={(q) => applyItemQuality(previewItem.id, q)}
        />
      )}
    </div>
  );
}

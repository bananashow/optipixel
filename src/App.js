import { useState, useRef, useCallback } from 'react';
import imageCompression from 'browser-image-compression';
import JSZip from 'jszip';
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

const STATIC_FORMATS = [
  { id: 'jpeg', label: 'JPG'  },
  { id: 'png',  label: 'PNG'  },
  { id: 'webp', label: 'WebP' },
];

export default function App() {
  const [items, setItems] = useState([]);
  const [quality, setQuality] = useState(50);
  const [downloadFormat, setDownloadFormat] = useState('original');
  const [isZipping, setIsZipping] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef(null);

  const addFiles = useCallback((fileList) => {
    const newItems = Array.from(fileList)
      .filter(f => f.type.startsWith('image/'))
      .map(file => {
        const originalPreview = URL.createObjectURL(file);
        const item = {
          id: uid(),
          file,
          originalPreview,
          dimensions: null,
          compressedFile: null,
          compressedPreview: null,
          formatSizes: {},
          status: 'idle',
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
        return item;
      });
    setItems(prev => [...prev, ...newItems]);
  }, []);

  const removeItem = (id) => setItems(prev => prev.filter(it => it.id !== id));
  const clearAll = () => setItems([]);

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
    const toCompress = items.filter(it => it.status !== 'compressing');
    setItems(prev => prev.map(it =>
      toCompress.find(i => i.id === it.id)
        ? { ...it, status: 'compressing', compressedFile: null, compressedPreview: null, formatSizes: {} }
        : it
    ));

    for (const item of toCompress) {
      try {
        const options = {
          maxSizeMB: (item.file.size / 1024 / 1024) * (quality / 100),
          maxWidthOrHeight: Math.max(item.dimensions?.width || 9999, item.dimensions?.height || 9999),
          useWebWorker: true,
          alwaysKeepResolution: true,
          initialQuality: quality / 100,
          fileType: item.file.type,
        };
        const compressed = await imageCompression(item.file, options);
        const previewUrl = URL.createObjectURL(compressed);
        setItems(prev => prev.map(it =>
          it.id === item.id
            ? { ...it, compressedFile: compressed, compressedPreview: previewUrl, status: 'done' }
            : it
        ));
        measureFormatSizes(item.id, previewUrl, compressed.size, quality / 100);
      } catch (err) {
        console.error(err);
        setItems(prev => prev.map(it =>
          it.id === item.id ? { ...it, status: 'error' } : it
        ));
      }
    }
  };

  const downloadSingle = async (item) => {
    if (!item.compressedFile) return;
    const baseName = item.file.name.replace(/\.[^.]+$/, '');
    if (downloadFormat === 'original') {
      const ext = item.file.name.split('.').pop();
      const link = document.createElement('a');
      link.href = item.compressedPreview;
      link.download = `${baseName}_compressed.${ext}`;
      link.click();
      return;
    }
    const extMap = { jpeg: 'jpg', png: 'png', webp: 'webp' };
    const blob = await convertToFormat(item.compressedPreview, downloadFormat, quality / 100);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${baseName}_compressed.${extMap[downloadFormat]}`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const downloadZip = async () => {
    const doneItems = items.filter(it => it.status === 'done' && it.compressedFile);
    if (!doneItems.length) return;
    setIsZipping(true);
    try {
      const zip = new JSZip();
      const extMap = { jpeg: 'jpg', png: 'png', webp: 'webp' };
      for (const item of doneItems) {
        let blob;
        let ext;
        if (downloadFormat === 'original') {
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
      const url = URL.createObjectURL(content);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'optipixel_compressed.zip';
      link.click();
      URL.revokeObjectURL(url);
    } finally {
      setIsZipping(false);
    }
  };

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setIsDragging(false);
    addFiles(e.dataTransfer.files);
  }, [addFiles]);

  const handleDragOver  = (e) => { e.preventDefault(); setIsDragging(true); };
  const handleDragLeave = () => setIsDragging(false);
  const handleInputChange = (e) => { addFiles(e.target.files); e.target.value = ''; };

  const doneItems        = items.filter(it => it.status === 'done');
  const isCompressingAny = items.some(it => it.status === 'compressing');

  const allSameExt = items.length > 0 && items.every(it => getExtLabel(it.file) === getExtLabel(items[0].file));
  const originalFormatLabel = allSameExt ? getExtLabel(items[0]?.file) : '원본';

  const FORMATS = [
    { id: 'original', label: originalFormatLabel },
    ...STATIC_FORMATS,
  ];

  const totalFormatSizes = doneItems.reduce((acc, item) => {
    Object.entries(item.formatSizes).forEach(([fmt, size]) => {
      acc[fmt] = (acc[fmt] || 0) + size;
    });
    return acc;
  }, {});

  const totalOriginalSize   = items.reduce((s, it) => s + it.file.size, 0);
  const totalCompressedSize = doneItems.reduce((s, it) => s + (it.compressedFile?.size || 0), 0);
  const totalSaving         = getSavingPercent(totalOriginalSize, totalCompressedSize);

  return (
    <div className="app">
      <header className="app-header">
        <div className="logo-mark">⚡</div>
        <h1>OptiPixel</h1>
        <p>이미지 해상도 유지 · 용량 최적화</p>
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
              <p className="drop-zone-title">이미지를 드래그하거나 클릭해서 업로드</p>
              <p className="drop-zone-sub">JPG, PNG, WebP · 여러 장 동시 선택 가능</p>
            </>
          ) : (
            <p className="drop-zone-add">+ 이미지 추가</p>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
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
                  압축 품질
                  <span className="quality-value">{quality}%</span>
                </label>
                <input
                  type="range"
                  min={10}
                  max={99}
                  value={quality}
                  onChange={e => setQuality(Number(e.target.value))}
                  className="quality-slider"
                />
                <div className="quality-labels">
                  <span>최대 압축</span>
                  <span>최고 품질</span>
                </div>
              </div>
              <div className="controls-actions">
                <button className="btn-primary" onClick={compressAll} disabled={isCompressingAny}>
                  {isCompressingAny
                    ? <><span className="spinner" /> 압축 중...</>
                    : `전체 압축 (${items.length}장)`}
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
                    <img
                      src={item.compressedPreview || item.originalPreview}
                      alt={item.file.name}
                    />
                    {item.status === 'compressing' && (
                      <div className="file-card-overlay">
                        <div className="loading-ring" />
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
                    <span className="saving-count"> · {doneItems.length}장 완료</span>
                  </span>
                </div>
                <div className="format-download">
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
                  <button className="btn-download" onClick={downloadZip} disabled={isZipping}>
                    {isZipping
                      ? <><span className="spinner" /> 생성 중...</>
                      : `⬇ ZIP (${doneItems.length}장)`}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

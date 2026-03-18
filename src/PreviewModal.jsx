import { useState, useRef, useEffect, useCallback } from 'react';

const FORMATS = [
  { id: 'jpeg', label: 'JPG' },
  { id: 'webp', label: 'WebP' },
];

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

function getDefaultFormat(file) {
  if (file.type === 'image/webp') return 'webp';
  return 'jpeg';
}

export default function PreviewModal({ item, onClose, onApply }) {
  const defaultFormat = getDefaultFormat(item.file);

  const [quality, setQuality]           = useState(item.customQuality ?? 20);
  const [format, setFormat]             = useState(defaultFormat);
  const [sliderPos, setSliderPos]       = useState(50);
  const [blobUrl, setBlobUrl]           = useState(null);
  const [previewSize, setPreviewSize]   = useState(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [formatSizes, setFormatSizes]   = useState({ jpeg: null, webp: null });

  const comparatorRef    = useRef(null);
  const isSliderDragging = useRef(false);
  const timerRef         = useRef(null);
  const prevBlobRef      = useRef(null);
  const isFirstRender    = useRef(true);
  const prevFormatRef    = useRef(defaultFormat);

  // 원본 이미지에서 canvas 2장(일반 + JPEG 흰배경) 빌드
  const buildCanvases = useCallback(() => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width  = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);

      const cJpeg = document.createElement('canvas');
      cJpeg.width  = canvas.width;
      cJpeg.height = canvas.height;
      const ctxJ  = cJpeg.getContext('2d');
      // comparator 배경색으로 채워 투명 픽셀이 흰 테두리로 보이는 현상 방지
      ctxJ.fillStyle = '#0a0a0f';
      ctxJ.fillRect(0, 0, cJpeg.width, cJpeg.height);
      ctxJ.drawImage(img, 0, 0);

      resolve({ canvas, cJpeg });
    };
    img.onerror = () => resolve(null);
    img.src = item.originalPreview;
  }), [item]);

  // 선택된 포맷으로 비교 뷰어 blob 생성 + 모든 포맷 크기 측정
  const refreshAll = useCallback((q, fmt) => {
    setIsGenerating(true);

    buildCanvases().then((result) => {
      if (!result) { setIsGenerating(false); return; }
      const { canvas, cJpeg } = result;

      // 선택 포맷 preview blob
      const previewSrc = fmt === 'jpeg' ? cJpeg : canvas;
      previewSrc.toBlob((blob) => {
        if (blob) {
          if (prevBlobRef.current) URL.revokeObjectURL(prevBlobRef.current);
          const url = URL.createObjectURL(blob);
          prevBlobRef.current = url;
          setBlobUrl(url);
          setPreviewSize(blob.size);
          setFormatSizes(prev => ({ ...prev, [fmt]: blob.size }));
        }
        setIsGenerating(false);
      }, `image/${fmt}`, fmt !== 'png' ? q : undefined);

      // 나머지 포맷 크기 (백그라운드)
      FORMATS.filter(f => f.id !== fmt).forEach(({ id }) => {
        const src = id === 'jpeg' ? cJpeg : canvas;
        src.toBlob(
          (b) => setFormatSizes(prev => ({ ...prev, [id]: b?.size ?? 0 })),
          `image/${id}`,
          id !== 'png' ? q : undefined,
        );
      });
    });
  }, [buildCanvases]);

  // 마운트: 즉시 생성 + 언마운트 클린업
  useEffect(() => {
    refreshAll(0.20, defaultFormat);
    return () => {
      clearTimeout(timerRef.current);
      if (prevBlobRef.current) URL.revokeObjectURL(prevBlobRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // quality 또는 format 변경 시 재생성
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }

    const formatChanged = prevFormatRef.current !== format;
    prevFormatRef.current = format;

    clearTimeout(timerRef.current);
    // 포맷 변경은 즉시, 품질 변경은 350ms 디바운스
    timerRef.current = setTimeout(
      () => refreshAll(quality / 100, format),
      formatChanged ? 0 : 350,
    );
    return () => clearTimeout(timerRef.current);
  }, [quality, format, refreshAll]);

  // ESC 닫기
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // ── 비교 슬라이더 드래그 ──
  const updateSlider = (clientX) => {
    if (!comparatorRef.current) return;
    const rect = comparatorRef.current.getBoundingClientRect();
    setSliderPos(Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100)));
  };

  const handleMouseDown  = (e) => { e.preventDefault(); isSliderDragging.current = true;  updateSlider(e.clientX); };
  const handleMouseMove  = (e) => { if (isSliderDragging.current) updateSlider(e.clientX); };
  const handleMouseUp    = ()  => { isSliderDragging.current = false; };
  const handleTouchStart = (e) => { isSliderDragging.current = true;  updateSlider(e.touches[0].clientX); };
  const handleTouchMove  = (e) => { e.preventDefault(); updateSlider(e.touches[0].clientX); };

  const saving = previewSize ? getSavingPercent(item.file.size, previewSize) : null;

  return (
    <div className="preview-backdrop" onClick={onClose}>
      <div className="preview-modal" onClick={(e) => e.stopPropagation()}>

        {/* 헤더 */}
        <div className="preview-modal-header">
          <div className="preview-modal-title">
            <span>품질 미리보기</span>
            <span className="preview-modal-filename">{item.file.name}</span>
          </div>
          <button className="preview-modal-close" onClick={onClose}>×</button>
        </div>

        {/* 포맷 탭 */}
        <div className="preview-format-tabs">
          {FORMATS.map((f) => {
            const size = formatSizes[f.id];
            return (
              <button
                key={f.id}
                className={`preview-format-tab ${format === f.id ? 'active' : ''}`}
                onClick={() => setFormat(f.id)}
              >
                <span className="preview-format-tab-label">{f.label}</span>
                {size != null ? (
                  <span className="preview-format-tab-meta">{formatBytes(size)}</span>
                ) : (
                  <span className="preview-format-tab-meta preview-format-tab-loading">…</span>
                )}
              </button>
            );
          })}
        </div>

        {/* 슬라이더 비교 뷰어 */}
        <div
          className="preview-comparator"
          ref={comparatorRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleMouseUp}
        >
          <img className="comparator-img" src={item.originalPreview} alt="원본" draggable={false} />

          {blobUrl && (
            <div
              style={{ position: 'absolute', inset: 0, clipPath: `inset(0 0 0 ${sliderPos}%)` }}
            >
              <img
                className="comparator-img"
                src={blobUrl}
                alt="압축 미리보기"
                draggable={false}
              />
            </div>
          )}

          {isGenerating && (
            <div className="comparator-generating">
              <div className="loading-ring" />
              <span>생성 중…</span>
            </div>
          )}

          <div className="comparator-divider" style={{ left: `${sliderPos}%` }}>
            <div className="comparator-handle">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <path d="M8 6L3 12l5 6M16 6l5 6-5 6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
          </div>

          <div className="comparator-label comparator-label--before">원본</div>
          {!isGenerating && blobUrl && (
            <div className="comparator-label comparator-label--after">
              {FORMATS.find(f => f.id === format)?.label}
            </div>
          )}
        </div>

        {/* 하단: 파일 크기 + 품질 슬라이더 */}
        <div className="preview-modal-footer">
          <div className="preview-footer-row">
            <div className="preview-size-info">
              <span className="preview-size-item">
                <span className="preview-size-label">원본</span>
                <span className="preview-size-val">{formatBytes(item.file.size)}</span>
              </span>
              <span className="preview-size-arrow">→</span>
              <span className="preview-size-item">
                <span className="preview-size-label">{FORMATS.find(f => f.id === format)?.label}</span>
                <span className="preview-size-val preview-size-val--compressed">
                  {previewSize ? formatBytes(previewSize) : '—'}
                </span>
              </span>
              {saving != null && saving > 0 && (
                <span className="preview-saving-badge">-{saving}%</span>
              )}
            </div>
            <button
              className="preview-apply-btn"
              onClick={() => onApply(quality)}
              disabled={isGenerating}
            >
              이 설정 적용 (압축 {100 - quality}%)
            </button>
          </div>

          <div className="quality-control">
            <label>
              압축률
              <span className="quality-value">{100 - quality}%</span>
            </label>
            <input
              type="range"
              min={1}
              max={99}
              value={100 - quality}
              onChange={(e) => setQuality(100 - Number(e.target.value))}
              className="quality-slider"
            />
            <div className="quality-labels">
              <span>화질 우선</span>
              <span>용량 우선</span>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}

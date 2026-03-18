import { useState, useRef, useEffect, useCallback } from 'react';

// Safari/iOS는 canvas.toBlob('image/webp')를 지원하지 않아 PNG로 폴백함
const CAN_ENCODE_WEBP = (() => {
  try {
    const c = document.createElement('canvas');
    c.width = 1; c.height = 1;
    return c.toDataURL('image/webp').startsWith('data:image/webp');
  } catch {
    return false;
  }
})();

const FORMATS = [
  { id: 'jpeg', label: 'JPG' },
  ...(CAN_ENCODE_WEBP ? [{ id: 'webp', label: 'WebP' }] : []),
];

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;

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
  if (CAN_ENCODE_WEBP && file.type === 'image/webp') return 'webp';
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

  // Zoom / pan state
  const [zoom, setZoom]       = useState(1);
  const [pan, setPan]         = useState({ x: 0, y: 0 });
  const [isGrabbing, setIsGrabbing] = useState(false);
  const [cW, setCW]           = useState(1); // comparator width (from ResizeObserver)
  const [cH, setCH]           = useState(1);

  // Mutable refs — always in sync with the state above for use in event handlers
  const zoomRef      = useRef(1);
  const panRef       = useRef({ x: 0, y: 0 });
  const sliderRef    = useRef(50);

  const setZoomS   = (v) => { zoomRef.current = v; setZoom(v); };
  const setPanS    = (v) => { panRef.current  = v; setPan(v); };
  const setSliderS = (v) => { sliderRef.current = v; setSliderPos(v); };

  // Interaction refs
  const comparatorRef     = useRef(null);
  const isDraggingDivider = useRef(false);
  const isPanning         = useRef(false);
  const lastDragPos       = useRef({ x: 0, y: 0 });
  const pinchState        = useRef(null);

  // Image-generation refs
  const timerRef      = useRef(null);
  const prevBlobRef   = useRef(null);
  const isFirstRender = useRef(true);
  const prevFormatRef = useRef(defaultFormat);

  // ── Track comparator size ──────────────────────────────────────────────────
  useEffect(() => {
    const el = comparatorRef.current;
    if (!el) return;

    // ResizeObserver 지연 대비: 마운트 직후 즉시 측정
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width  > 1) setCW(r.width);
      if (r.height > 1) setCH(r.height);
    };
    measure();
    // 레이아웃 확정 후 재측정 (모바일에서 레이아웃이 늦을 수 있음)
    const t = setTimeout(measure, 100);

    const ro = new ResizeObserver(([entry]) => {
      setCW(entry.contentRect.width  || 1);
      setCH(entry.contentRect.height || 1);
    });
    ro.observe(el);
    return () => { clearTimeout(t); ro.disconnect(); };
  }, []);

  // ── Pan clamping ───────────────────────────────────────────────────────────
  const clampPan = (px, py, z) => {
    const el = comparatorRef.current;
    if (!el) return { x: px, y: py };
    const r = el.getBoundingClientRect();
    const maxX = r.width  * (z - 1) / 2;
    const maxY = r.height * (z - 1) / 2;
    return {
      x: Math.max(-maxX, Math.min(maxX, px)),
      y: Math.max(-maxY, Math.min(maxY, py)),
    };
  };

  // ── Coordinate helpers ─────────────────────────────────────────────────────
  // Viewport X (relative to comparator left) → slider %
  const vpXToSlider = (clientX) => {
    const el = comparatorRef.current;
    if (!el) return sliderRef.current;
    const r  = el.getBoundingClientRect();
    const vx = clientX - r.left;
    const cx = (vx - r.width / 2 - panRef.current.x) / zoomRef.current + r.width / 2;
    return Math.max(0, Math.min(100, (cx / r.width) * 100));
  };

  // Is the viewport X within grab range of the divider?
  const isNearDivider = (clientX) => {
    const el = comparatorRef.current;
    if (!el) return true;
    const r       = el.getBoundingClientRect();
    const vx      = clientX - r.left;
    const divVX   = (sliderRef.current / 100 - 0.5) * r.width * zoomRef.current
                    + r.width / 2 + panRef.current.x;
    return Math.abs(vx - divVX) < 32;
  };

  // ── Mouse handlers ─────────────────────────────────────────────────────────
  const handleMouseDown = (e) => {
    e.preventDefault();
    if (isNearDivider(e.clientX) || zoomRef.current === 1) {
      isDraggingDivider.current = true;
      setSliderS(vpXToSlider(e.clientX));
    } else {
      isPanning.current = true;
      setIsGrabbing(true);
      lastDragPos.current = { x: e.clientX, y: e.clientY };
    }
  };

  const handleMouseMove = (e) => {
    if (isDraggingDivider.current) {
      setSliderS(vpXToSlider(e.clientX));
    } else if (isPanning.current) {
      const dx = e.clientX - lastDragPos.current.x;
      const dy = e.clientY - lastDragPos.current.y;
      lastDragPos.current = { x: e.clientX, y: e.clientY };
      setPanS(clampPan(panRef.current.x + dx, panRef.current.y + dy, zoomRef.current));
    }
  };

  const handleMouseUp = () => {
    isDraggingDivider.current = false;
    isPanning.current = false;
    setIsGrabbing(false);
  };

  // ── Touch handlers ─────────────────────────────────────────────────────────
  const handleTouchStart = (e) => {
    if (e.touches.length === 1) {
      const t = e.touches[0];
      if (isNearDivider(t.clientX) || zoomRef.current === 1) {
        isDraggingDivider.current = true;
        isPanning.current = false;
        setSliderS(vpXToSlider(t.clientX));
      } else {
        isPanning.current = true;
        isDraggingDivider.current = false;
        lastDragPos.current = { x: t.clientX, y: t.clientY };
      }
    } else if (e.touches.length === 2) {
      isDraggingDivider.current = false;
      isPanning.current = false;
      const dx = e.touches[1].clientX - e.touches[0].clientX;
      const dy = e.touches[1].clientY - e.touches[0].clientY;
      pinchState.current = {
        startDist: Math.hypot(dx, dy),
        startZoom: zoomRef.current,
        startPan:  { ...panRef.current },
        startMidX: (e.touches[0].clientX + e.touches[1].clientX) / 2,
        startMidY: (e.touches[0].clientY + e.touches[1].clientY) / 2,
      };
    }
  };

  const handleTouchMove = (e) => {
    if (e.touches.length === 1) {
      const t = e.touches[0];
      if (isDraggingDivider.current) {
        setSliderS(vpXToSlider(t.clientX));
      } else if (isPanning.current) {
        const dx = t.clientX - lastDragPos.current.x;
        const dy = t.clientY - lastDragPos.current.y;
        lastDragPos.current = { x: t.clientX, y: t.clientY };
        setPanS(clampPan(panRef.current.x + dx, panRef.current.y + dy, zoomRef.current));
      }
    } else if (e.touches.length === 2 && pinchState.current) {
      const ps = pinchState.current;
      const el = comparatorRef.current;
      if (!el) return;

      const dx   = e.touches[1].clientX - e.touches[0].clientX;
      const dy   = e.touches[1].clientY - e.touches[0].clientY;
      const dist = Math.hypot(dx, dy);
      const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, ps.startZoom * (dist / ps.startDist)));

      const r       = el.getBoundingClientRect();
      const curMidX = (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left  - r.width  / 2;
      const curMidY = (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top   - r.height / 2;
      const sMidX   = ps.startMidX - r.left  - r.width  / 2;
      const sMidY   = ps.startMidY - r.top   - r.height / 2;
      const ratio   = newZoom / ps.startZoom;
      const newPanX = curMidX - (sMidX - ps.startPan.x) * ratio;
      const newPanY = curMidY - (sMidY - ps.startPan.y) * ratio;

      if (newZoom <= MIN_ZOOM) {
        setZoomS(MIN_ZOOM);
        setPanS({ x: 0, y: 0 });
      } else {
        setZoomS(newZoom);
        setPanS(clampPan(newPanX, newPanY, newZoom));
      }
    }
  };

  const handleTouchEnd = (e) => {
    if (e.touches.length < 2) pinchState.current = null;
    if (e.touches.length === 0) {
      isDraggingDivider.current = false;
      isPanning.current = false;
    }
  };

  // ── Mouse-wheel zoom (non-passive) ─────────────────────────────────────────
  useEffect(() => {
    const el = comparatorRef.current;
    if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      const r        = el.getBoundingClientRect();
      const delta    = e.deltaY > 0 ? -0.3 : 0.3;
      const newZoom  = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoomRef.current + delta));
      if (newZoom === zoomRef.current) return;

      const cx    = e.clientX - r.left  - r.width  / 2;
      const cy    = e.clientY - r.top   - r.height / 2;
      const ratio = newZoom / zoomRef.current;
      const newPanX = cx - (cx - panRef.current.x) * ratio;
      const newPanY = cy - (cy - panRef.current.y) * ratio;

      if (newZoom <= MIN_ZOOM) {
        setZoomS(MIN_ZOOM);
        setPanS({ x: 0, y: 0 });
      } else {
        setZoomS(newZoom);
        setPanS(clampPan(newPanX, newPanY, newZoom));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Zoom buttons ───────────────────────────────────────────────────────────
  const doZoomIn = () => {
    const nz = Math.min(MAX_ZOOM, Math.round((zoomRef.current + 0.5) * 10) / 10);
    setZoomS(nz);
  };
  const doZoomOut = () => {
    const nz = Math.max(MIN_ZOOM, Math.round((zoomRef.current - 0.5) * 10) / 10);
    if (nz <= MIN_ZOOM) { setZoomS(MIN_ZOOM); setPanS({ x: 0, y: 0 }); }
    else setZoomS(nz);
  };
  const doZoomReset = () => { setZoomS(MIN_ZOOM); setPanS({ x: 0, y: 0 }); };

  // ── Derived: divider position in viewport % ────────────────────────────────
  // Formula: dividerVPct = (sliderPos − 50) × zoom + 50 + pan.x / cW × 100
  const dividerViewportPct = (sliderPos - 50) * zoom + 50 + (pan.x / cW) * 100;

  // ── Cursor style ───────────────────────────────────────────────────────────
  const cursor = isGrabbing ? 'grabbing' : zoom > 1 ? 'grab' : 'col-resize';

  // ── Image generation ─────────────────────────────────────────────────────
  // 풀 해상도 캔버스 사용 → 실제 다운로드 파일과 동일한 품질/크기 표현
  // 초기 줌은 아래 useEffect에서 자동 설정해 모바일에서도 아티팩트가 보이도록 함
  const buildCanvases = useCallback(() => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;

      const canvas = document.createElement('canvas');
      canvas.width  = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0);

      // JPEG용: 다크 배경 위에 그려 투명 채널 처리
      const cJpeg = document.createElement('canvas');
      cJpeg.width  = w;
      cJpeg.height = h;
      const ctxJ  = cJpeg.getContext('2d');
      ctxJ.fillStyle = '#0a0a0f';
      ctxJ.fillRect(0, 0, w, h);
      ctxJ.drawImage(img, 0, 0);

      resolve({ canvas, cJpeg });
    };
    img.onerror = () => resolve(null);
    img.src = item.originalPreview;
  }), [item]);

  const refreshAll = useCallback((q, fmt) => {
    setIsGenerating(true);
    buildCanvases().then((result) => {
      if (!result) { setIsGenerating(false); return; }
      const { canvas, cJpeg } = result;

      const previewSrc = fmt === 'jpeg' ? cJpeg : canvas;
      previewSrc.toBlob((blob) => {
        if (blob) {
          if (prevBlobRef.current) URL.revokeObjectURL(prevBlobRef.current);
          // iOS Safari image decode cache 우회: fragment 추가로 매번 새로운 URL 인식
          const url = URL.createObjectURL(blob) + '#' + Date.now();
          prevBlobRef.current = url.split('#')[0]; // revoke 시엔 fragment 없는 URL 사용
          setBlobUrl(url);
          setPreviewSize(blob.size);
          setFormatSizes(prev => ({ ...prev, [fmt]: blob.size }));
        }
        setIsGenerating(false);
      }, `image/${fmt}`, fmt !== 'png' ? q : undefined);

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

  useEffect(() => {
    refreshAll(0.20, defaultFormat);
    return () => {
      clearTimeout(timerRef.current);
      if (prevBlobRef.current) URL.revokeObjectURL(prevBlobRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 초기 줌 자동 설정 (1회만 실행) ──────────────────────────────────────
  // 풀 해상도 이미지에서 JPEG 8×8 블록이 화면에서 최소 2 CSS px로 보이도록
  // 공식: zoom = (2 × img_width) / (8 × container_width)
  const initZoomSetRef = useRef(false);
  useEffect(() => {
    if (initZoomSetRef.current) return;     // 이미 설정됨 → 재실행 방지
    const imgW       = item.dimensions?.width || 0;
    const containerW = cW > 1 ? cW : 0;
    if (imgW === 0 || containerW === 0) return;
    initZoomSetRef.current = true;
    const targetZoom = (2 * imgW) / (8 * containerW);
    const initZoom   = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, targetZoom));
    if (initZoom > 1) setZoomS(initZoom);
  }, [cW, item.dimensions?.width]);

  useEffect(() => {
    if (isFirstRender.current) { isFirstRender.current = false; return; }
    const formatChanged = prevFormatRef.current !== format;
    prevFormatRef.current = format;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(
      () => refreshAll(quality / 100, format),
      formatChanged ? 0 : 350,
    );
    return () => clearTimeout(timerRef.current);
  }, [quality, format, refreshAll]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

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

        {/* ── 비교 뷰어 ── */}
        <div
          className="preview-comparator"
          ref={comparatorRef}
          style={{ touchAction: 'none', cursor }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        >
          {/*
            overflow:hidden + width 슬라이싱 방식 (Safari 완전 호환)
            [배경] 압축 이미지 전체 표시 / [오버레이] 원본 이미지를 왼쪽 clipPct%만 표시
          */}
          {(() => {
            // object-fit: contain 을 JS로 직접 계산 (Safari CSS 의존 없음)
            const imgW = item.dimensions?.width  || 0;
            const imgH = item.dimensions?.height || 0;
            const canFit = cW > 1 && cH > 1 && imgW > 0 && imgH > 0;

            let imgLeft = 0, imgTop = 0, imgFitW = cW, imgFitH = cH;
            let originX = cW / 2, originY = cH / 2;

            if (canFit) {
              const scale = Math.min(cW / imgW, cH / imgH);
              imgFitW  = imgW * scale;
              imgFitH  = imgH * scale;
              imgLeft  = (cW - imgFitW) / 2;
              imgTop   = (cH - imgFitH) / 2;
              originX  = cW / 2 - imgLeft;
              originY  = cH / 2 - imgTop;
            }

            const hasZoom    = zoom !== 1 || pan.x !== 0 || pan.y !== 0;
            const zTransform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;
            const zOrigin    = `${originX}px ${originY}px`;

            // 두 이미지에 공통으로 적용할 스타일
            const imgStyle = {
              position: 'absolute',
              display: 'block',
              pointerEvents: 'none',
              ...(canFit ? {
                top: imgTop,
                left: imgLeft,
                width: imgFitW,
                height: imgFitH,
              } : {
                top: 0, left: 0,
                width: '100%', height: '100%',
                objectFit: 'contain',
              }),
              ...(hasZoom ? { transform: zTransform, transformOrigin: zOrigin } : {}),
            };

            // 오버레이 클리핑: 뷰포트 기준 dividerViewportPct% (줌/패닝 반영)
            const clipPct = Math.max(0, Math.min(100, dividerViewportPct));

            return (
              <>
                {/* 배경: 압축 이미지 (전체 표시) */}
                {blobUrl
                  ? <img src={blobUrl}            alt="압축 미리보기" draggable={false} style={imgStyle} />
                  : <img src={item.originalPreview} alt="로딩 중"    draggable={false} style={imgStyle} />
                }

                {/* 오버레이: 원본 이미지 (왼쪽 clipPct% 만큼만 표시) */}
                <div style={{
                  position: 'absolute',
                  left: 0, top: 0,
                  width: `${clipPct}%`,
                  height: '100%',
                  overflow: 'hidden',
                }}>
                  <img
                    src={item.originalPreview}
                    alt="원본"
                    draggable={false}
                    style={imgStyle}
                  />
                </div>
              </>
            );
          })()}

          {/* 생성 중 오버레이 */}
          {isGenerating && (
            <div className="comparator-generating">
              <div className="loading-ring" />
              <span>생성 중…</span>
            </div>
          )}

          {/* 구분선 — 뷰포트 좌표계 */}
          <div className="comparator-divider" style={{ left: `${dividerViewportPct}%` }}>
            <div className="comparator-handle">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <path
                  d="M8 6L3 12l5 6M16 6l5 6-5 6"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
          </div>

          {/* 라벨 */}
          <div className="comparator-label comparator-label--before">원본</div>
          {!isGenerating && blobUrl && (
            <div className="comparator-label comparator-label--after">
              {FORMATS.find(f => f.id === format)?.label}
            </div>
          )}

          {/* 줌 컨트롤 */}
          <div className="zoom-controls" onMouseDown={(e) => e.stopPropagation()}>
            <button
              className="zoom-btn"
              onClick={doZoomOut}
              disabled={zoom <= MIN_ZOOM}
              title="축소"
            >−</button>
            <button
              className="zoom-btn zoom-btn--label"
              onClick={doZoomReset}
              title="원래 크기로"
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              className="zoom-btn"
              onClick={doZoomIn}
              disabled={zoom >= MAX_ZOOM}
              title="확대"
            >+</button>
          </div>
        </div>

        {/* 하단: 크기 정보 + 품질 슬라이더 */}
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

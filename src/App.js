import { useState, useRef, useCallback } from 'react';
import imageCompression from 'browser-image-compression';
import './App.css';

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function getSavingPercent(original, compressed) {
  if (!original || !compressed) return 0;
  return Math.round((1 - compressed / original) * 100);
}

export default function App() {
  const [originalFile, setOriginalFile] = useState(null);
  const [originalPreview, setOriginalPreview] = useState(null);
  const [compressedFile, setCompressedFile] = useState(null);
  const [compressedPreview, setCompressedPreview] = useState(null);
  const [quality, setQuality] = useState(50);
  const [isCompressing, setIsCompressing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [imageDimensions, setImageDimensions] = useState(null);
  const fileInputRef = useRef(null);

  const handleFile = useCallback((file) => {
    if (!file || !file.type.startsWith('image/')) return;

    setOriginalFile(file);
    setCompressedFile(null);
    setCompressedPreview(null);

    const url = URL.createObjectURL(file);
    setOriginalPreview(url);

    const img = new Image();
    img.onload = () => {
      setImageDimensions({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.src = url;
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    handleFile(file);
  }, [handleFile]);

  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => setIsDragging(false);

  const handleInputChange = (e) => {
    handleFile(e.target.files[0]);
  };

  const compress = async () => {
    if (!originalFile) return;
    setIsCompressing(true);

    try {
      const options = {
        maxSizeMB: (originalFile.size / 1024 / 1024) * (quality / 100),
        maxWidthOrHeight: Math.max(imageDimensions?.width || 9999, imageDimensions?.height || 9999),
        useWebWorker: true,
        alwaysKeepResolution: true,
        initialQuality: quality / 100,
        fileType: originalFile.type,
      };

      const compressed = await imageCompression(originalFile, options);
      setCompressedFile(compressed);
      setCompressedPreview(URL.createObjectURL(compressed));
    } catch (err) {
      console.error(err);
    } finally {
      setIsCompressing(false);
    }
  };

  const handleDownload = () => {
    if (!compressedFile) return;
    const ext = originalFile.name.split('.').pop();
    const baseName = originalFile.name.replace(/\.[^.]+$/, '');
    const link = document.createElement('a');
    link.href = compressedPreview;
    link.download = `${baseName}_compressed.${ext}`;
    link.click();
  };

  const saving = getSavingPercent(originalFile?.size, compressedFile?.size);

  return (
    <div className="app">
      <header className="app-header">
        <div className="logo-mark">⚡</div>
        <h1>OptiPixel</h1>
        <p>이미지 해상도 유지 · 용량 최적화</p>
      </header>

      <main className="app-main">
        {/* 업로드 영역 */}
        {!originalFile && (
          <div
            className={`drop-zone ${isDragging ? 'dragging' : ''}`}
            onClick={() => fileInputRef.current.click()}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
          >
            <div className="drop-zone-icon">🖼️</div>
            <p className="drop-zone-title">이미지를 드래그하거나 클릭해서 업로드</p>
            <p className="drop-zone-sub">JPG, PNG, WebP 지원</p>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleInputChange}
              hidden
            />
          </div>
        )}

        {/* 이미지 업로드 후 */}
        {originalFile && (
          <>
            <div className="controls-bar">
              <button className="btn-secondary" onClick={() => {
                setOriginalFile(null);
                setOriginalPreview(null);
                setCompressedFile(null);
                setCompressedPreview(null);
                setImageDimensions(null);
              }}>
                ← 다른 이미지
              </button>

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
                  onChange={(e) => {
                    setQuality(Number(e.target.value));
                    setCompressedFile(null);
                    setCompressedPreview(null);
                  }}
                  className="quality-slider"
                />
                <div className="quality-labels">
                  <span>최대 압축</span>
                  <span>최고 품질</span>
                </div>
              </div>

              <button
                className="btn-primary"
                onClick={compress}
                disabled={isCompressing}
              >
                {isCompressing ? (
                  <><span className="spinner" /> 압축 중...</>
                ) : '압축하기'}
              </button>
            </div>

            {/* 미리보기 */}
            <div className="preview-grid">
              <div className="preview-card">
                <div className="preview-label">원본</div>
                <div className="preview-img-wrap">
                  <img src={originalPreview} alt="원본" />
                </div>
                <div className="preview-info">
                  <span className="file-size">{formatBytes(originalFile.size)}</span>
                  {imageDimensions && (
                    <span className="dimensions">{imageDimensions.width} × {imageDimensions.height}px</span>
                  )}
                </div>
              </div>

              <div className="preview-arrow">→</div>

              <div className={`preview-card ${!compressedFile ? 'preview-card--empty' : ''}`}>
                <div className="preview-label">압축 결과</div>
                <div className="preview-img-wrap">
                  {compressedPreview
                    ? <img src={compressedPreview} alt="압축 결과" />
                    : <div className="preview-placeholder">
                        {isCompressing
                          ? <><div className="loading-ring" /><p>압축 중...</p></>
                          : <p>압축 후 결과가<br />여기에 표시됩니다</p>
                        }
                      </div>
                  }
                </div>
                <div className="preview-info">
                  {compressedFile && (
                    <>
                      <span className="file-size compressed">{formatBytes(compressedFile.size)}</span>
                      {imageDimensions && (
                        <span className="dimensions">{imageDimensions.width} × {imageDimensions.height}px</span>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* 결과 요약 */}
            {compressedFile && (
              <div className="result-summary">
                <div className="saving-badge">
                  <span className="saving-percent">-{saving}%</span>
                  <span className="saving-label">용량 절감</span>
                </div>
                <div className="saving-bar-wrap">
                  <div className="saving-bar">
                    <div
                      className="saving-bar-fill"
                      style={{ width: `${100 - saving}%` }}
                    />
                  </div>
                  <div className="saving-bar-labels">
                    <span>{formatBytes(originalFile.size)}</span>
                    <span>{formatBytes(compressedFile.size)}</span>
                  </div>
                </div>
                <button className="btn-download" onClick={handleDownload}>
                  ⬇ 다운로드
                </button>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

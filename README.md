# OptiPixel

이미지·동영상의 해상도를 유지하면서 파일 용량만 최적화하는 무료 클라이언트 사이드 압축 도구입니다.  
파일이 서버로 전송되지 않으며, 모든 처리는 브라우저 내에서 완료됩니다.

## 기능

### 이미지
- JPG, PNG, WebP 지원
- 드래그 앤 드롭 / 클릭 업로드 (여러 파일 동시 선택)
- 전체 압축률 슬라이더 (화질 우선 ↔ 용량 우선)
- 이미지별 개별 압축률 설정 (미리보기 모달에서 적용)
- JPG / WebP 포맷 변환 후 일괄 ZIP 다운로드
- 이미지 병렬 압축 처리

### 동영상
- MP4, MOV, WebM 지원 (FFmpeg WASM 기반)
- 최대 2개 동시 병렬 압축
- 압축 진행률 실시간 표시

### 품질 미리보기 모달
- 원본 vs 압축 결과를 드래그 슬라이더로 실시간 비교 (Squoosh 스타일)
- JPG / WebP 포맷별 예상 파일 크기 확인
- 압축률 슬라이더로 즉시 미리보기 갱신
- 마음에 드는 설정을 해당 이미지에만 적용 가능

## 시작하기

```bash
npm install
npm run dev
```

## 빌드

```bash
npm run build
```

## 기술 스택

- React 19
- [browser-image-compression](https://github.com/Donaldcwl/browser-image-compression)
- [@ffmpeg/ffmpeg](https://github.com/ffmpegwasm/ffmpeg.wasm) — 동영상 압축
- [jszip](https://github.com/Stuk/jszip) — ZIP 다운로드

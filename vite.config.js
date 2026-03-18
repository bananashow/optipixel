import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    // Vite transform 파이프라인을 거치지 않고 /ffmpeg/* 파일을 직접 서빙
    {
      name: 'serve-ffmpeg-static',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (!req.url?.startsWith('/ffmpeg/')) { next(); return; }

          const filePath = path.join(__dirname, 'public', req.url.split('?')[0]);
          if (!fs.existsSync(filePath)) { next(); return; }

          const ext = path.extname(filePath).toLowerCase();
          if (ext === '.wasm') res.setHeader('Content-Type', 'application/wasm');
          else if (ext === '.js') res.setHeader('Content-Type', 'application/javascript');
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

          fs.createReadStream(filePath).pipe(res);
        });
      },
    },
    react(),
  ],
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
});

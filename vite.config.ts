import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { copyFileSync, existsSync, renameSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

// Two build targets share this single config:
//
//   • Default (no env): builds the staff Lounge app from
//     index.html → src/main.tsx. Output goes to dist/.
//
//   • VITE_BUILD_TARGET=widget: builds the customer-facing
//     widget from widget.html → src/widget-main.tsx, also into
//     dist/. The bundle excludes everything outside
//     src/widget/* (and shared libs) by tree-shaking — there's
//     no staff code in the customer deployment by construction.
//     A close-bundle hook renames dist/widget.html to
//     dist/index.html so Vercel serves it as the SPA root.
//
// Two separate Vercel projects deploy from this same repo:
//
//   • lounge.venneir.com — staff app, build command:
//     `npm run build`
//   • book.venneir.com   — customer widget, build command:
//     `npm run build:widget`

const target = process.env.VITE_BUILD_TARGET ?? 'main';
const isWidget = target === 'widget';

export default defineConfig({
  plugins: [
    react(),
    isWidget && {
      name: 'lounge-widget-rename-html',
      // Vite/rollup outputs an HTML file named after the input
      // (`widget.html`). Vercel serves /index.html as the SPA
      // entry, so rename after the build closes.
      closeBundle() {
        const dist = resolve(process.cwd(), 'dist');
        const from = resolve(dist, 'widget.html');
        const to = resolve(dist, 'index.html');
        if (existsSync(from)) {
          // If a stale dist/index.html (from a prior staff build)
          // is sitting there, drop it — only the widget entry
          // belongs in this dist.
          if (existsSync(to)) rmSync(to);
          renameSync(from, to);
        }
        // The customer build doesn't need the staff favicon
        // assets renamed, but copy a fresh favicon link target
        // if the public dir is shared.
        const pub = resolve(process.cwd(), 'public');
        const fav = resolve(pub, 'lounge-fav.png');
        if (existsSync(fav) && !existsSync(resolve(dist, 'lounge-fav.png'))) {
          copyFileSync(fav, resolve(dist, 'lounge-fav.png'));
        }
      },
    },
  ].filter(Boolean) as ReturnType<typeof react>[],
  server: {
    port: 5173,
    strictPort: true,
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      input: isWidget
        ? resolve(process.cwd(), 'widget.html')
        : resolve(process.cwd(), 'index.html'),
      output: {
        manualChunks: isWidget
          ? {
              'react-vendor': ['react', 'react-dom', 'react-router-dom'],
              supabase: ['@supabase/supabase-js'],
              stripe: ['@stripe/stripe-js'],
              icons: ['lucide-react'],
            }
          : {
              'react-vendor': ['react', 'react-dom', 'react-router-dom'],
              supabase: ['@supabase/supabase-js'],
              stripe: ['@stripe/stripe-js'],
              icons: ['lucide-react'],
            },
      },
    },
  },
});

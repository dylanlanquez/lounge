import { defineConfig, type UserConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { copyFileSync, existsSync, renameSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

// Build targets share this single config. `VITE_BUILD_TARGET` is
// the switch:
//
//   • main (default)               — staff Lounge app from
//                                    index.html → src/main.tsx,
//                                    deployed to lounge.venneir.com.
//
//   • widget                       — legacy customer iframe from
//                                    widget.html → src/widget-main.tsx,
//                                    deployed to book.venneir.com.
//                                    Stays in place until the modal-
//                                    overlay embed (below) has fully
//                                    rolled out per Shopify page.
//
//   • widget-venneir-bundle        — full React widget bundle for the
//                                    venneir.com modal embed. Library
//                                    mode, no HTML, output to
//                                    dist/widgets/venneir/main.js.
//                                    Lazy-loaded by embed/venneir.js
//                                    on the first trigger click.
//
//   • widget-venneir-embed         — tiny IIFE hosted at
//                                    /embed/venneir.js. Loads
//                                    upfront on every Shopify page,
//                                    binds [data-vlounge-open]
//                                    triggers, opens the modal and
//                                    pulls the bundle on click.
//
//   • widget-denture-bundle        — full React widget bundle for
//                                    denture-services.co.uk modal
//                                    embed, output to
//                                    dist/widgets/denture/main.js.
//
//   • widget-denture-embed         — tiny IIFE at /embed/denture.js
//                                    that binds [data-dental-open].
//
// Vercel deployments today:
//
//   • lounge.venneir.com — staff app, `npm run build`. Also serves
//     the new /embed/*.js + /widgets/*/main.*.js bundles to Shopify.
//   • book.venneir.com   — legacy iframe widget, `npm run build:widget`.
//                          Retires once every Shopify page is on the
//                          modal embed.

type BuildTarget =
  | 'main'
  | 'widget'
  | 'widget-venneir-bundle'
  | 'widget-venneir-embed'
  | 'widget-denture-bundle'
  | 'widget-denture-embed';

const target = (process.env.VITE_BUILD_TARGET ?? 'main') as BuildTarget;

const isLegacyWidget = target === 'widget';
const isBundle = target === 'widget-venneir-bundle' || target === 'widget-denture-bundle';
const isEmbed = target === 'widget-venneir-embed' || target === 'widget-denture-embed';
const isVenneir = target === 'widget-venneir-bundle' || target === 'widget-venneir-embed';

// Resolves the brand bundle URL at build time so embed scripts know
// where to lazy-import from. Override via env (VLOUNGE_BUNDLE_URL,
// DLOUNGE_BUNDLE_URL) per deploy if the bundle moves origins.
const BUNDLE_BASE = process.env.VLOUNGE_BUNDLE_BASE ?? 'https://lounge.venneir.com';

export default defineConfig((): UserConfig => {
  if (isBundle) {
    return bundleConfig(isVenneir ? 'venneir' : 'denture');
  }
  if (isEmbed) {
    return embedConfig(isVenneir ? 'venneir' : 'denture');
  }
  return mainOrLegacyConfig();
});

// ── Main app + legacy widget (the two existing build targets) ──
function mainOrLegacyConfig(): UserConfig {
  return {
    plugins: [
      react(),
      isLegacyWidget && {
        name: 'lounge-widget-rename-html',
        // Vite/rollup outputs an HTML file named after the input
        // (`widget.html`). Vercel serves /index.html as the SPA
        // entry, so rename after the build closes.
        closeBundle() {
          const dist = resolve(process.cwd(), 'dist');
          const from = resolve(dist, 'widget.html');
          const to = resolve(dist, 'index.html');
          if (existsSync(from)) {
            if (existsSync(to)) rmSync(to);
            renameSync(from, to);
          }
          const pub = resolve(process.cwd(), 'public');
          const fav = resolve(pub, 'lounge-fav.png');
          if (existsSync(fav) && !existsSync(resolve(dist, 'lounge-fav.png'))) {
            copyFileSync(fav, resolve(dist, 'lounge-fav.png'));
          }
        },
      },
    ].filter(Boolean) as ReturnType<typeof react>[],
    server: { port: 5173, strictPort: true },
    preview: { port: 4173, strictPort: true },
    build: {
      target: 'es2022',
      sourcemap: true,
      rollupOptions: {
        input: isLegacyWidget
          ? resolve(process.cwd(), 'widget.html')
          : resolve(process.cwd(), 'index.html'),
        output: {
          manualChunks: {
            'react-vendor': ['react', 'react-dom', 'react-router-dom'],
            supabase: ['@supabase/supabase-js'],
            stripe: ['@stripe/stripe-js'],
            icons: ['lucide-react'],
          },
        },
      },
    },
  };
}

// ── Per-brand bundle (the big React widget, lazy-loaded on click) ──
function bundleConfig(brand: 'venneir' | 'denture'): UserConfig {
  return {
    plugins: [react()],
    // No public assets in the brand bundle — the modal renders inside
    // the host page, so favicons / PWA manifest / service worker are
    // not relevant. Suppresses ~100 KB of accidental copies.
    publicDir: false,
    build: {
      target: 'es2022',
      sourcemap: true,
      outDir: `dist/widgets/${brand}`,
      emptyOutDir: true,
      // Library mode: emit a single self-contained ES module that
      // the embed opener can dynamic-import. No HTML, no Vite
      // module-preload chrome — just the JS the modal needs.
      lib: {
        entry: resolve(process.cwd(), `src/widgets/${brand}/main.tsx`),
        formats: ['es'],
        fileName: () => 'main.js',
      },
      rollupOptions: {
        // Vite's default chunking still applies inside `lib` mode
        // when `output.manualChunks` is set. We split the React +
        // Supabase + Stripe vendors so a returning customer who
        // bounces between Shopify pages can pull only the widget
        // chunk from the network on the second open.
        output: {
          // Note: filenames here are RELATIVE to outDir.
          entryFileNames: 'main.js',
          chunkFileNames: 'chunks/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
          manualChunks: {
            'react-vendor': ['react', 'react-dom'],
            supabase: ['@supabase/supabase-js'],
            stripe: ['@stripe/stripe-js'],
            icons: ['lucide-react'],
          },
        },
      },
    },
  };
}

// ── Per-brand embed opener (tiny IIFE loaded on every Shopify page) ──
function embedConfig(brand: 'venneir' | 'denture'): UserConfig {
  const bundleUrl = `${BUNDLE_BASE}/widgets/${brand}/main.js`;
  const bundleConst = brand === 'venneir' ? '__VLOUNGE_BUNDLE_URL__' : '__DLOUNGE_BUNDLE_URL__';
  return {
    plugins: [],
    publicDir: false,
    define: {
      [bundleConst]: JSON.stringify(bundleUrl),
    },
    build: {
      target: 'es2022',
      sourcemap: false,
      outDir: 'dist/embed',
      emptyOutDir: false, // both brands share dist/embed/
      // IIFE format so the file works as a plain <script> include
      // on Shopify with no module loader. Single file output —
      // embedHost.ts gets inlined.
      lib: {
        entry: resolve(process.cwd(), `src/widgets/embed/${brand}.ts`),
        formats: ['iife'],
        name: brand === 'venneir' ? 'VloungeEmbed' : 'DloungeEmbed',
        fileName: () => `${brand}.js`,
      },
      // Minify aggressively — the opener is in the host page's LCP
      // critical path until we mark it `defer`-only.
      minify: 'esbuild',
    },
  };
}

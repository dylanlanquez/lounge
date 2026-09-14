#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// stamp-sw-version
//
// Rewrites VERSION in dist/sw.js to the commit being deployed.
//
// The kiosk auto-update chain (src/main.tsx registers the worker and calls
// reg.update() every 60s; the worker skipWaiting()s and claims clients, which
// fires controllerchange, which reloads the tab) only fires when the BYTES of
// sw.js change. A normal code deploy does not touch sw.js, so every reception
// tablet kept running the bundle it booted with until somebody remembered to
// hand-bump the constant. They did not remember: `ca55e74 fix(pwa): bump sw
// VERSION so the cash-count fix reaches always-on kiosks` is a commit that
// exists only because a fix had already shipped and reached nobody.
//
// A deploy identifier is not something to remember. Stamping the SHA here
// makes every deploy change the file, so every open tablet converges on the
// new bundle within a minute.
//
// Runs last in `npm run build`, after vite has copied public/ into dist, so it
// applies to Vercel's build and not only to local ones. dist/sw.js is rewritten
// and public/sw.js is left alone: the checked-in literal is a placeholder.
// ─────────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const swPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'sw.js')

// Vercel sets this on git deploys. A `vercel --prod` from a laptop does not,
// so fall back to asking git directly — same question, different messenger.
function deployId() {
  const fromVercel = process.env.VERCEL_GIT_COMMIT_SHA
  if (fromVercel) return fromVercel.slice(0, 12)
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    // No SHA from either source means the stamp would be a guess, and a
    // worker whose version is a guess silently stops reaching the kiosks.
    // Fail the build instead: a broken deploy is louder than a stale one.
    throw new Error(
      '[sw-version] no VERCEL_GIT_COMMIT_SHA and no git HEAD; cannot stamp the service worker',
    )
  }
}

const PLACEHOLDER = /^const VERSION = '[^']*';$/m

let source
try {
  source = readFileSync(swPath, 'utf8')
} catch {
  throw new Error(`[sw-version] ${swPath} not found; did the build emit public/ into dist?`)
}

if (!PLACEHOLDER.test(source)) {
  // The constant was renamed or reformatted. Stamping nothing would leave the
  // build green and every tablet stale, which is the exact failure this script
  // exists to end, so say so and stop.
  throw new Error("[sw-version] no `const VERSION = '...';` line in dist/sw.js to stamp")
}

const version = deployId()
writeFileSync(swPath, source.replace(PLACEHOLDER, `const VERSION = '${version}';`))
console.log(`[sw-version] stamped dist/sw.js as ${version}; open kiosks will self-update`)

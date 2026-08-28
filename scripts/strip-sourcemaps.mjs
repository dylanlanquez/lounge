#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// strip-sourcemaps
//
// Deletes .map files from dist after the build.
//
// vite.config.js sets `sourcemap: 'hidden'`, which is often assumed to mean the
// maps are private. It does not. 'hidden' only omits the //# sourceMappingURL
// comment from the bundle, so a browser will not fetch the map on its own. The
// files are still emitted, still deployed, and still served at entirely
// predictable URLs: read index-BZsUzrxY.js out of the HTML and ask for
// index-BZsUzrxY.js.map.
//
// Nothing consumes them yet, because tel-symbolicate is not built. Shipping the
// full readable source of an internal monitoring tool to anyone who guesses a
// filename, in exchange for no benefit at all, is not a trade worth making.
//
// WHEN SYMBOLICATION LANDS, this script changes from "delete" to "upload, then
// delete". Do not simply remove it and start serving the maps: the symbolicator
// should read them from a private bucket, not from the public origin.
//
// Runs as part of `npm run build`, so it applies to Vercel's build too rather
// than only to local ones.
// ─────────────────────────────────────────────────────────────────────────────

import { readdirSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')

let removed = 0
let bytes = 0

function walk(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    // No dist directory. Not an error: this also runs in contexts where the
    // build was skipped, and failing the build over a missing folder it did not
    // create would be worse than doing nothing.
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full)
    } else if (entry.name.endsWith('.map')) {
      bytes += statSync(full).size
      unlinkSync(full)
      removed++
    }
  }
}

walk(dist)

if (removed === 0) {
  console.log('[sourcemaps] none found in dist')
} else {
  console.log(
    `[sourcemaps] removed ${removed} .map file(s), ${(bytes / 1024 / 1024).toFixed(1)} MB, so they are not published`
  )
}

// ============================================================================
// GENERATED FILE - DO NOT EDIT
//
// Vendored from telemetry/packages/telemetry-browser by scripts/sync-telemetry.mjs.
// Edit the source in the telemetry repo and re-run `npm run sync:sdk`.
// Local edits here will be silently overwritten on the next sync.
// ============================================================================

// Type declarations for the vendored telemetry SDK.
//
// The SDK is plain JS so that the two JavaScript apps (Meridian, Checkpoint) and
// the two TypeScript apps (Threads, Lounge) can share one implementation. These
// declarations exist so `tsc -b` in Lounge and `npm run typecheck` in Threads do
// not fail on an untyped import.

import type { ComponentType, ReactNode } from 'react'

export interface TelemetryOptions {
  /** Must match a key in the collector's tel_apps table. */
  app: 'meridian' | 'checkpoint' | 'threads' | 'lounge' | (string & {})
  /** Full URL of the tel-ingest edge function. */
  ingestUrl: string
  /** The collector project's publishable key. */
  anonKey: string
  /** Git sha or deployment id, so an issue can be traced to a build. */
  release?: string
  /** Defaults to 'development' on localhost, otherwise 'production'. */
  environment?: string
  /** Maps a pathname to the router's path pattern, e.g. '/cases/:id'. */
  resolveRoute?: (pathname: string) => string
  /** Merged onto every event's context. Scrubbed before sending. */
  context?: Record<string, unknown>
  /** Reporting is off on localhost unless this is true. */
  enabledInDev?: boolean
}

export interface TelemetryEvent {
  kind: string
  level: string
  message: string
  stack: string | null
  occurred_at: string
  release?: string
  environment?: string
  url: string | null
  route: string | null
  user_ref?: string | null
  user_name?: string | null
  user_email?: string | null
  session_ref: string | null
  context: unknown
  breadcrumbs: unknown[]
}

export interface Breadcrumb {
  ago_ms?: number
  type: string
  [key: string]: unknown
}

export function initTelemetry(options: TelemetryOptions): unknown | null
export interface TelemetryUser {
  id?: string | null
  user_id?: string | null
  name?: string | null
  full_name?: string | null
  display_name?: string | null
  email?: string | null
}

/** Pass null on sign-out, so one person's identity is not attached to the next
 *  person's errors on a shared machine. */
export function setTelemetryUser(user: TelemetryUser | string | null | undefined): void
export function setTelemetryContext(extra: Record<string, unknown>): void
export function captureError(error: unknown, extra?: Record<string, unknown>): TelemetryEvent | null
export function captureMessage(
  message: string,
  level?: 'error' | 'warn' | 'info',
  extra?: Record<string, unknown>
): TelemetryEvent | null
export function trail(message: string, data?: unknown): void
export function flushTelemetry(): void
export function shutdownTelemetry(): void
export function addCrumb(crumb: Breadcrumb): void
export function snapshotCrumbs(): Breadcrumb[]

export interface ErrorBoundaryProps {
  children?: ReactNode
  /** Named in the report, so you can tell which boundary caught it. */
  name?: string
  fallback?: ReactNode | ((error: Error, reset: () => void) => ReactNode)
}

export const ErrorBoundary: ComponentType<ErrorBoundaryProps>

// Email-side renderer for the customer-facing version of the
// Estimated-appointment-length popup that lives on the VisitDetail /
// AppointmentDetail page in Lounge
// (src/components/PhaseTimeline/PhaseTimeline.tsx).
//
// The popup is the canonical visual contract: time column on the
// left (tabular-nums), a 14px-wide rail in the middle with dots +
// connector segments, content on the right (icon pill + heading +
// sub-line). Three row variants:
//
//   • Active phase  — solid accent dot, white User icon on a solid
//                     accent pill, solid accent connector beneath
//   • Passive phase — hollow accent dot, accent Hourglass icon on
//                     an accentBg-tinted pill, dashed accent
//                     connector beneath
//   • Estimated finish — trailing row, hollow accent dot, accent
//                     Flag icon on an accentBg-tinted pill, no
//                     connector after
//
// This renderer emits the same layout in table-based HTML so it
// works in Gmail / Apple Mail / Outlook. Icons are PNGs hosted in
// the lng-email-assets bucket (Gmail strips inline <svg>). Connectors
// are 2px-wide div / table cells with backgrounds — borderLeft
// rendered as a 100%-tall inner box because some clients drop
// vertical borders. Connector segments are rendered as their own
// table row so the rail stays visually continuous across the
// time-column / content-column gap.
//
// Empty array (no phases on the row, e.g. legacy bookings predating
// the materialiser) returns an empty string — caller can drop the
// placeholder on its own line in a template and it'll cleanly omit.

import { iconImg as _iconImg } from './emailIcons.ts';

interface Phase {
  phase_index: number;
  label: string;
  patient_required: boolean;
  start_at: string;
  end_at: string;
}

// Theme tokens lifted from src/theme/index.ts so the email matches
// the Lounge UI exactly. Hardcoded (not imported) because edge
// functions can't reach into src/. Keep these in sync if the theme
// shifts.
const ACCENT = '#0D9488';
const ACCENT_BG = '#E6F4F1';
const INK = '#0E1414';
const INK_MUTED = '#4A5159';
const INK_SUBTLE = '#9CA3A3';
const SURFACE = '#FFFFFF';

/** Render the email-safe Estimated-appointment-length timeline.
 *  Returns '' when there are no phases on file. */
export function composeAppointmentTimelineBlock(phases: Phase[]): string {
  if (!Array.isArray(phases) || phases.length === 0) return '';

  // Sort defensively in case the caller passes an out-of-order
  // array. The materialiser writes phase_index in ascending order
  // already, but the SELECT-side ordering can drop if the query is
  // changed later.
  const sorted = [...phases].sort((a, b) => a.phase_index - b.phase_index);
  const finishAt = sorted[sorted.length - 1]?.end_at ?? null;

  const rows: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const phase = sorted[i];
    if (!phase) continue;
    rows.push(renderPhaseRow(phase));
    // Connector segment under every phase row — flows continuously
    // down to the finish dot, mirroring PhaseTimeline. The connector
    // colour matches the SOURCE phase's tone (solid for active,
    // dashed for passive).
    rows.push(renderConnectorRow(phase.patient_required));
  }
  if (finishAt) {
    rows.push(renderFinishRow(finishAt));
  }

  return [
    `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="border-collapse:collapse;margin:0 0 16px 0;">`,
    rows.join(''),
    `</table>`,
  ].join('');
}

// ─────────────────────────────────────────────────────────────────
// Rows
// ─────────────────────────────────────────────────────────────────

function renderPhaseRow(phase: Phase): string {
  const active = phase.patient_required;
  const startStr = formatTime(phase.start_at);
  const endStr = formatTime(phase.end_at);
  const durationMin = Math.max(
    Math.round(
      (new Date(phase.end_at).getTime() - new Date(phase.start_at).getTime()) /
        60_000,
    ),
    1,
  );
  // Pill: solid accent + white icon when the patient is required;
  // accentBg + accent icon when passive. Width/height 26 to match
  // PhaseTimeline.tsx exactly.
  const pillBg = active ? ACCENT : ACCENT_BG;
  const iconColor = active ? '#FFFFFF' : ACCENT;
  const iconName = active ? 'User' : 'Hourglass';
  const icon = _iconImg(iconName, iconColor, 14, 0);
  // Customer-facing copy. The Lounge popup is staff-only ("Patient
  // required" / "Patient back by HH:MM" — the receptionist's POV);
  // in this email we're addressing the patient directly, so rewrite
  // in second-person plain English. Active = "You're with us";
  // passive = "Step away — we're ready for you again at HH:MM".
  const presence = active
    ? "You're with us"
    : `Step away, back at ${endStr}`;

  return [
    `<tr>`,
    // Time column — 64px wide, right-aligned, tabular-nums,
    // semibold. Vertical-align top so the start time sits on the
    // same baseline as the dot.
    `<td valign="top" style="width:64px;padding:1px 16px 0 0;text-align:right;font-variant-numeric:tabular-nums;font-size:13px;font-weight:600;color:${INK};letter-spacing:-0.005em;line-height:1.2;">${escapeHtml(
      startStr,
    )}</td>`,
    // Rail column — 14px wide, contains the phase dot centred.
    `<td valign="top" style="width:14px;padding:0;">`,
    renderDot(active, /* hollow */ false),
    `</td>`,
    // Content column — icon pill + heading on row 1, sub-line on row 2.
    `<td valign="top" style="padding:0 0 12px 16px;">`,
    `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;">`,
    // Row 1: pill + heading
    `<tr>`,
    `<td valign="middle" style="padding:0 8px 0 0;">`,
    `<span style="display:inline-block;width:26px;height:26px;line-height:26px;border-radius:999px;background:${pillBg};text-align:center;vertical-align:middle;">${icon}</span>`,
    `</td>`,
    `<td valign="middle" style="padding:0;">`,
    `<span style="font-size:15px;font-weight:600;color:${INK};letter-spacing:-0.005em;line-height:1.25;">${escapeHtml(
      phase.label,
    )}</span>`,
    `</td>`,
    `</tr>`,
    // Row 2: sub-line (duration · presence)
    `<tr>`,
    `<td></td>`,
    `<td style="padding:4px 0 0 0;font-size:13px;color:${INK_MUTED};line-height:1.4;">`,
    `<span style="font-weight:500;">${escapeHtml(formatMinutes(durationMin))}</span>`,
    `<span style="display:inline-block;width:3px;height:3px;border-radius:50%;background:${INK_SUBTLE};margin:0 8px;vertical-align:middle;"></span>`,
    `<span>${escapeHtml(presence)}</span>`,
    `</td>`,
    `</tr>`,
    `</table>`,
    `</td>`,
    `</tr>`,
  ].join('');
}

function renderConnectorRow(activeAbove: boolean): string {
  // Empty row whose middle cell carries a 32px-tall vertical line
  // (solid when the phase above was active, dashed when passive).
  // Time / content cells are empty so the rail reads as continuous.
  // 32px matches PhaseTimeline's minHeight:32 for the connector.
  const stroke = activeAbove
    ? `border-left:2px solid ${ACCENT};`
    : `border-left:2px dashed ${ACCENT};`;
  return [
    `<tr>`,
    `<td style="width:64px;padding:0;"></td>`,
    `<td style="width:14px;padding:0;">`,
    // Inner element holds the rule. The width:14px / 6px offset
    // centres the 2px line on the column.
    `<div style="width:14px;height:32px;text-align:center;line-height:0;">`,
    `<div style="display:inline-block;width:2px;height:32px;${stroke}opacity:0.4;"></div>`,
    `</div>`,
    `</td>`,
    `<td style="padding:0;"></td>`,
    `</tr>`,
  ].join('');
}

function renderFinishRow(finishAt: string): string {
  const finishStr = formatTime(finishAt);
  const icon = _iconImg('Flag', ACCENT, 14, 0);
  return [
    `<tr>`,
    // Time column — same shape as a phase row, tilde-prefixed
    // because the finish is an estimate (matches PhaseTimeline's
    // `~${finishStr}` rendering).
    `<td valign="top" style="width:64px;padding:1px 16px 0 0;text-align:right;font-variant-numeric:tabular-nums;font-size:13px;font-weight:600;color:${INK};letter-spacing:-0.005em;line-height:1.2;">~${escapeHtml(
      finishStr,
    )}</td>`,
    `<td valign="top" style="width:14px;padding:0;">`,
    renderDot(/* active */ false, /* hollow */ true),
    `</td>`,
    `<td valign="top" style="padding:0 0 0 16px;">`,
    `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;">`,
    `<tr>`,
    `<td valign="middle" style="padding:0 8px 0 0;">`,
    `<span style="display:inline-block;width:26px;height:26px;line-height:26px;border-radius:999px;background:${ACCENT_BG};text-align:center;vertical-align:middle;">${icon}</span>`,
    `</td>`,
    `<td valign="middle" style="padding:0;">`,
    `<span style="font-size:15px;font-weight:600;color:${INK};letter-spacing:-0.005em;line-height:1.25;">Estimated finish</span>`,
    `</td>`,
    `</tr>`,
    `<tr>`,
    `<td></td>`,
    `<td style="padding:4px 0 0 0;font-size:13px;color:${INK_MUTED};line-height:1.4;">You're free to go</td>`,
    `</tr>`,
    `</table>`,
    `</td>`,
    `</tr>`,
  ].join('');
}

// 12px-square dot centred in the 14px rail column. Solid fill for an
// active phase (the patient is on-site through this slot); hollow
// (surface fill with accent ring) for the estimated-finish marker.
// Passive phases use a hollow dot too in the Lounge UI? Actually no
// — the UI uses the same PhaseDot for both active and passive, with
// only the FILL changing (accent vs surface). Mirroring that here:
// active = solid accent, passive = surface-filled with accent ring,
// finish = surface-filled with accent ring (same as passive — UI
// distinguishes via the icon, not the dot).
function renderDot(active: boolean, hollow: boolean): string {
  const fill = active && !hollow ? ACCENT : SURFACE;
  return [
    `<div style="width:14px;padding-top:4px;text-align:center;line-height:0;">`,
    `<div style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${fill};border:2px solid ${ACCENT};box-sizing:border-box;"></div>`,
    `</div>`,
  ].join('');
}

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function formatTime(iso: string): string {
  // Match the Lounge UI's formatTime — 24-hour HH:MM. Falls back to
  // the raw ISO substring on parse failure so a malformed value
  // still surfaces something rather than rendering blank.
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso.slice(11, 16);
    return d.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    return iso.slice(11, 16);
  }
}

// Compact "n min" / "n h" / "n h m" — matches
// PhaseTimeline.tsx → formatMinutes() exactly.
function formatMinutes(min: number): string {
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (m === 0) return h === 1 ? '1 hour' : `${h} hours`;
  return `${h} h ${m} min`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Single source of truth for the printed/PDF/emailed signed-waiver
// document. Pure function: given a structured input, returns an A4
// HTML string. The print, download, and email surfaces all consume
// this — change the layout in one place and every output stays in
// lockstep.
//
// Layout ported from Checkpoint's printWalkInForm
// (~/Desktop/checkpoint-app/src/lib/walkins.js#L1213) so a clinic
// running both apps prints visually identical paperwork. Only the
// data sources differ:
//
//   • Order ref       : LAP ref (from lng_appointments / lng_walk_ins)
//                       instead of LWO ref
//   • Items           : lng_cart_items + lng_cart_item_upgrades,
//                       same denture-vs-appliance categorisation as
//                       printLwo (service_type === 'denture_repair'
//                       splits the Repair Type column out)
//   • Waiver sections : lng_waiver_signatures rows for THIS visit,
//                       each carrying its own version + frozen
//                       terms_snapshot so a printed copy never
//                       shifts when the live waiver gets re-versioned
//   • Signature       : signature_svg from the lng_waiver_signatures
//                       row. Multi-section visits use the most-recent
//                       signature for the document's signature box —
//                       per-section signatures still appear in the
//                       audit table on the patient profile

export interface WaiverDocItem {
  qty: number;
  device: string;
  repairType: string;
  arch: 'upper' | 'lower' | 'both' | null;
  shade: string | null;
  thickness: string | null;
  category: 'denture' | 'appliance';
  // Per-instance price in pence (unit_price_pence on lng_cart_items
  // already has the upgrade-rolled-in value, so this is what the
  // patient was charged). The renderer also derives the line total
  // = unitPricePence × qty.
  unitPricePence: number;
}

export interface WaiverDocSection {
  title: string;          // Section title (e.g. "Denture services")
  version: string;        // Version of the section signed
  terms: string[];        // Frozen terms_snapshot from lng_waiver_signatures
  signedAt: string;       // ISO timestamp
  witnessName: string | null;
}

export interface WaiverDocPaymentSummary {
  amountPence: number;
  method: string;         // 'card' | 'cash' | …
  takenAt: string;        // ISO
  status: 'paid' | 'failed';
}

export interface WaiverDocInput {
  lapRef: string;                     // e.g. LAP-00003
  visitType: string | null;           // human label, e.g. "In-person impression appointment"
  patient: {
    fullName: string;
    dateOfBirth: string | null;       // ISO YYYY-MM-DD
    sex: string | null;
    email: string | null;
    phone: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    postcode: string | null;
  };
  visitOpenedAt: string;              // ISO
  // Receptionist who attended the appointment. Displayed on the
  // signature card as "Witnessed by". Patients do not need a
  // generic "Staff" field on the visit summary, so it lives only
  // on the signature attribution.
  witnessName: string | null;
  items: WaiverDocItem[];
  notes: string | null;
  sections: WaiverDocSection[];
  // Full SVG document string from lng_waiver_signatures.signature_svg
  // (e.g. `<svg xmlns="..." viewBox="0 0 600 180">...<path .../></svg>`).
  // Embedded verbatim into the page so the strokes render at their
  // captured size; sized visually via the wrapping .sig-card container.
  signatureSvg: string | null;
  payment: WaiverDocPaymentSummary | null;
  // Branding threaded as input rather than hardcoded so a future
  // second site or staging deploy can override it without forking
  // the renderer. accentColor controls every colour accent in the
  // document.
  brand: {
    name: string;                     // e.g. "Venneir Lounge"
    contactEmail: string;
    vatNumber: string | null;
    logoUrl: string;                  // origin + asset path
    addressLine: string | null;       // single-line address, optional
  };
  accentColor: string;                // e.g. "#1F4D3A"
}

const MUTED_DASH = '<span style="font-weight:400;color:#999">—</span>';

// Lounge wordmark — inline SVG so the printer/PDF doesn't depend on
// an external asset fetch (which html2canvas would skip on a strict
// CORS policy). Sized at the call site; viewBox keeps the aspect
// ratio fixed at 246.8 × 72.05.
const LOUNGE_WORDMARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 246.8 72.05" aria-hidden="true">
  <path d="M14.31,0c-.42,2.96-.57,5.86-.57,10.66v37.4c0,4.23.14,6.92.57,10.66H-.44C-.02,55.54.12,53.14.12,48.06V10.66C.12,5.65-.02,2.68-.44,0h14.75Z"/>
  <path d="M14.94,37.12c0-14.11,9.03-23.08,23.29-23.08s23.29,8.96,23.29,22.94-9.32,23.36-23.36,23.36-23.22-9.03-23.22-23.22ZM28.42,37.05c0,7.83,3.67,12.56,9.81,12.56s9.67-4.59,9.67-12.42-3.6-12.56-9.6-12.56-9.88,4.66-9.88,12.42Z"/>
  <path d="M106.69,15.67c-.42,3.32-.56,6.28-.56,10.59v21.81c0,4.87.14,7.76.56,10.59h-14.04v-3.03c0-.35,0-1.41.07-1.91-4.66,4.38-8.68,6.07-14.68,6.07-4.73,0-8.54-1.34-11.22-3.95-2.82-2.82-4.02-6.28-4.02-11.86v-17.71c0-4.09-.21-7.62-.56-10.59h14.68c-.42,3.39-.56,6.35-.56,10.59v14.47c0,2.89.28,4.16,1.13,5.29.99,1.27,2.54,1.98,4.59,1.98,3.88,0,7.83-2.75,10.59-7.27v-14.47c0-3.95-.14-6.92-.56-10.59h14.61Z"/>
  <path d="M109.16,58.72c.42-3.32.56-6.28.56-10.66v-21.74c0-4.87-.14-7.83-.56-10.66h14.04v2.96c0,.42-.07,1.48-.07,1.98,4.45-4.23,8.75-6,14.54-6,4.87,0,8.75,1.34,11.36,3.95,2.82,2.82,4.02,6.28,4.02,11.86v17.71c0,4.09.21,7.62.56,10.59h-14.68c.42-3.39.56-6.35.56-10.66v-14.47c0-2.82-.28-4.02-1.13-5.22-.92-1.27-2.54-1.98-4.66-1.98-3.95,0-7.48,2.47-10.52,7.41v14.26c0,4.02.14,6.99.56,10.66h-14.61Z"/>
  <path d="M165.48,57.52c2.47,3.18,6.07,4.8,10.73,4.8,3.88,0,6.92-1.06,8.61-3.11,1.48-1.69,2.12-3.81,2.26-7.55-3.6,3.25-7.41,4.66-12.84,4.66-12.28,0-20.04-8.04-20.04-20.89s7.97-20.82,20.04-20.82c5.22,0,9.03,1.2,12.84,4.09v-3.03h13.83c-.42,3.18-.56,5.65-.56,9.81v24.77c0,8.47-2.4,14.19-7.34,17.64-3.81,2.68-9.74,4.16-16.8,4.16-9.6,0-15.95-2.4-20.89-7.83l10.16-6.7ZM176.84,46.15c5.79,0,9.95-4.45,9.95-10.73s-4.16-10.8-9.88-10.8-9.32,4.3-9.32,10.87,3.67,10.66,9.24,10.66Z"/>
  <path d="M214.6,41.14c.71,5.72,4.02,8.75,9.6,8.75,2.82,0,5.29-.92,7.13-2.61,1.06-.99,1.55-1.76,2.12-3.6l12.28,3.46c-1.62,3.67-2.68,5.29-4.66,7.27-4.02,3.95-9.67,6-16.66,6s-12.35-1.98-16.37-6c-4.16-4.23-6.42-10.23-6.42-17.22,0-13.97,8.96-23.22,22.44-23.22,11.01,0,18.7,6,21.17,16.51.56,2.26.85,5.22,1.06,9.25,0,.28,0,.71.07,1.41h-31.76ZM232.95,31.4c-.99-4.52-4.02-6.92-8.89-6.92s-8.05,2.26-9.25,6.92h18.14Z"/>
</svg>`;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function properCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

function fmtDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return (
    d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) +
    ' at ' +
    d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  );
}

function archLabel(arch: WaiverDocItem['arch']): string {
  if (arch === 'upper') return 'Upper';
  if (arch === 'lower') return 'Lower';
  if (arch === 'both') return 'Upper and lower';
  return '';
}

function formatGbp(pence: number): string {
  // Document is generated in a fresh window with no app theme — duplicate
  // the formatter inline rather than dragging in cart.ts.
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(pence / 100);
}

// Render one item row. Description is the catalogue's human label
// (repairType for denture services, device for appliances) and the
// sub-line carries arch / shade / thickness as a single muted line
// — the same rhythm a Stripe receipt uses. Returns the inner <tr>.
function renderItemRow(item: WaiverDocItem): string {
  const description = item.category === 'denture' && item.repairType
    ? item.repairType
    : item.device || '';
  const subParts: string[] = [];
  if (item.arch) subParts.push(archLabel(item.arch));
  if (item.shade) subParts.push(`Shade ${item.shade}`);
  if (item.thickness) subParts.push(item.thickness);
  const sub = subParts.length > 0
    ? `<span class="sub">${escapeHtml(subParts.join(' · '))}</span>`
    : '';
  const unit = formatGbp(item.unitPricePence);
  const lineTotal = formatGbp(item.unitPricePence * Math.max(1, item.qty));
  return `<tr>
    <td><span class="desc">${escapeHtml(description) || MUTED_DASH}</span>${sub}</td>
    <td class="qty center">${item.qty}</td>
    <td class="num">${unit}</td>
    <td class="num">${lineTotal}</td>
  </tr>`;
}

// Items section. When the visit has both denture and appliance lines
// the sub-headers (".items-subhead") split them into two sections
// inside the same table — same posture Checkpoint and the LWO use,
// adapted to the patient-facing typography.
function renderItemsTable(rows: WaiverDocItem[]): string {
  if (rows.length === 0) {
    return `<p style="font-size:11px;color:var(--muted);margin:6px 0">No billable items recorded for this visit.</p>`;
  }
  const denture = rows.filter((r) => r.category === 'denture');
  const appliance = rows.filter((r) => r.category === 'appliance');
  const both = denture.length > 0 && appliance.length > 0;
  const tableHead = `<colgroup>
    <col />
    <col style="width:60px" />
    <col style="width:100px" />
    <col style="width:110px" />
  </colgroup>
  <thead><tr>
    <th>Description</th>
    <th class="center">Qty</th>
    <th class="num">Each</th>
    <th class="num">Amount</th>
  </tr></thead>`;
  const body = both
    ? `<tbody>
        <tr><td colspan="4" class="items-subhead">Denture services</td></tr>
        ${denture.map(renderItemRow).join('')}
        <tr><td colspan="4" class="items-subhead">Appliances</td></tr>
        ${appliance.map(renderItemRow).join('')}
      </tbody>`
    : `<tbody>${rows.map(renderItemRow).join('')}</tbody>`;
  return `<table class="items">${tableHead}${body}</table>`;
}

// Two-page A4 layout, designed for the patient's pocket folder
// rather than a lab job sheet. Aesthetic targets: Linear / Stripe /
// Notion-grade typography; one quiet brand accent (Venneir's deep
// emerald) used sparingly to anchor the document; generous
// whitespace; signature treated as a feature, not metadata.
//
// Canonical width: 794px (A4 @ 96dpi). The on-screen preview frame
// renders at this width and the dialog scales it via transform to
// fit, so what's previewed matches what's printed exactly.
const A4_CSS = (accent: string): string => `
  *{box-sizing:border-box;margin:0;padding:0}
  :root{--accent:${accent};--ink:#0E1414;--muted:rgba(14,20,20,0.62);--subtle:rgba(14,20,20,0.42);--rule:rgba(14,20,20,0.08);--soft:rgba(14,20,20,0.04);--surface:#FFFFFF}
  html,body{background:var(--surface);color:var(--ink)}
  @page{size:A4;margin:0}

  /* Single content flow — no fixed-height page divs. Terms naturally
     fill whatever room is left on page 1 and continue onto page 2;
     the signature card is forced onto its own break (page-break-
     before: always below) so it always lands at the foot of page 2.
     The browser print engine handles the actual sheet boundaries. */
  body{font-family:'Inter','SF Pro Text',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:10.5px;line-height:1.55;font-feature-settings:'ss01','cv11';-webkit-font-smoothing:antialiased;width:210mm;padding:14mm 18mm 18mm}

  /* ── Letterhead ───────────────────────────────────────────────── */
  .lh{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}
  .lh-brand{display:flex;flex-direction:column;gap:4px}
  .lh-brand .mark{display:flex;align-items:center;gap:10px}
  .lh-brand .brand-img{height:22px;display:block}
  /* Lounge SVG sized to match the Venneir wordmark image. fill is
     ink rather than stroke so it carries through to thermal /
     greyscale prints cleanly. */
  .lh-brand .wordmark-svg{display:inline-flex;align-items:center}
  .lh-brand .wordmark-svg svg{height:22px;width:auto;display:block;fill:var(--ink)}
  .lh-brand .wordmark{font-size:18px;font-weight:700;letter-spacing:-.01em;color:var(--ink)}
  .lh-brand .accent-rule{width:36px;height:2px;background:var(--accent);margin-top:6px;border-radius:2px}
  .lh-brand .meta-line{font-size:9.5px;color:var(--muted);margin-top:6px;letter-spacing:.01em}
  .lh-ref{text-align:right}
  .lh-ref .label{font-size:8.5px;text-transform:uppercase;letter-spacing:.12em;color:var(--subtle);font-weight:600;margin-bottom:4px}
  .lh-ref .value{font-family:'SF Mono','Roboto Mono',Menlo,Consolas,monospace;font-size:15px;font-weight:700;letter-spacing:.06em;color:var(--accent)}
  .lh-ref .sub{font-size:9.5px;color:var(--muted);margin-top:3px}

  /* No hero block — the letterhead and the patient details below
     it carry every cue needed. Removing the "Visit summary" title
     reclaims ~80px of vertical real estate. */

  /* ── Section block ───────────────────────────────────────────── */
  /* No "PATIENT DETAILS" eyebrows on the customer document — the
     content is self-evident. Sections rely on whitespace + rules
     to separate. .sec just gives a tight margin above. */
  .sec{margin-top:14px}

  /* ── Field grids ─────────────────────────────────────────────── */
  .grid-2{display:grid;grid-template-columns:1fr 1fr;column-gap:28px;row-gap:8px}
  .grid-3{display:grid;grid-template-columns:repeat(3,1fr);column-gap:28px;row-gap:8px}
  .field .label{font-size:8px;text-transform:uppercase;letter-spacing:.06em;color:var(--subtle);font-weight:600;margin-bottom:1px}
  .field .value{font-size:11px;color:var(--ink);font-weight:500;line-height:1.35}

  /* ── Items table ─────────────────────────────────────────────── */
  /* Solid black header bar with bold white text — high-contrast,
     unambiguous, prints well on both inkjet and thermal. The
     -webkit-print-color-adjust:exact rule forces Chrome to keep
     the fill on print rather than dropping the background. */
  table.items{width:100%;border-collapse:collapse;margin-top:8px}
  table.items th{font-size:9px;text-transform:uppercase;letter-spacing:.08em;color:#fff;font-weight:700;text-align:left;padding:9px 12px;background:#0E1414;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  table.items th:first-child{border-top-left-radius:6px;border-bottom-left-radius:6px}
  table.items th:last-child{border-top-right-radius:6px;border-bottom-right-radius:6px}
  table.items th.num,table.items td.num{text-align:right;font-variant-numeric:tabular-nums}
  table.items th.center,table.items td.center{text-align:center}
  table.items td{padding:10px 12px;border-bottom:1px solid var(--rule);font-size:11px;color:var(--ink);vertical-align:top}
  table.items tr:last-child td{border-bottom:none}
  table.items .desc{font-weight:600}
  table.items .sub{display:block;font-size:9.5px;color:var(--muted);font-weight:400;margin-top:1px}
  table.items td.qty{color:var(--muted)}

  /* Items subheader inside the table for combo orders. */
  .items-subhead{font-size:9px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--accent);padding:12px 0 4px;border-bottom:1px solid var(--rule)}
  .items-subhead:first-child{padding-top:0}

  /* ── Totals strip ────────────────────────────────────────────── */
  .totals{margin-top:10px;padding-top:10px;border-top:2px solid var(--ink);display:flex;justify-content:space-between;align-items:baseline}
  .totals .label{font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink);font-weight:600}
  .totals .value{font-size:16px;font-weight:700;letter-spacing:-.01em;font-variant-numeric:tabular-nums;color:var(--ink)}

  /* ── Payment row (single line: status + amount) ──────────────── */
  .pay-row{margin-top:10px;display:flex;align-items:baseline;justify-content:space-between;gap:16px;padding:10px 12px;border:1px solid var(--rule);border-radius:10px}
  .pay-row .meta{display:flex;align-items:baseline;gap:14px;color:var(--muted);font-size:10px}
  .pay-row .meta strong{color:var(--ink);font-weight:600}
  .pay-row .amount{font-size:14px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--ink)}

  /* ── Status pill ─────────────────────────────────────────────── */
  .pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:9.5px;font-weight:600;letter-spacing:.04em}
  .pill-paid{background:var(--accent);color:#fff}
  .pill-pending{background:rgba(179,104,21,.14);color:#7A4A0F}
  .pill-failed{background:rgba(184,58,42,.12);color:#8A2918}

  /* ── Notes block ─────────────────────────────────────────────── */
  .notes{margin-top:12px;padding:10px 12px;background:var(--soft);border-radius:8px}
  .notes .label{font-size:8px;text-transform:uppercase;letter-spacing:.06em;color:var(--subtle);font-weight:600;margin-bottom:3px}
  .notes .value{font-size:10.5px;color:var(--ink);line-height:1.5;white-space:pre-wrap}

  /* ── Footer (page indicator) ─────────────────────────────────── */
  .pg-footer{margin-top:auto;padding-top:10px;border-top:1px solid var(--rule);display:flex;justify-content:space-between;align-items:baseline;font-size:8.5px;color:var(--subtle);letter-spacing:.02em}
  .pg-footer .legal{color:var(--muted)}

  /* ── Terms (single column, flows naturally across pages) ─────── */
  /* Single column (not two) so the clauses spill from the bottom
     of page 1 onto the top of page 2 in a continuous read.
     break-inside:avoid keeps each clause whole. */
  .terms-h{font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);margin:18px 0 6px}
  .terms-deck{font-size:10px;color:var(--muted);line-height:1.5;margin-bottom:8px}
  .terms-section + .terms-section{margin-top:10px}
  .terms-section h3{font-size:9px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--accent);margin:8px 0 4px}
  ol.terms{margin:0;padding-left:14px;counter-reset:term;list-style:none}
  ol.terms li{position:relative;padding-left:14px;margin-bottom:5px;font-size:9.5px;line-height:1.5;color:var(--ink);break-inside:avoid;counter-increment:term}
  ol.terms li::before{content:counter(term)".";position:absolute;left:-2px;font-weight:600;color:var(--accent);font-variant-numeric:tabular-nums}

  /* ── Signature card ──────────────────────────────────────────── */
  /* Forced onto its own break so it always lands at the foot of
     page 2 — the print engine pushes a new sheet here even if
     the terms above happen to leave room on page 1. */
  .sig-card{page-break-before:always;break-before:page;margin-top:0;padding:18px 20px;border:1px solid var(--rule);border-radius:14px;background:var(--surface);box-shadow:0 1px 0 rgba(14,20,20,0.02)}
  .sig-card .sig-eyebrow{font-size:8.5px;text-transform:uppercase;letter-spacing:.1em;color:var(--accent);font-weight:700;margin-bottom:6px}
  .sig-card .sig-name{font-size:15px;font-weight:600;letter-spacing:-.01em;color:var(--ink);margin-bottom:8px}
  .sig-card .pad{display:block;width:100%;max-width:340px;height:96px;padding:4px 6px;border-bottom:1px solid var(--rule);position:relative}
  .sig-card .pad svg{display:block;width:100%;height:100%}
  .sig-card .pad-blank{display:flex;align-items:center;justify-content:center;color:var(--subtle);font-size:10px}
  .sig-meta{display:grid;grid-template-columns:repeat(2,1fr);column-gap:28px;row-gap:6px;margin-top:12px}
  .sig-meta .label{font-size:8px;text-transform:uppercase;letter-spacing:.06em;color:var(--subtle);font-weight:600;margin-bottom:1px}
  .sig-meta .value{font-size:11px;color:var(--ink);font-weight:500}
`;

export function buildWaiverDocument(input: WaiverDocInput): string {
  if (input.sections.length === 0) {
    throw new Error(
      'buildWaiverDocument called with zero waiver sections. Caller must gate on signed-state.',
    );
  }
  const ref = escapeHtml(input.lapRef);
  const name = escapeHtml(properCase(input.patient.fullName)) || MUTED_DASH;

  const addressLine = [
    input.patient.addressLine1,
    input.patient.addressLine2,
    input.patient.city,
    input.patient.postcode,
  ]
    .filter(Boolean)
    .join(', ');

  const itemsTable = renderItemsTable(input.items);
  const subtotalPence = input.items.reduce(
    (sum, i) => sum + i.unitPricePence * Math.max(1, i.qty),
    0,
  );
  const totalsStripHtml =
    input.items.length > 0
      ? `<div class="totals">
           <span class="label">Subtotal</span>
           <span class="value">${formatGbp(subtotalPence)}</span>
         </div>`
      : '';

  // Compact single-row payment summary: status pill + meta + amount,
  // all on one line. Replaces the previous separate pill row + 3-up
  // grid which was eating ~80px of vertical space.
  const paymentRowHtml = input.payment
    ? `<div class="pay-row">
         <div style="display:flex;align-items:center;gap:10px">
           <span class="pill ${input.payment.status === 'paid' ? 'pill-paid' : 'pill-failed'}">${input.payment.status === 'paid' ? 'Paid' : 'Failed'}</span>
           <span class="meta"><strong>${escapeHtml(properCase(input.payment.method))}</strong> · ${fmtDate(input.payment.takenAt)}</span>
         </div>
         <span class="amount">${formatGbp(input.payment.amountPence)}</span>
       </div>`
    : `<div class="pay-row">
         <div style="display:flex;align-items:center;gap:10px">
           <span class="pill pill-pending">Awaiting payment</span>
           <span class="meta">Settle at the till before leaving</span>
         </div>
       </div>`;

  const notesHtml = input.notes
    ? `<div class="notes"><div class="label">Note from your clinician</div><div class="value">${escapeHtml(input.notes)}</div></div>`
    : '';

  const latest = input.sections.reduce(
    (acc, s) => (s.signedAt > acc.signedAt ? s : acc),
    input.sections[0]!,
  );
  const signatureHtml = input.signatureSvg
    ? `<div class="pad">${input.signatureSvg.replace(/<svg([^>]*)>/, '<svg$1 preserveAspectRatio="xMidYMid meet">')}</div>`
    : `<div class="pad pad-blank">Signature unavailable</div>`;

  const termsBlocks = input.sections
    .map((section) => {
      const list = section.terms.map((t) => `<li>${escapeHtml(t)}</li>`).join('');
      const sub =
        input.sections.length > 1
          ? `<h3>${escapeHtml(section.title)}</h3>`
          : '';
      return `<div class="terms-section">${sub}<ol class="terms">${list}</ol></div>`;
    })
    .join('');

  const visitDateLabel = fmtDate(input.visitOpenedAt);

  const brand = input.brand;
  const generatedAt = fmtDateTime(new Date().toISOString());
  const legalLine = brand.vatNumber
    ? `${escapeHtml(brand.name)} · VAT ${escapeHtml(brand.vatNumber)}`
    : escapeHtml(brand.name);

  const letterhead = `
    <div class="lh">
      <div class="lh-brand">
        <div class="mark">
          ${brand.logoUrl ? `<img class="brand-img" src="${escapeHtml(brand.logoUrl)}" alt="Venneir" />` : ''}
          <span class="wordmark-svg">${LOUNGE_WORDMARK_SVG}</span>
        </div>
        <div class="accent-rule"></div>
        <div class="meta-line">${escapeHtml([brand.addressLine, brand.contactEmail].filter(Boolean).join(' · '))}</div>
      </div>
      <div class="lh-ref">
        <div class="label">Visit reference</div>
        <div class="value">${ref}</div>
        <div class="sub">${visitDateLabel}</div>
      </div>
    </div>
  `;

  const docFooter = `
    <div class="pg-footer">
      <span class="legal">${legalLine}</span>
      <span>${generatedAt}</span>
    </div>
  `;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Visit summary ${ref}</title><style>${A4_CSS(input.accentColor)}</style></head><body>

    ${letterhead}

    <div class="sec">
      <div class="grid-2">
        <div class="field"><div class="label">Full name</div><div class="value">${name}</div></div>
        <div class="field"><div class="label">Date of birth</div><div class="value">${input.patient.dateOfBirth ? fmtDate(input.patient.dateOfBirth) : MUTED_DASH}</div></div>
        <div class="field"><div class="label">Email</div><div class="value">${input.patient.email ? escapeHtml(input.patient.email) : MUTED_DASH}</div></div>
        <div class="field"><div class="label">Phone</div><div class="value">${input.patient.phone ? escapeHtml(input.patient.phone) : MUTED_DASH}</div></div>
        <div class="field" style="grid-column:1/-1"><div class="label">Address</div><div class="value">${addressLine ? escapeHtml(addressLine) : MUTED_DASH}</div></div>
      </div>
    </div>

    <div class="sec">
      ${itemsTable}
      ${totalsStripHtml}
    </div>

    <div class="sec">
      ${paymentRowHtml}
    </div>

    ${notesHtml}

    <div class="terms-h">Terms you agreed to</div>
    <p class="terms-deck">By signing, ${name} confirmed they understood every clause below and accepted the work and warranty terms as described. Continued overleaf.</p>
    ${termsBlocks}

    <div class="sig-card">
      <div class="sig-eyebrow">Signature on file</div>
      <div class="sig-name">${name}</div>
      ${signatureHtml}
      <div class="sig-meta">
        <div><div class="label">Signed</div><div class="value">${fmtDateTime(latest.signedAt)}</div></div>
        <div><div class="label">Witnessed by</div><div class="value">${input.witnessName ? escapeHtml(properCase(input.witnessName)) : MUTED_DASH}</div></div>
      </div>
    </div>

    ${docFooter}

  </body></html>`;
}

// Filename used by the Download and Email actions. Keep the LAP ref
// in the name so a folder of saved waivers sorts naturally and the
// recipient can match the attachment to the visit at a glance.
export function waiverDocumentFileName(lapRef: string): string {
  return `Lounge-waiver-${lapRef}.pdf`;
}

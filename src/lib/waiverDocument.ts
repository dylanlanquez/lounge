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
  // Final total the patient was charged at the till (after any
  // deposit credited from a Calendly booking).
  amountPence: number;
  method: string;          // 'card' | 'cash' | …
  takenAt: string;         // ISO
  status: 'paid' | 'failed';
  // Deposit paid at booking, if any. Surfaces on the waiver as a
  // negative line in the totals breakdown so the patient sees:
  //   Subtotal £X
  //   Deposit (PayPal) −£Y
  //   Total paid £Z
  // Mirrors the same model VisitDetail's Totals component uses.
  depositPence: number;                          // 0 when no paid deposit
  depositProvider: 'paypal' | 'stripe' | null;
}

export interface WaiverDocInput {
  // 'visit' (default) renders the full visit summary: patient grid,
  // items table, totals, payment row, terms, signature. Used by the
  // VisitDetail "View signed waiver" flow.
  //
  // 'waiver' is the leaner patient-level signed-waiver document.
  // There is no appointment, no cart, no payment — just the patient
  // identity, the agreed terms, and the signature. The items table,
  // totals breakdown and payment row are omitted entirely (not just
  // hidden when empty — they have no semantic meaning here). The
  // right-side header shows the signed date rather than a LAP ref.
  kind?: 'visit' | 'waiver';
  // Reference value shown in the right-side header (mono accent
  // type). For visit mode this is the LAP ref (e.g. LAP-00003);
  // for waiver mode it's a short signed date (e.g. "30 APR 2026").
  // The name is kept as `lapRef` for backwards compatibility with
  // existing call sites — callers who pass a non-LAP value should
  // also pass `referenceLabel` to retitle the column.
  lapRef: string;
  // Label above the lapRef value. Defaults to "Visit reference".
  // Waiver mode uses "Signed" or similar.
  referenceLabel?: string;
  // Optional override for the downloaded PDF's filename slug. When
  // omitted the filename helper falls back to `lapRef`. Used by
  // waiver mode where lapRef may be a date string that doesn't
  // round-trip cleanly through a filename.
  documentSlug?: string;
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
  // Sale-wide cart discount, applied via the manager-approved Apply
  // Discount sheet on VisitDetail. Surfaces as a "Discount" line in
  // the totals breakdown beneath Subtotal. 0 (or omitted) means none.
  // Threaded as a top-level field rather than living on `payment` so
  // the discount shows on the waiver even before the till takes
  // payment (the waiver may be signed at arrival).
  cartDiscountPence?: number;
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
    name: string;                     // e.g. "Venneir"
    contactEmail: string;
    vatNumber: string | null;
    logoUrl: string;                  // origin + asset path
    addressLine: string | null;       // single-line address, optional
  };
  accentColor: string;                // e.g. "#1F4D3A"
}

const MUTED_DASH = '<span style="font-weight:400;color:#999">—</span>';

// (No Lounge wordmark — the document is a Venneir-branded patient
// receipt. The Venneir logo image alone carries the brand; "Lounge"
// is an internal product surface, not customer-facing terminology.)

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

// Items section. Single flat table — no "Denture services" /
// "Appliances" sub-headers. The category split is internal lab
// taxonomy and adds no value on a customer-facing receipt; the
// row's own description (e.g. "Broken tooth on denture", "Click-in
// veneers") already carries the information without forcing the
// reader to parse a sub-heading.
function renderItemsTable(rows: WaiverDocItem[]): string {
  if (rows.length === 0) {
    return `<p style="font-size:11px;color:var(--muted);margin:6px 0">No billable items recorded for this visit.</p>`;
  }
  return `<table class="items">
    <colgroup>
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
    </tr></thead>
    <tbody>${rows.map(renderItemRow).join('')}</tbody>
  </table>`;
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
  /* Real page margins (was margin:0 with body padding faking it) so
     the print engine reserves the gutter and the @bottom-* boxes
     have somewhere to render. The numbers feel like proper letter
     stationery rather than full-bleed cramping. */
  @page{size:A4;margin:18mm 18mm 16mm}

  /* @page rules only fire when the browser is in print mode. The
     preview iframe and any non-print rendering pipeline ignore them
     entirely, so body needs its own padding to give the document a
     gutter on screen. @media print strips it back to zero so the
     printer's @page margin takes over without doubling up. */
  body{font-family:'Inter','SF Pro Text',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:10.5px;line-height:1.55;font-feature-settings:'ss01','cv11';-webkit-font-smoothing:antialiased;orphans:3;widows:3;padding:18mm 18mm 16mm}
  @media print{body{padding:0}}

  /* Per-page footer: legal line on the left, "Page N of M" on the
     right. counter(page)/counter(pages) is automatic, every page
     gets the same row without us having to inject it into the
     flow. Browsers that don't support these counters degrade to
     a blank footer rather than a blank value (Chrome / Safari /
     Edge all support; Firefox supports counter(page)). */
  @page{
    @bottom-left{content:"Venneir · VAT GB406459983";font-family:'Inter','SF Pro Text',sans-serif;font-size:8.5px;color:rgba(14,20,20,0.42);letter-spacing:.02em}
    @bottom-right{content:"Page " counter(page) " of " counter(pages);font-family:'Inter','SF Pro Text',sans-serif;font-size:8.5px;color:rgba(14,20,20,0.42);letter-spacing:.02em}
  }

  /* ── Letterhead ───────────────────────────────────────────────── */
  /* Tight stack: Venneir logo → accent stripe → contact email.
     gap:0 on the brand column so the children control their own
     margins; pulls cs@venneir.com flush under the logo with
     just a 4px breath. */
  .lh{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}
  .lh-brand{display:flex;flex-direction:column}
  .lh-brand .mark{display:flex;align-items:center;gap:10px}
  .lh-brand .brand-img{height:24px;display:block}
  .lh-brand .accent-rule{width:32px;height:2px;background:var(--accent);margin-top:5px;border-radius:2px}
  .lh-brand .meta-line{font-size:9.5px;color:var(--muted);margin-top:4px;letter-spacing:.01em}
  .lh-ref{text-align:right}
  .lh-ref .label{font-size:8.5px;text-transform:uppercase;letter-spacing:.12em;color:var(--subtle);font-weight:600;margin-bottom:4px}
  .lh-ref .value{font-family:'SF Mono','Roboto Mono',Menlo,Consolas,monospace;font-size:15px;font-weight:700;letter-spacing:.06em;color:var(--accent)}
  .lh-ref .sub{font-size:9.5px;color:var(--muted);margin-top:3px}

  /* No hero block — the letterhead and the patient details below
     it carry every cue needed. Removing the "Visit summary" title
     reclaims ~80px of vertical real estate. */

  /* First section under the letterhead pulls in tight; the rest
     keep the 14px breathing room. The compact top stack is what
     the user kept asking for: the patient sees their name and
     details immediately, no acres of letterhead whitespace. */
  .sec{margin-top:14px}
  .sec.sec-first{margin-top:8px}

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

  /* ── Totals breakdown ────────────────────────────────────────── */
  /* Subtotal + (optional) Deposit + Total. The Total row gets a
     2px ink rule above it so the eye lands there last; sub-lines
     above it use the same hairline as the rest of the document.
     Aligned right via .num column so the figures stack into a
     neat tabular column. */
  .totals{margin-top:10px;display:flex;flex-direction:column;gap:6px}
  .totals .row{display:flex;justify-content:space-between;align-items:baseline;font-size:10.5px}
  .totals .row .label{color:var(--muted)}
  .totals .row .value{font-variant-numeric:tabular-nums;color:var(--ink);font-weight:500}
  .totals .row.deposit .value{color:var(--accent);font-weight:600}
  .totals .row.total{padding-top:8px;border-top:2px solid var(--ink);margin-top:2px}
  .totals .row.total .label{font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink);font-weight:600}
  .totals .row.total .value{font-size:16px;font-weight:700;letter-spacing:-.01em}

  /* ── Payment status row ──────────────────────────────────────── */
  /* Sits beneath the totals breakdown. Status pill on the left,
     "method · date" caption on the right — that's the receipt
     for the till charge specifically. */
  .pay-row{margin-top:10px;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:9px 12px;border:1px solid var(--rule);border-radius:10px}
  .pay-row .meta{display:flex;align-items:baseline;gap:10px;color:var(--muted);font-size:9.5px}
  .pay-row .meta strong{color:var(--ink);font-weight:600}

  /* ── Status pill ─────────────────────────────────────────────── */
  .pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:9.5px;font-weight:600;letter-spacing:.04em}
  .pill-paid{background:var(--accent);color:#fff}
  .pill-pending{background:rgba(179,104,21,.14);color:#7A4A0F}
  .pill-failed{background:rgba(184,58,42,.12);color:#8A2918}

  /* ── Notes block ─────────────────────────────────────────────── */
  .notes{margin-top:12px;padding:10px 12px;background:var(--soft);border-radius:8px}
  .notes .label{font-size:8px;text-transform:uppercase;letter-spacing:.06em;color:var(--subtle);font-weight:600;margin-bottom:3px}
  .notes .value{font-size:10.5px;color:var(--ink);line-height:1.5;white-space:pre-wrap}

  /* No inline .pg-footer — the @page @bottom-* margin boxes
     above own the per-page footer in native browser print, and
     waiverPdf.ts paints the same row directly into each PDF
     page using its own vector text primitives. */

  /* ── Terms (single column, flows naturally across pages) ─────── */
  /* Single column (not two) so the clauses spill from the bottom
     of page 1 onto the top of page 2 in a continuous read.
     break-inside:avoid keeps each clause whole. */
  .terms-h{font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);margin:18px 0 6px}
  .terms-deck{font-size:10px;color:var(--muted);line-height:1.5;margin-bottom:8px}
  .terms-section + .terms-section{margin-top:10px}
  .terms-section h3{font-size:9px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--accent);margin:8px 0 4px}
  ol.terms{margin:0;padding-left:14px;counter-reset:term;list-style:none}
  /* page-break-inside:avoid is the legacy spelling; break-inside:
     avoid is the modern one. Both are needed because Chrome
     respects the modern alias inconsistently inside an <ol>.
     orphans/widows on the <li> backstops a clause that's so
     long it'd otherwise need to split — the print engine prefers
     pushing the whole clause to the next page instead of cutting
     a sentence mid-line. */
  ol.terms li{position:relative;padding-left:14px;margin-bottom:6px;font-size:9.5px;line-height:1.5;color:var(--ink);break-inside:avoid;page-break-inside:avoid;orphans:3;widows:3;counter-increment:term}
  ol.terms li::before{content:counter(term)".";position:absolute;left:-2px;font-weight:600;color:var(--accent);font-variant-numeric:tabular-nums}

  /* ── Signature card ──────────────────────────────────────────── */
  /* Compact card — patient name, pad with the captured strokes,
     signed-on / witnessed-by row beneath. No "Signature on file"
     eyebrow; the pad's visual presence makes that label
     redundant. break-inside:avoid keeps the card whole so the
     pad never crosses a page boundary. */
  .sig-card{break-inside:avoid;margin-top:12px;padding:12px 14px;border:1px solid var(--rule);border-radius:10px;background:var(--surface)}
  .sig-card .sig-name{font-size:11px;font-weight:600;letter-spacing:-.01em;color:var(--ink);margin-bottom:5px}
  .sig-card .pad{display:block;width:100%;max-width:220px;height:60px;padding:2px 4px;border-bottom:1px solid var(--rule);position:relative}
  .sig-card .pad svg{display:block;width:100%;height:100%}
  .sig-card .pad-blank{display:flex;align-items:center;justify-content:center;color:var(--subtle);font-size:9px}
  .sig-meta{display:grid;grid-template-columns:repeat(2,1fr);column-gap:18px;row-gap:4px;margin-top:8px}
  .sig-meta .label{font-size:7px;text-transform:uppercase;letter-spacing:.06em;color:var(--subtle);font-weight:600;margin-bottom:1px}
  .sig-meta .value{font-size:9px;color:var(--ink);font-weight:500}
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

  const isWaiverOnly = input.kind === 'waiver';

  // Visit-mode-only blocks: items table, totals breakdown, and the
  // payment status row. None of these have meaning for a patient-
  // profile waiver document, so we don't synthesise empty placeholders
  // for them — they're omitted from the markup entirely.
  let itemsTable = '';
  let totalsHtml = '';
  let paymentStatusHtml = '';
  if (!isWaiverOnly) {
    itemsTable = renderItemsTable(input.items);
    const subtotalPence = input.items.reduce(
      (sum, i) => sum + i.unitPricePence * Math.max(1, i.qty),
      0,
    );
    const cartDiscountPence = Math.max(0, input.cartDiscountPence ?? 0);
    const depositPence = input.payment?.depositPence ?? 0;
    const depositProvider = input.payment?.depositProvider ?? null;
    const tillPence =
      input.payment?.amountPence
      ?? Math.max(0, subtotalPence - cartDiscountPence - depositPence);

    // Totals breakdown: Subtotal → Discount (if any) → Deposit (if any)
    // → Total. Mirrors the same model the visit page Totals component
    // uses so the patient receipt matches what staff sees on screen.
    const discountRow =
      cartDiscountPence > 0
        ? `<div class="row deposit">
             <span class="label">Discount</span>
             <span class="value">−${formatGbp(cartDiscountPence)}</span>
           </div>`
        : '';
    const depositRow =
      depositPence > 0
        ? `<div class="row deposit">
             <span class="label">Deposit${depositProvider ? ' (' + (depositProvider === 'stripe' ? 'Stripe' : 'PayPal') + ' via Calendly)' : ''}</span>
             <span class="value">−${formatGbp(depositPence)}</span>
           </div>`
        : '';
    const totalLabel =
      depositPence > 0
        ? 'Total paid'
        : cartDiscountPence > 0
          ? 'Total to pay'
          : 'Total';
    totalsHtml =
      input.items.length > 0
        ? `<div class="totals">
             <div class="row"><span class="label">Subtotal</span><span class="value">${formatGbp(subtotalPence)}</span></div>
             ${discountRow}
             ${depositRow}
             <div class="row total"><span class="label">${totalLabel}</span><span class="value">${formatGbp(tillPence)}</span></div>
           </div>`
        : '';

    // Status row beneath the totals: pill + method · date. When the
    // till hasn't taken payment yet, the row reads as a friendly
    // "settle at the till before leaving".
    paymentStatusHtml = input.payment
      ? `<div class="pay-row">
           <span class="pill ${input.payment.status === 'paid' ? 'pill-paid' : 'pill-failed'}">${input.payment.status === 'paid' ? 'Paid in full' : 'Payment failed'}</span>
           <span class="meta"><strong>${escapeHtml(properCase(input.payment.method))}</strong> · ${fmtDate(input.payment.takenAt)}</span>
         </div>`
      : `<div class="pay-row">
           <span class="pill pill-pending">Awaiting payment</span>
           <span class="meta">Settle the balance at the till before leaving the clinic.</span>
         </div>`;
  }

  // visit.notes is the lab-facing tech note (printed on the LWO).
  // It's not customer-facing — patients don't need to see the
  // shade-clarification jot the receptionist made for the
  // technician — so the customer waiver document deliberately
  // does not surface it.

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

  const referenceLabel = escapeHtml(input.referenceLabel ?? 'Visit reference');
  const letterhead = `
    <div class="lh">
      <div class="lh-brand">
        <div class="mark">
          ${brand.logoUrl ? `<img class="brand-img" src="${escapeHtml(brand.logoUrl)}" alt="Venneir" />` : ''}
        </div>
        <div class="accent-rule"></div>
        <div class="meta-line">${escapeHtml([brand.addressLine, brand.contactEmail].filter(Boolean).join(' · '))}</div>
      </div>
      <div class="lh-ref">
        <div class="label">${referenceLabel}</div>
        <div class="value">${ref}</div>
        <div class="sub">${visitDateLabel}</div>
      </div>
    </div>
  `;

  // No inline footer — @page @bottom-* margin boxes own the
  // per-page footer in print, and waiverPdf.ts overlays the same
  // row in the generated PDF. Removing the inline element kept
  // a stale "Page 1 of 2 · 30 April 2026" line from sitting at
  // the end of the doc on screen-only renders.

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Visit summary ${ref}</title><style>${A4_CSS(input.accentColor)}</style></head><body>

    ${letterhead}

    <div class="sec sec-first">
      <div class="grid-2">
        <div class="field"><div class="label">Full name</div><div class="value">${name}</div></div>
        <div class="field"><div class="label">Date of birth</div><div class="value">${input.patient.dateOfBirth ? fmtDate(input.patient.dateOfBirth) : MUTED_DASH}</div></div>
        <div class="field"><div class="label">Email</div><div class="value">${input.patient.email ? escapeHtml(input.patient.email) : MUTED_DASH}</div></div>
        <div class="field"><div class="label">Phone</div><div class="value">${input.patient.phone ? escapeHtml(input.patient.phone) : MUTED_DASH}</div></div>
        <div class="field" style="grid-column:1/-1"><div class="label">Address</div><div class="value">${addressLine ? escapeHtml(addressLine) : MUTED_DASH}</div></div>
      </div>
    </div>

    ${
      isWaiverOnly
        ? ''
        : `<div class="sec">
      ${itemsTable}
      ${totalsHtml}
    </div>

    <div class="sec">
      ${paymentStatusHtml}
    </div>`
    }

    <div class="terms-h">Terms you agreed to</div>
    <p class="terms-deck">By signing, ${name} confirmed they understood every clause below and accepted the work and warranty terms as described. Continued overleaf.</p>
    ${termsBlocks}

    <div class="sig-card">
      <div class="sig-name">${name}</div>
      ${signatureHtml}
      <div class="sig-meta">
        <div><div class="label">Signed</div><div class="value">${fmtDateTime(latest.signedAt)}</div></div>
        <div><div class="label">Witnessed by</div><div class="value">${input.witnessName ? escapeHtml(properCase(input.witnessName)) : MUTED_DASH}</div></div>
      </div>
    </div>

  </body></html>`;
}

// Filename used by the Download and Email actions. Defaults to the
// LAP ref so a folder of saved visit waivers sorts naturally; waiver-
// only documents can override the slug via input.documentSlug since a
// LAP ref isn't meaningful (or even available) for them.
export function waiverDocumentFileName(input: Pick<WaiverDocInput, 'lapRef' | 'documentSlug'>): string {
  const slug = input.documentSlug?.trim() || input.lapRef;
  return `Venneir-waiver-${slug}.pdf`;
}

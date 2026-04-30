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

  /* Each .page is exactly one A4 sheet. The fixed page size means
     the print engine can never paginate within a page even when
     screen rendering happens at smaller window sizes — the
     transform-scale wrapper in the preview iframe respects these
     dimensions verbatim. */
  body{font-family:'Inter','SF Pro Text',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:10.5px;line-height:1.55;font-feature-settings:'ss01','cv11';-webkit-font-smoothing:antialiased}
  .page{width:210mm;height:297mm;padding:18mm 20mm;position:relative;display:flex;flex-direction:column;page-break-after:always;break-after:page}
  .page:last-child{page-break-after:auto;break-after:auto}

  /* ── Letterhead ───────────────────────────────────────────────── */
  .lh{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}
  .lh-brand{display:flex;flex-direction:column;gap:4px}
  .lh-brand .mark{display:flex;align-items:center;gap:10px}
  .lh-brand img{height:22px;display:block}
  .lh-brand .wordmark{font-size:18px;font-weight:700;letter-spacing:-.01em;color:var(--ink)}
  .lh-brand .accent-rule{width:36px;height:2px;background:var(--accent);margin-top:6px;border-radius:2px}
  .lh-brand .meta-line{font-size:9.5px;color:var(--muted);margin-top:6px;letter-spacing:.01em}
  .lh-ref{text-align:right}
  .lh-ref .label{font-size:8.5px;text-transform:uppercase;letter-spacing:.12em;color:var(--subtle);font-weight:600;margin-bottom:4px}
  .lh-ref .value{font-family:'SF Mono','Roboto Mono',Menlo,Consolas,monospace;font-size:15px;font-weight:700;letter-spacing:.06em;color:var(--accent)}
  .lh-ref .sub{font-size:9.5px;color:var(--muted);margin-top:3px}

  /* ── Page hero ───────────────────────────────────────────────── */
  /* Sits flush against the letterhead, no decorative top rule —
     the wordmark + accent stripe above already do the separation. */
  .hero{margin:14px 0 12px}
  .hero h1{font-size:22px;font-weight:700;letter-spacing:-.02em;line-height:1.15;color:var(--ink)}
  .hero .deck{font-size:10.5px;color:var(--muted);margin-top:4px;line-height:1.5}
  .hero .deck strong{color:var(--ink);font-weight:600}

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

  /* ── Items table (Stripe-receipt feel) ───────────────────────── */
  table.items{width:100%;border-collapse:collapse;margin-top:6px}
  table.items th{font-size:8px;text-transform:uppercase;letter-spacing:.06em;color:var(--subtle);font-weight:600;text-align:left;padding:0 0 6px;border-bottom:1px solid var(--rule)}
  table.items th.num,table.items td.num{text-align:right;font-variant-numeric:tabular-nums}
  table.items th.center,table.items td.center{text-align:center}
  table.items td{padding:8px 0;border-bottom:1px solid var(--rule);font-size:11px;color:var(--ink);vertical-align:top}
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

  /* ── Page 2: Terms (two-column flow) ─────────────────────────── */
  .terms-deck{font-size:10.5px;color:var(--muted);line-height:1.5;margin:4px 0 10px}
  .terms-section{margin-top:10px}
  .terms-section + .terms-section{margin-top:14px}
  .terms-section h3{font-size:9px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--accent);margin-bottom:5px}
  /* columns:2 reflows the clauses across two columns so the full
     terms occupy the upper half of page 2 and the signature card
     has guaranteed room below. break-inside:avoid on each <li>
     keeps individual clauses unsplittable. */
  ol.terms{margin:0;padding-left:14px;counter-reset:term;list-style:none;column-count:2;column-gap:24px;column-rule:1px solid var(--rule);column-fill:balance}
  ol.terms li{position:relative;padding-left:14px;margin-bottom:6px;font-size:9.5px;line-height:1.5;color:var(--ink);break-inside:avoid;counter-increment:term}
  ol.terms li::before{content:counter(term)".";position:absolute;left:-2px;font-weight:600;color:var(--accent);font-variant-numeric:tabular-nums}

  /* ── Signature card ──────────────────────────────────────────── */
  .sig-card{margin-top:18px;padding:18px 20px;border:1px solid var(--rule);border-radius:14px;background:var(--surface);box-shadow:0 1px 0 rgba(14,20,20,0.02)}
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
  // Visit type comes in as either a Calendly label ("In-person
  // impression appointment") or a service_type slug
  // ("same_day_appliance"). Normalise underscores → spaces and
  // lowercase so the hero reads as natural English.
  const visitTypeLabel = input.visitType
    ? input.visitType.replace(/_/g, ' ').toLowerCase()
    : null;
  const heroDeck = visitTypeLabel
    ? `Prepared for <strong>${name}</strong> following the <strong>${escapeHtml(visitTypeLabel)}</strong> on <strong>${visitDateLabel}</strong>.`
    : `Prepared for <strong>${name}</strong>, ${visitDateLabel}.`;

  const brand = input.brand;
  const generatedAt = fmtDateTime(new Date().toISOString());
  const legalLine = brand.vatNumber
    ? `${escapeHtml(brand.name)} · VAT ${escapeHtml(brand.vatNumber)}`
    : escapeHtml(brand.name);

  const letterhead = (variant: 'full' | 'compact'): string => `
    <div class="lh">
      <div class="lh-brand">
        <div class="mark">
          ${brand.logoUrl ? `<img src="${escapeHtml(brand.logoUrl)}" alt="" />` : ''}
          <span class="wordmark">${escapeHtml(brand.name)}</span>
        </div>
        <div class="accent-rule"></div>
        ${variant === 'full' ? `<div class="meta-line">${escapeHtml([brand.addressLine, brand.contactEmail].filter(Boolean).join(' · '))}</div>` : ''}
      </div>
      <div class="lh-ref">
        <div class="label">Visit reference</div>
        <div class="value">${ref}</div>
        <div class="sub">${visitDateLabel}</div>
      </div>
    </div>
  `;

  const pageFooter = (page: 1 | 2): string => `
    <div class="pg-footer">
      <span class="legal">${legalLine}</span>
      <span>Page ${page} of 2 · ${generatedAt}</span>
    </div>
  `;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Visit summary ${ref}</title><style>${A4_CSS(input.accentColor)}</style></head><body>

    <section class="page">
      ${letterhead('full')}

      <div class="hero">
        <h1>Visit summary</h1>
        <p class="deck">${heroDeck}</p>
      </div>

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

      ${pageFooter(1)}
    </section>

    <section class="page">
      ${letterhead('compact')}

      <div class="hero">
        <h1>Terms and signature</h1>
        <p class="deck">${name} agreed to the following terms before treatment began. Keep this page with your records.</p>
      </div>

      <div class="sec">
        <p class="terms-deck">By signing, you confirmed you understood every clause below and accepted the work and warranty terms as described.</p>
        ${termsBlocks}
      </div>

      <div class="sig-card">
        <div class="sig-eyebrow">Signature on file</div>
        <div class="sig-name">${name}</div>
        ${signatureHtml}
        <div class="sig-meta">
          <div><div class="label">Signed</div><div class="value">${fmtDateTime(latest.signedAt)}</div></div>
          <div><div class="label">Witnessed by</div><div class="value">${input.witnessName ? escapeHtml(properCase(input.witnessName)) : MUTED_DASH}</div></div>
        </div>
      </div>

      ${pageFooter(2)}
    </section>

  </body></html>`;
}

// Filename used by the Download and Email actions. Keep the LAP ref
// in the name so a folder of saved waivers sorts naturally and the
// recipient can match the attachment to the visit at a glance.
export function waiverDocumentFileName(lapRef: string): string {
  return `Lounge-waiver-${lapRef}.pdf`;
}

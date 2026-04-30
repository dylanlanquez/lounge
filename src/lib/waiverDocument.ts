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
  lapRef: string;
  patient: {
    fullName: string;
    dateOfBirth: string | null;     // ISO YYYY-MM-DD
    sex: string | null;
    email: string | null;
    phone: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    postcode: string | null;
  };
  visitOpenedAt: string;             // ISO
  staffName: string | null;
  jobBox: string | null;             // already formatted "JB55"
  items: WaiverDocItem[];
  notes: string | null;
  sections: WaiverDocSection[];
  // Full SVG document string from lng_waiver_signatures.signature_svg
  // (e.g. `<svg xmlns="..." viewBox="0 0 600 180">...<path .../></svg>`).
  // Embedded verbatim into the page so the strokes render at their
  // captured size; sized via the wrapping .sig-pad container.
  signatureSvg: string | null;
  payment: WaiverDocPaymentSummary | null;
  logoUrl: string;                   // origin + /black-venneir-logo.png
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

function renderItemsTable(rows: WaiverDocItem[]): string {
  if (rows.length === 0) return '';
  const showRepairType = rows.some((i) => i.repairType);
  const showThickness = rows.some((i) => i.thickness);
  const showShade = rows.some((i) => i.shade);
  const th = (lbl: string, align: 'left' | 'center' = 'left'): string =>
    `<th${align === 'center' ? ' class="tc"' : ''}>${lbl}</th>`;
  const td = (val: string, classes: string[] = []): string => {
    const cls = classes.length ? ` class="${classes.join(' ')}"` : '';
    return `<td${cls}>${val}</td>`;
  };
  return `<table class="items">
    <thead><tr>
      ${th('Device')}${showRepairType ? th('Repair Type') : ''}${th('Arch', 'center')}${th('Qty', 'center')}${showThickness ? th('Thickness', 'center') : ''}${showShade ? th('Shade', 'center') : ''}
    </tr></thead>
    <tbody>${rows
      .map(
        (i) => `<tr>
      ${td(i.device ? escapeHtml(i.device) : MUTED_DASH, ['dev'])}
      ${showRepairType ? td(i.repairType ? escapeHtml(i.repairType) : MUTED_DASH, ['dev']) : ''}
      ${td(archLabel(i.arch) || MUTED_DASH, ['tc'])}
      ${td(i.qty > 0 ? String(i.qty) : MUTED_DASH, ['tc'])}
      ${showThickness ? td(i.thickness ? escapeHtml(i.thickness) : MUTED_DASH, ['tc']) : ''}
      ${showShade ? td(i.shade ? escapeHtml(i.shade) : MUTED_DASH, ['tc']) : ''}
    </tr>`,
      )
      .join('')}</tbody>
  </table>`;
}

// Two-page A4 layout. The waiver content does not compress cleanly
// onto a single sheet (full terms text + signature + the rest of the
// metadata never fit at a comfortable reading size), so page 1
// carries the operational data (customer + items + payment) and
// page 2 carries the legal block (terms + signature). This frees
// every section to breathe at a properly readable type size.
//
// Page break is forced on `.page-2` via `break-before: always` so
// the terms always start at the top of a fresh sheet, regardless of
// how short page 1 happens to be on a given visit.
const A4_CSS = `
  *{box-sizing:border-box;margin:0;padding:0}
  @page{size:A4;margin:18mm 18mm}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:11px;color:#1a1a1a;line-height:1.5;padding:0;background:#fff}

  .page{position:relative}
  .page-2{break-before:always;page-break-before:always}

  /* Page header: large logo on the left, big LAP ref on the right.
     A 1.5px rule under the row anchors the title visually. */
  .header{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:18px;padding-bottom:12px;border-bottom:1.5px solid #1a1a1a}
  .header img{height:28px;display:block}
  .header-title{font-size:14px;font-weight:700;color:#1a1a1a;letter-spacing:.01em;margin-top:6px}
  .header-sub{font-size:11px;color:#666;margin-top:2px}
  .header-right{text-align:right}
  .ref{font-family:'SF Mono',Menlo,Consolas,monospace;font-size:18px;font-weight:700;letter-spacing:.04em}
  .ref-sub{font-size:10px;color:#666;margin-top:2px}

  /* Section heading: small uppercase eyebrow with a hairline above
     for visual separation. Plays nicely on both pages. */
  h2{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;margin:16px 0 10px;color:#444;padding-top:12px;border-top:1px solid #e6e6e6;break-after:avoid}
  h2:first-of-type{border-top:none;padding-top:0;margin-top:0}

  /* Two-up grids for the customer + visit + payment metadata.
     gap:6px row / 24px column gives field labels room to read. */
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 24px;margin-bottom:8px}
  .grid-3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px 24px;margin-bottom:8px}
  .fl{font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:#999;font-weight:600;margin-bottom:2px}
  .fv{font-size:12px;font-weight:500;color:#1a1a1a}

  /* Items table at a reading-friendly type size. Every cell has
     real padding so the rows don't read as one block. */
  table.items{width:100%;border-collapse:collapse;margin:4px 0 0;border:1px solid #e6e6e6;border-radius:4px;overflow:hidden}
  table.items th{padding:7px 12px;font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:#777;font-weight:700;text-align:left;background:#fafafa;border-bottom:1px solid #e6e6e6}
  table.items th.tc{text-align:center}
  table.items td{padding:9px 12px;font-size:11px;border-bottom:1px solid #f0f0f0}
  table.items tr:last-child td{border-bottom:none}
  table.items td.tc{text-align:center}
  table.items td.dev{font-weight:600}

  .sub-h{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#1a1a1a;margin:14px 0 6px}

  /* Status pill on the payment row. */
  .status{display:inline-block;padding:2px 8px;border-radius:3px;font-size:10px;font-weight:700}
  .status-green{background:#dcfce7;color:#15803d}
  .status-orange{background:#fff7ed;color:#c2410c}
  .status-grey{background:#f3f4f6;color:#4b5563}

  /* Page 2: terms + signature. Single-column terms at 11px reads
     comfortably for the patient. Numbered list on the left margin. */
  .terms-intro{font-size:11px;color:#333;margin:6px 0 12px;line-height:1.55}
  ol.terms{margin:0;padding-left:24px;list-style-position:outside}
  ol.terms li{margin-bottom:8px;font-size:11px;line-height:1.55;color:#222;break-inside:avoid}

  .sub-section{margin-top:14px;break-before:auto}
  .sub-section h3{font-size:11px;font-weight:700;color:#1a1a1a;letter-spacing:.02em;margin:0 0 6px}

  /* Signature block. Large pad area + meta column to its right. */
  .sig-block{display:flex;align-items:flex-end;gap:32px;margin-top:24px;padding-top:18px;border-top:1px solid #e6e6e6;break-inside:avoid}
  .sig-pad{flex:0 0 auto;border:1px solid #e6e6e6;border-radius:4px;padding:10px;background:#fafafa}
  .sig-pad svg{display:block}
  .sig-pad-blank{flex:0 0 auto;width:280px;height:108px;border:1px dashed #cbd5e1;border-radius:4px;display:flex;align-items:center;justify-content:center;color:#94a3b8;font-size:10px}
  .sig-meta{flex:1;display:grid;grid-template-columns:auto 1fr;gap:6px 12px;font-size:11px;color:#1a1a1a;align-items:baseline}
  .sig-meta .label{font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:#999;font-weight:600}
  .sig-meta .value{font-weight:500}

  /* Page footer: ref + page indicator in a thin row. */
  .footer{margin-top:24px;padding-top:10px;border-top:1px solid #e6e6e6;display:flex;justify-content:space-between;font-size:9px;color:#9ca3af}
`;

export function buildWaiverDocument(input: WaiverDocInput): string {
  const ref = escapeHtml(input.lapRef);
  const name = escapeHtml(properCase(input.patient.fullName)) || MUTED_DASH;

  // Items are split by category — same posture as the LWO label so a
  // combo order shows two stacked tables. The items section also
  // surfaces tech notes in a small block under the tables.
  const denture = input.items.filter((i) => i.category === 'denture');
  const appliance = input.items.filter((i) => i.category === 'appliance');
  const hasBoth = denture.length > 0 && appliance.length > 0;
  const subHdr = (text: string): string =>
    `<div class="sub-h">${escapeHtml(text)}</div>`;
  const itemsHtml =
    input.items.length === 0
      ? `<div class="fv" style="color:#999">No items recorded.</div>`
      : (hasBoth
          ? subHdr('Denture services') + renderItemsTable(denture) + subHdr('Appliances') + renderItemsTable(appliance)
          : renderItemsTable(input.items)) +
        (input.notes
          ? `<div style="margin-top:4px"><div class="fl">Notes</div><div class="fv" style="white-space:pre-wrap">${escapeHtml(input.notes)}</div></div>`
          : '');

  // Document title pivots on which categories were signed for. Loud
  // failure if there's nothing — caller should never invoke us with
  // zero sections (View waiver button is disabled in that state).
  if (input.sections.length === 0) {
    throw new Error('buildWaiverDocument called with zero waiver sections — caller should gate on signed-state.');
  }
  const docTitle =
    hasBoth || (denture.length > 0 && appliance.length > 0)
      ? 'Denture services & appliances'
      : input.sections[0]!.title;

  // One terms block per signed section. When the visit has multiple
  // sections, each gets its own sub-heading so the reader can map
  // "these terms apply to the appliances" / "these to the denture
  // repair" without ambiguity.
  const termsBlocks = input.sections
    .map((section, idx) => {
      const sub =
        input.sections.length > 1
          ? `<div class="sub-h" style="margin:${idx > 0 ? '10' : '4'}px 0 4px">${escapeHtml(section.title)}</div>`
          : '';
      const list = section.terms.map((t) => `<li>${escapeHtml(t)}</li>`).join('');
      return sub + `<ol class="terms">${list}</ol>`;
    })
    .join('');

  // Embed the captured SVG verbatim. signature_svg is a complete
  // <svg>...</svg> document at its capture dimensions; the .sig-pad
  // container scales it visually via max-width on the inner svg.
  const signatureHtml = input.signatureSvg
    ? `<div class="sig-pad">${input.signatureSvg.replace(/<svg([^>]*)>/, '<svg$1 style="display:block;width:280px;height:auto">')}</div>`
    : `<div class="sig-pad-blank">Signature unavailable</div>`;

  // Most-recent section's signed_at + witness drive the signature
  // block. The full per-section audit lives on the patient profile.
  const latest = input.sections.reduce((acc, s) => (s.signedAt > acc.signedAt ? s : acc), input.sections[0]!);

  // Customer information grid — every cell falls back to the muted
  // dash so a missing field looks intentional rather than broken.
  const addressParts = [
    input.patient.addressLine1,
    input.patient.addressLine2,
    input.patient.city,
    input.patient.postcode,
  ].filter(Boolean) as string[];

  const paymentHtml = input.payment
    ? `<h2>Payment</h2>
       <div class="grid">
         <div><div class="fl">Amount</div><div class="fv" style="font-size:13px;font-weight:700">${formatGbp(input.payment.amountPence)}</div></div>
         <div><div class="fl">Method</div><div class="fv">${escapeHtml(properCase(input.payment.method))}</div></div>
         <div><div class="fl">Date</div><div class="fv">${fmtDateTime(input.payment.takenAt)}</div></div>
         <div><div class="fl">Status</div><div class="fv"><span class="status ${input.payment.status === 'paid' ? 'status-green' : 'status-orange'}">${input.payment.status === 'paid' ? 'Paid' : 'Failed'}</span></div></div>
       </div>`
    : `<h2>Payment</h2>
       <div><div class="fl">Status</div><div class="fv"><span class="status status-orange">Pending</span></div></div>`;

  // Page 1 footer differs from page 2 ("Page 1 of 2" vs "Page 2 of 2").
  // The footer block is rendered once per page so both sheets carry
  // the LAP ref + page indicator + generation timestamp.
  const generatedAt = fmtDateTime(new Date().toISOString());
  const footer = (page: 1 | 2): string =>
    `<div class="footer"><span>Venneir Dental Laboratory &middot; ${ref}</span><span>Page ${page} of 2 &middot; Generated ${generatedAt}</span></div>`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(docTitle)} ${ref}</title><style>${A4_CSS}</style></head><body>

    <!-- Page 1: customer details, visit context, items, payment. -->
    <section class="page page-1">
      <div class="header">
        <div>
          <img src="${input.logoUrl}" alt="Venneir" />
          <div class="header-title">${escapeHtml(docTitle)}</div>
          <div class="header-sub">Signed waiver and visit summary</div>
        </div>
        <div class="header-right">
          <div class="ref">${ref}</div>
          <div class="ref-sub">${fmtDateTime(input.visitOpenedAt)}</div>
        </div>
      </div>

      <h2>Customer</h2>
      <div class="grid">
        <div><div class="fl">Full name</div><div class="fv">${name}</div></div>
        <div><div class="fl">Date of birth</div><div class="fv">${input.patient.dateOfBirth ? fmtDate(input.patient.dateOfBirth) : MUTED_DASH}</div></div>
        <div><div class="fl">Sex</div><div class="fv">${input.patient.sex ? escapeHtml(properCase(input.patient.sex.replace(/_/g, ' '))) : MUTED_DASH}</div></div>
        <div><div class="fl">Email</div><div class="fv">${input.patient.email ? escapeHtml(input.patient.email) : MUTED_DASH}</div></div>
        <div><div class="fl">Phone</div><div class="fv">${input.patient.phone ? escapeHtml(input.patient.phone) : MUTED_DASH}</div></div>
        <div><div class="fl">Address</div><div class="fv">${addressParts.length > 0 ? escapeHtml(addressParts.join(', ')) : MUTED_DASH}</div></div>
      </div>

      <h2>Visit</h2>
      <div class="grid-3">
        <div><div class="fl">Job box</div><div class="fv">${input.jobBox ? escapeHtml(input.jobBox) : MUTED_DASH}</div></div>
        <div><div class="fl">Staff</div><div class="fv">${input.staffName ? escapeHtml(input.staffName) : MUTED_DASH}</div></div>
        <div><div class="fl">Checked in</div><div class="fv">${fmtDateTime(input.visitOpenedAt)}</div></div>
      </div>

      <h2>Items</h2>
      ${itemsHtml}

      ${paymentHtml}

      ${footer(1)}
    </section>

    <!-- Page 2: terms (single column, comfortable type) and signature. -->
    <section class="page page-2">
      <div class="header">
        <div>
          <img src="${input.logoUrl}" alt="Venneir" />
          <div class="header-title">Terms and signature</div>
          <div class="header-sub">${escapeHtml(docTitle)}</div>
        </div>
        <div class="header-right">
          <div class="ref">${ref}</div>
          <div class="ref-sub">${name}</div>
        </div>
      </div>

      <h2>Terms and conditions</h2>
      <p class="terms-intro">By signing below, I acknowledge and agree to the following:</p>
      ${termsBlocks}

      <div class="sig-block">
        <div>
          <div class="fl" style="margin-bottom:6px">Signature</div>
          ${signatureHtml}
        </div>
        <div class="sig-meta">
          <span class="label">Signed by</span><span class="value">${name}</span>
          <span class="label">Signed at</span><span class="value">${fmtDateTime(latest.signedAt)}</span>
          <span class="label">Witnessed by</span><span class="value">${latest.witnessName ? escapeHtml(properCase(latest.witnessName)) : MUTED_DASH}</span>
        </div>
      </div>

      ${footer(2)}
    </section>
  </body></html>`;
}

// Filename used by the Download and Email actions. Keep the LAP ref
// in the name so a folder of saved waivers sorts naturally and the
// recipient can match the attachment to the visit at a glance.
export function waiverDocumentFileName(lapRef: string): string {
  return `Lounge-waiver-${lapRef}.pdf`;
}

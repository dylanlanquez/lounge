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
  signatureSvgPath: string | null;   // SVG path data — not the full SVG element
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
    `<th style="padding:4px 8px;font-size:8px;text-transform:uppercase;letter-spacing:.05em;color:#999;font-weight:700;text-align:${align};border-bottom:1px solid #ccc">${lbl}</th>`;
  const td = (
    val: string,
    opts: { align?: 'left' | 'center'; weight?: string; color?: string } = {},
  ): string =>
    `<td style="padding:5px 8px;font-size:10px;text-align:${opts.align ?? 'left'};font-weight:${opts.weight ?? 'normal'};color:${opts.color ?? '#1a1a1a'};border-bottom:1px solid #eee">${val}</td>`;
  return `<table style="width:100%;max-width:500px;border-collapse:collapse;border:1px solid #ccc;margin-bottom:8px">
    <thead><tr style="background:#f5f5f5">
      ${th('Device')}${showRepairType ? th('Repair Type') : ''}${th('Arch', 'center')}${th('Qty', 'center')}${showThickness ? th('Thickness', 'center') : ''}${showShade ? th('Shade', 'center') : ''}
    </tr></thead>
    <tbody>${rows
      .map(
        (i) => `<tr>
      ${td(i.device ? escapeHtml(i.device) : MUTED_DASH, { weight: '600' })}
      ${showRepairType ? td(i.repairType ? escapeHtml(i.repairType) : MUTED_DASH, { weight: '600' }) : ''}
      ${td(archLabel(i.arch) || MUTED_DASH, { align: 'center' })}
      ${td(i.qty > 0 ? String(i.qty) : MUTED_DASH, { align: 'center', weight: '700' })}
      ${showThickness ? td(i.thickness ? escapeHtml(i.thickness) : MUTED_DASH, { align: 'center' }) : ''}
      ${showShade ? td(i.shade ? escapeHtml(i.shade) : MUTED_DASH, { align: 'center' }) : ''}
    </tr>`,
      )
      .join('')}</tbody>
  </table>`;
}

const A4_CSS = `
  *{box-sizing:border-box;margin:0;padding:0}
  @page{size:A4;margin:12mm 16mm}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:10px;color:#1a1a1a;line-height:1.4;padding:0;background:#fff}
  .header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;padding-bottom:10px;border-bottom:1.5px solid #1a1a1a}
  .ref{font-family:monospace;font-size:12px;font-weight:700}
  .ref-sub{font-size:9px;color:#666;margin-top:1px}
  h2{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;margin:10px 0 6px;color:#555;padding-top:8px;border-top:1px solid #eee;break-after:avoid}
  h2:first-of-type{border-top:none;padding-top:0;margin-top:0}
  .grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:2px 16px}
  .fl{font-size:8px;text-transform:uppercase;letter-spacing:0.05em;color:#999;font-weight:600}
  .fv{font-size:10px;font-weight:500;margin-bottom:4px}
  .terms{margin:4px 0;padding-left:14px;columns:2;column-gap:16px}
  .terms li{margin-bottom:2px;font-size:8px;line-height:1.4;color:#444;break-inside:avoid}
  .sub-h{font-size:8.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#1a1a1a;margin:10px 0 4px}
  .sig-box{border:1px solid #ddd;border-radius:4px;padding:6px;margin-top:4px;display:inline-block;background:#fafafa}
  .sig-box svg{display:block}
  .sig-meta{display:flex;flex-direction:column;gap:4px;margin-top:6px;font-size:9px;color:#666}
  .status{display:inline-block;padding:1px 6px;border-radius:3px;font-size:9px;font-weight:700}
  .status-green{background:#dcfce7;color:#16a34a}
  .status-orange{background:#fff7ed;color:#ea580c}
  .footer{margin-top:12px;padding-top:8px;border-top:1px solid #eee;font-size:8px;color:#aaa;text-align:center}
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

  const signatureHtml = input.signatureSvgPath
    ? `<div class="sig-box"><svg viewBox="0 0 400 150" width="200" height="75"><path d="${input.signatureSvgPath}" fill="none" stroke="#000" stroke-width="2"/></svg></div>`
    : `<div class="sig-box" style="width:200px;height:75px;display:inline-flex;align-items:center;justify-content:center;color:#999;font-size:9px">Signature unavailable</div>`;

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

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(docTitle)} — ${ref}</title><style>${A4_CSS}</style></head><body>
    <div class="header">
      <div>
        <img src="${input.logoUrl}" style="height:22px;display:block;margin-bottom:4px" />
        <div style="font-size:11px;color:#666;margin-top:2px">${escapeHtml(docTitle)} form</div>
      </div>
      <div style="text-align:right">
        <div class="ref">${ref}</div>
        <div class="ref-sub">${fmtDateTime(input.visitOpenedAt)}</div>
      </div>
    </div>

    <h2>Customer information</h2>
    <div class="grid">
      <div><div class="fl">Full name</div><div class="fv">${name}</div></div>
      <div><div class="fl">Date of birth</div><div class="fv">${input.patient.dateOfBirth ? fmtDate(input.patient.dateOfBirth) : MUTED_DASH}</div></div>
      <div><div class="fl">Sex</div><div class="fv">${input.patient.sex ? escapeHtml(properCase(input.patient.sex.replace(/_/g, ' '))) : MUTED_DASH}</div></div>
      <div><div class="fl">Email</div><div class="fv">${input.patient.email ? escapeHtml(input.patient.email) : MUTED_DASH}</div></div>
      <div><div class="fl">Phone</div><div class="fv">${input.patient.phone ? escapeHtml(input.patient.phone) : MUTED_DASH}</div></div>
      <div><div class="fl">Address</div><div class="fv">${addressParts.length > 0 ? escapeHtml(addressParts.join(', ')) : MUTED_DASH}</div></div>
    </div>

    <h2>Visit</h2>
    <div class="grid">
      <div><div class="fl">Reference</div><div class="fv" style="font-family:monospace;font-weight:600">${ref}</div></div>
      <div><div class="fl">Job box</div><div class="fv">${input.jobBox ? escapeHtml(input.jobBox) : MUTED_DASH}</div></div>
      <div><div class="fl">Staff</div><div class="fv">${input.staffName ? escapeHtml(input.staffName) : MUTED_DASH}</div></div>
      <div><div class="fl">Checked in</div><div class="fv">${fmtDateTime(input.visitOpenedAt)}</div></div>
    </div>

    <h2>Items</h2>
    ${itemsHtml}

    ${paymentHtml}

    <h2>Terms and conditions</h2>
    <p style="font-size:8px;color:#555;margin-bottom:4px">By signing below, I acknowledge and agree to the following:</p>
    ${termsBlocks}

    <div style="display:flex;align-items:flex-start;gap:24px;margin-top:8px">
      <div>
        <h2 style="margin-top:0">Signature</h2>
        ${signatureHtml}
      </div>
      <div style="flex:1;padding-top:18px">
        <div class="sig-meta">
          <div><span class="fl">Signed by: </span>${name}</div>
          <div><span class="fl">Signed: </span>${fmtDateTime(latest.signedAt)}</div>
          <div><span class="fl">Witnessed by: </span>${latest.witnessName ? escapeHtml(properCase(latest.witnessName)) : MUTED_DASH}</div>
        </div>
      </div>
    </div>

    <div class="footer">Venneir Dental Laboratory &middot; ${ref} &middot; Generated ${fmtDateTime(new Date().toISOString())}</div>
  </body></html>`;
}

// Filename used by the Download and Email actions. Keep the LAP ref
// in the name so a folder of saved waivers sorts naturally and the
// recipient can match the attachment to the visit at a glance.
export function waiverDocumentFileName(lapRef: string): string {
  return `Lounge-waiver-${lapRef}.pdf`;
}

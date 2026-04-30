// Lab Work Order printable.
//
// Direct port of Checkpoint's printWalkInLwo (src/lib/walkins.js#printWalkInLwo)
// — same 4.13in × 4.13in thermal label layout, same CSS, same JsBarcode bar
// at the bottom — so a clinic running both Checkpoint and Lounge prints the
// same paperwork to the same Brother label printer without having to retrain.
//
// One deliberate difference: the order reference is the LAP ref (LAP-NNNNN
// from lng_appointments / lng_walk_ins), not Checkpoint's LWO ref. Per
// Lounge's identity convention, LAP is the appointment-level reference and
// is what the lab finds the impression by once a visit is open.
//
// Inputs are pre-shaped — VisitDetail builds the items list from
// lng_cart_items + lng_cart_item_upgrades and we render. The print module
// itself doesn't touch Supabase or any other side effect: pass it data,
// it opens a window and prints.

export interface PrintableLwoItem {
  qty: number;
  device: string;          // For appliances: catalogue name. For denture
  // services: literal "Denture" (the repair-type
  // column carries the catalogue name instead).
  repairType: string;      // Empty string for appliances. The catalogue
  // name (e.g. "Broken tooth on denture") for
  // denture services.
  arch: 'upper' | 'lower' | 'both' | null;
  shade: string | null;    // E.g. "BL1" / "A1". Null when the row
  // doesn't carry a shade (most rows).
  thickness: string | null; // E.g. "1.5mm". Null when the row carries
  // no thickness upgrade.
  category: 'denture' | 'appliance';
}

export interface PrintableLwoInput {
  lapRef: string;                           // e.g. "LAP-00130"
  arrivalType: 'PRE-BOOKED' | 'WALK-IN';
  patientName: string;
  jobBox: string | null;                    // formatted "JB55" or null
  staffName: string | null;
  checkedInAt: string;                      // ISO timestamp
  notes: string | null;                     // free-text; null/empty hides the box
  items: PrintableLwoItem[];
}

const DASH = '<span style="font-weight:400;color:#999">—</span>';

function archShort(arch: 'upper' | 'lower' | 'both' | null): string {
  if (arch === 'upper') return 'U';
  if (arch === 'lower') return 'L';
  if (arch === 'both') return 'U+L';
  return '—';
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function tdL(val: string): string {
  return '<td style="text-align:left">' + val + '</td>';
}
function tdC(val: string): string {
  return '<td style="text-align:center">' + val + '</td>';
}

function buildTable(rows: PrintableLwoItem[], subtitle: string | null): string {
  if (!rows.length) return '';
  const showRepairType = rows.some((i) => i.repairType);
  const showThickness = rows.some((i) => i.thickness);
  const showShade = rows.some((i) => i.shade);
  const header =
    '<tr>' +
    '<th style="text-align:left">Device</th>' +
    (showRepairType ? '<th style="text-align:left">Repair Type</th>' : '') +
    '<th style="text-align:center;width:12%">Arch</th>' +
    '<th style="text-align:center;width:10%">Qty</th>' +
    (showThickness ? '<th style="text-align:center;width:14%">Thickness</th>' : '') +
    (showShade ? '<th style="text-align:center;width:12%">Shade</th>' : '') +
    '</tr>';
  const body = rows
    .map((item) => {
      return (
        '<tr>' +
        tdL(item.device ? escapeHtml(item.device) : DASH) +
        (showRepairType ? tdL(item.repairType ? escapeHtml(item.repairType) : DASH) : '') +
        tdC(archShort(item.arch)) +
        tdC(item.qty ? String(item.qty) : DASH) +
        (showThickness ? tdC(item.thickness ? escapeHtml(item.thickness) : DASH) : '') +
        (showShade ? tdC(item.shade ? escapeHtml(item.shade) : DASH) : '') +
        '</tr>'
      );
    })
    .join('');
  const subheader = subtitle ? '<div class="tbl-subhdr">' + escapeHtml(subtitle) + '</div>' : '';
  return '<div class="tbl-wrap">' + subheader + '<table><thead>' + header + '</thead><tbody>' + body + '</tbody></table></div>';
}

export function printLwo(input: PrintableLwoInput): void {
  const checkin = new Date(input.checkedInAt);
  const today = checkin.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
  const checkinTime = checkin.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  const dentureRows = input.items.filter((i) => i.category === 'denture');
  const applianceRows = input.items.filter((i) => i.category === 'appliance');
  const hasBoth = dentureRows.length > 0 && applianceRows.length > 0;
  const tablesHtml = hasBoth
    ? buildTable(dentureRows, 'Denture Services') + buildTable(applianceRows, 'Appliances')
    : buildTable(input.items, null);

  const escapedNotes = input.notes
    ? escapeHtml(input.notes).replace(/\n/g, '<br>')
    : '';

  // Thermal transfer printers are pure black/white only — no greys. Using #ccc
  // or similar will either dither to solid black (worse) or drop out entirely.
  // To lighten the visual weight we use 1px borders (never 2px) in pure black,
  // thinner font weights for labels, and strip all background fills.
  const css =
    '*{box-sizing:border-box;margin:0;padding:0}' +
    '@page{size:4.13in 4.13in;margin:0}' +
    // page-break-inside:avoid + max-height + overflow:hidden together
    // guarantee the label renders on exactly one sheet. The flex
    // layout below is what makes overflow rare: the barcode shrinks to
    // fit before items/notes need clipping. These two are the safety
    // net for the worst case (huge cart) where the flex squeeze still
    // hits min-height — the rest is clipped instead of paginated.
    'body{font-family:Arial,sans-serif;font-size:11px;color:#000;background:#fff;width:4.13in;height:4.13in;max-height:4.13in;padding:10px;display:flex;flex-direction:column;overflow:hidden;page-break-inside:avoid;break-inside:avoid-page;-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}' +
    '.hdr{display:flex;justify-content:space-between;align-items:center;border:1px solid #000;padding:8px 10px;margin-bottom:7px;flex-shrink:0}' +
    '.hdr-title{font-size:12px;font-weight:700;margin-top:2px}' +
    '.hdr-badge{font-size:9px;font-weight:700;border:1px solid #000;padding:1px 6px;margin-left:8px;letter-spacing:.04em}' +
    '.hdr-order{font-size:14px;font-weight:900;text-align:right}' +
    '.hdr-date{font-size:10px;font-weight:600;text-align:right;margin-top:1px}' +
    '.meta{display:flex;border:1px solid #000;flex-shrink:0}' +
    '.meta>div{flex:1;padding:4px 0 4px 6px;border-right:1px solid #000}' +
    '.meta>div:last-child{border-right:none}' +
    '.sl{font-size:6px;text-transform:uppercase;letter-spacing:.08em;margin-bottom:1px;font-weight:500}' +
    '.meta-val{font-weight:700;font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.tbl-wrap{flex-shrink:0;border:1px solid #000;margin:5px 0}' +
    'table{width:100%;border-collapse:collapse}' +
    // Column header (DEVICE / ARCH / QTY etc) — solid black bar, bold white
    // text, slightly taller row. Thermal-safe: pure black fill + bold white.
    'th{font-size:8px;text-transform:uppercase;letter-spacing:.1em;padding:5px 8px;font-weight:900;background:#000;color:#fff;-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;border-bottom:1px solid #000}' +
    'th.tc{text-align:center}th.tl{text-align:left}th:first-child{text-align:left}' +
    'td{padding:5px 6px;border-bottom:1px solid #000;font-size:9px;font-weight:700}' +
    '.td-l{text-align:left}.td-c{text-align:center}' +
    'tr:last-child td{border-bottom:none}' +
    // Category subheader ("DENTURE SERVICES" / "APPLIANCES") — only shown for
    // combo orders. Uses the same black-bar treatment as the column header.
    // The bottom border is a 2px WHITE strip rather than the usual black:
    // both rows are filled black, so a black border was invisible. White is
    // an unburnt strip on thermal stock — visible, clean, no dithering. 2px
    // (≈0.25mm at 203 DPI) is the print-safe minimum to render reliably.
    '.tbl-subhdr{font-size:8px;font-weight:900;text-transform:uppercase;letter-spacing:.1em;padding:5px 8px;background:#000;color:#fff;-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;border-bottom:2px solid #fff}' +
    '.notes-box{border:1px dashed #000;padding:3px 6px;margin-top:2px;flex-shrink:0}' +
    '.notes-lbl{font-size:6px;text-transform:uppercase;letter-spacing:.06em;font-weight:500;margin-bottom:1px}' +
    '.notes-val{font-size:8px;line-height:1.3;word-break:break-word}' +
    // Barcode bar — fills the remainder of the page so the bar always
    // spans full width AND its height shrinks-to-fit when items / notes
    // run long. flex:1 1 0 lets it grow into free space and shrink when
    // content above demands more. min-height keeps the bar scannable on
    // a packed label; max-height stops a sparse label rendering one
    // giant barcode that dwarfs the meta. The 4.13in × 4.13in @page +
    // body { height:4.13in; overflow:hidden } means anything that
    // would have spilled to page 2 instead clips the bar at min-height.
    '.bc-bar{flex:1 1 0;min-height:64px;max-height:130px;margin-top:auto;padding:6px 0 0;text-align:center;display:flex;flex-direction:column;align-items:center;overflow:hidden}' +
    // SVG stretches to fill .bc-bar both ways. preserveAspectRatio:none
    // (set in script below) keeps bar:space ratios (which is all CODE128
    // cares about) while letting the bars get wider on shorter refs and
    // shorter on tighter labels. Display:block to drop the inline-svg
    // baseline gap; min-height:0 so the flex parent can squeeze it.
    '.bc-bar svg{display:block;flex:1 1 0;width:100%;height:100%;min-height:0}' +
    '.bc-ref{flex-shrink:0;font-family:Arial,sans-serif;font-size:13px;font-weight:900;letter-spacing:0.18em;text-align:center;margin-top:2px;color:#000}';

  const logoUrl = window.location.origin + '/black-venneir-logo.png';
  const safeRef = escapeHtml(input.lapRef);
  const safePatient = escapeHtml(input.patientName || '—');
  const safeStaff = input.staffName ? escapeHtml(input.staffName) : DASH;
  const safeJob = input.jobBox ? escapeHtml(input.jobBox) : DASH;

  const html =
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Lab Work Order ' + safeRef + '</title>' +
    '<style>' + css + '</style>' +
    '<script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.5/dist/JsBarcode.all.min.js"><\/script>' +
    '</head><body>' +
    // Header
    '<div class="hdr">' +
      '<div>' +
        '<img src="' + logoUrl + '" style="height:14px;display:block;margin-bottom:3px" />' +
        '<div class="hdr-title">Lab Work Order <span class="hdr-badge">' + input.arrivalType + '</span></div>' +
      '</div>' +
      '<div>' +
        '<div class="hdr-order">' + safeRef + '</div>' +
        '<div class="hdr-date">' + today + ' at ' + checkinTime + '</div>' +
      '</div>' +
    '</div>' +
    // Meta row
    '<div class="meta">' +
      '<div><div class="sl">Patient</div><div class="meta-val">' + safePatient + '</div></div>' +
      '<div><div class="sl">Job Box</div><div class="meta-val">' + safeJob + '</div></div>' +
      '<div><div class="sl">Staff</div><div class="meta-val">' + safeStaff + '</div></div>' +
      '<div><div class="sl">Checked in</div><div class="meta-val">' + checkinTime + '</div></div>' +
    '</div>' +
    // Items — one table per category when the order is a combo, otherwise one.
    tablesHtml +
    // Notes
    (escapedNotes ? '<div class="notes-box"><div class="notes-lbl">Notes</div><div class="notes-val">' + escapedNotes + '</div></div>' : '') +
    // Barcode
    '<div class="bc-bar"><svg id="order-barcode"></svg><div id="bc-ref" class="bc-ref"></div></div>' +
    // After JsBarcode renders, strip the explicit width/height attributes
    // it sets and swap them for a viewBox + preserveAspectRatio="none".
    // That's what lets the CSS width:100% / height:100% actually stretch
    // the bars in both axes — without the swap the SVG renders at its
    // native pixel size and ignores the flex sizing. CODE128 readers
    // tolerate non-uniform stretch fine because their decode is based
    // on bar:space ratios, not absolute widths. Fall back to leaving the
    // SVG alone if the script noscripts (we still get a barcode, just
    // not a full-width one) — better than no print at all.
    '<script>window.onload=function(){if(typeof JsBarcode==="undefined")return;JsBarcode("#order-barcode","' + safeRef + '",{format:"CODE128",width:2,height:100,displayValue:false,margin:0,background:"#fff",lineColor:"#000"});var svg=document.getElementById("order-barcode");var w=svg.getAttribute("width");var h=svg.getAttribute("height");if(w&&h){svg.setAttribute("viewBox","0 0 "+w+" "+h);svg.removeAttribute("width");svg.removeAttribute("height");svg.setAttribute("preserveAspectRatio","none")}document.getElementById("bc-ref").textContent="' + safeRef + '";window.print()}<\/script>' +
    '</body></html>';

  const win = window.open('', '_blank', 'width=500,height=650');
  if (!win) {
    // Pop-up blocker. Loud rather than silent — staff need to know
    // why the print didn't happen so they can unblock and retry.
    throw new Error('Could not open print window. Allow pop-ups for lounge.venneir.com and try again.');
  }
  win.document.write(html);
  win.document.close();
}

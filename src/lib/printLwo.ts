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
//
// Multi-label split (M17): heavy carts that would clip on a single label
// are pre-split into two slips before render — labelled "Part 1 of 2" /
// "Part 2 of 2" in the header badge so the lab knows there's more in
// the print queue. Threshold lives in MAX_ROWS_PER_SLIP; when the
// effective row count (items + per-category subheader when mixed)
// exceeds it, the printer prints both pages back-to-back with a
// page-break between them. The progressive-degradation cascade still
// runs on each page as a final safety net for an unusually fat row.

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

// Maximum tech-note length that prints cleanly inside the LWO Notes
// box on a 4.13in × 4.13in label. The box renders at 8px Arial with
// word-break, which fits ~80 chars per line and ~3 lines before the
// flex layout has to start eating into the barcode area. 200 lands
// inside that envelope with safety margin on every printer we've
// tested. Both the in-place editor on VisitDetail and the arrival
// form's Notes textarea import this so the limit stays in lockstep
// with the label geometry — change the label, change this constant.
export const MAX_TECH_NOTE_LENGTH = 200;

// Maximum effective rows that fit cleanly on one 4.13" label
// alongside header / meta / barcode + the cascade fallback. An
// effective row = an item row PLUS one extra count for each category
// subheader rendered ("Denture Services" / "Appliances"). Past this
// the print module splits the cart across two slips labelled
// "Part 1 of 2" / "Part 2 of 2". 7 is empirically the threshold the
// Brother QL-820 + 4.13" stock starts clipping the barcode-ref text
// on the typical row height (a single bold 9px row including the
// 5px padding above + below).
const MAX_ROWS_PER_SLIP = 7;

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

// Heuristic row-count for one item set. Counts each item plus a +1
// for the subheader bar (one per category, only when both are
// present on the same label). Matches the visual rows the renderer
// stamps onto the .middle region.
function effectiveRowCount(items: PrintableLwoItem[]): number {
  const denture = items.some((i) => i.category === 'denture');
  const appliance = items.some((i) => i.category === 'appliance');
  const mixed = denture && appliance;
  return items.length + (mixed ? 2 : 0);
}

// Decide whether to split + how. Returns either a single-page plan
// (just the input items) or a two-page plan with each slip's items
// already partitioned. Pre-computed so the renderer below stays a
// pure data → HTML transform — no measurement-loop, no second
// window, no print-time DOM acrobatics.
//
// Strategy when over the threshold:
//   • Mixed carts (denture + appliance) split by category — page 1
//     gets all denture rows, page 2 gets all appliance rows. Maps
//     to lab workflow (different bench for each).
//   • Single-category carts split in half by index, page 1 gets
//     the first ceil(N/2) rows. Order is preserved so the lab
//     reads the same sequence as the cart.
interface SlipPlan {
  pages: PrintableLwoItem[][];
}
function planSlips(items: PrintableLwoItem[]): SlipPlan {
  if (effectiveRowCount(items) <= MAX_ROWS_PER_SLIP) {
    return { pages: [items] };
  }
  const denture = items.filter((i) => i.category === 'denture');
  const appliance = items.filter((i) => i.category === 'appliance');
  if (denture.length > 0 && appliance.length > 0) {
    return { pages: [denture, appliance] };
  }
  const half = Math.ceil(items.length / 2);
  return { pages: [items.slice(0, half), items.slice(half)] };
}

export function printLwo(input: PrintableLwoInput): void {
  const checkin = new Date(input.checkedInAt);
  const today = checkin.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
  const checkinTime = checkin.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  const plan = planSlips(input.items);
  const totalPages = plan.pages.length;

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
    // Each slip is a separate <section.page>. page-break-after on
    // every slip except the last is what asks the browser to fire
    // a fresh sheet on the thermal printer. The slip itself is the
    // body geometry — same flex shape as the single-label original,
    // moved one level in.
    'html,body{background:#fff;font-family:Arial,sans-serif;color:#000;-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}' +
    '.page{font-size:11px;width:4.13in;height:4.13in;max-height:4.13in;padding:10px;display:flex;flex-direction:column;overflow:hidden;page-break-inside:avoid;break-inside:avoid-page}' +
    '.page+.page{page-break-before:always;break-before:page}' +
    '.hdr{display:flex;justify-content:space-between;align-items:center;border:1px solid #000;padding:8px 10px;margin-bottom:7px;flex-shrink:0}' +
    '.hdr-title{font-size:12px;font-weight:700;margin-top:2px;white-space:nowrap}' +
    '.hdr-badge{font-size:9px;font-weight:700;border:1px solid #000;padding:1px 6px;margin-left:8px;letter-spacing:.04em;white-space:nowrap}' +
    // PART x OF y badge sits on its own line below the title so the
    // header column has the full label width to itself. Margin-top
    // separates it visually from the title without an extra row of
    // chrome; inline-flex caps it to the natural badge width
    // (otherwise it'd stretch to fill the column).
    '.hdr-part-row{margin-top:3px;display:flex}' +
    '.hdr-part{font-size:9px;font-weight:700;border:1px solid #000;padding:1px 6px;letter-spacing:.04em;background:#000;color:#fff;white-space:nowrap;-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}' +
    '.hdr-order{font-size:14px;font-weight:900;text-align:right}' +
    '.hdr-date{font-size:10px;font-weight:600;text-align:right;margin-top:1px}' +
    '.meta{display:flex;border:1px solid #000;flex-shrink:0}' +
    '.meta>div{flex:1;padding:4px 0 4px 6px;border-right:1px solid #000}' +
    '.meta>div:last-child{border-right:none}' +
    '.sl{font-size:6px;text-transform:uppercase;letter-spacing:.08em;margin-bottom:1px;font-weight:500}' +
    '.meta-val{font-weight:700;font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.tbl-wrap{flex-shrink:0;border:1px solid #000;margin:5px 0}' +
    'table{width:100%;border-collapse:collapse}' +
    'th{font-size:8px;text-transform:uppercase;letter-spacing:.1em;padding:5px 8px;font-weight:900;background:#000;color:#fff;-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;border-bottom:1px solid #000}' +
    'th.tc{text-align:center}th.tl{text-align:left}th:first-child{text-align:left}' +
    'td{padding:5px 6px;border-bottom:1px solid #000;font-size:9px;font-weight:700}' +
    '.td-l{text-align:left}.td-c{text-align:center}' +
    'tr:last-child td{border-bottom:none}' +
    '.tbl-subhdr{font-size:8px;font-weight:900;text-transform:uppercase;letter-spacing:.1em;padding:5px 8px;background:#000;color:#fff;-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;border-bottom:2px solid #fff}' +
    '.notes-box{border:1px dashed #000;padding:3px 6px;margin-top:2px;flex-shrink:0}' +
    '.notes-lbl{font-size:6px;text-transform:uppercase;letter-spacing:.06em;font-weight:500;margin-bottom:1px}' +
    '.notes-val{font-size:8px;line-height:1.3;word-break:break-word}' +
    '.middle{flex:1 1 0;overflow:hidden;min-height:0;display:flex;flex-direction:column}' +
    '.bc-bar{flex-shrink:0;padding:6px 0 0;display:flex;flex-direction:column;align-items:center}' +
    '.bc-bar-inner{width:85mm;flex-shrink:0;text-align:center}' +
    '.bc-bar svg{display:block;width:100%;height:auto;margin:0 auto}' +
    '.bc-ref{font-family:Arial,sans-serif;font-size:11px;font-weight:600;letter-spacing:0.05em;text-align:center;margin-top:3px;color:#000}' +
    // Cascade — applied per-page via .page.compact / .page.extra-compact
    // so a heavy page can degrade independently of a light sibling.
    '.page.compact .tbl-subhdr{display:none}' +
    '.page.extra-compact .bc-ref{display:none}';

  const logoUrl = window.location.origin + '/black-venneir-logo.png';
  const safeRef = escapeHtml(input.lapRef);
  const safePatient = escapeHtml(input.patientName || '—');
  const safeStaff = input.staffName ? escapeHtml(input.staffName) : DASH;
  const safeJob = input.jobBox ? escapeHtml(input.jobBox) : DASH;

  // Render one slip. Notes only land on the LAST slip — the lab
  // reads the whole job, and notes about the WHOLE work should
  // close out the print run, not lead it. (If a future need
  // surfaces for per-page notes we can split there too.)
  const renderPage = (
    items: PrintableLwoItem[],
    pageNumber: number,
    isLastPage: boolean,
  ): string => {
    const dentureRows = items.filter((i) => i.category === 'denture');
    const applianceRows = items.filter((i) => i.category === 'appliance');
    const hasBoth = dentureRows.length > 0 && applianceRows.length > 0;
    const tablesHtml = hasBoth
      ? buildTable(dentureRows, 'Denture Services') + buildTable(applianceRows, 'Appliances')
      : buildTable(items, null);
    // Rendered on its own row beneath the title so the badge can't
    // wrap mid-text in a narrow header column. Only included when
    // the cart spilled across multiple slips.
    const partBadgeRow =
      totalPages > 1
        ? '<div class="hdr-part-row"><span class="hdr-part">PART ' +
          pageNumber +
          ' OF ' +
          totalPages +
          '</span></div>'
        : '';
    const pageId = 'page-' + pageNumber;
    const pageNotesHtml =
      isLastPage && escapedNotes
        ? '<div class="notes-box"><div class="notes-lbl">Notes</div><div class="notes-val">' + escapedNotes + '</div></div>'
        : '';
    return (
      '<section class="page" id="' + pageId + '" data-page="' + pageNumber + '">' +
        // Header
        '<div class="hdr">' +
          '<div>' +
            '<img src="' + logoUrl + '" style="height:14px;display:block;margin-bottom:3px" />' +
            '<div class="hdr-title">Lab Work Order ' +
              '<span class="hdr-badge">' + input.arrivalType + '</span>' +
            '</div>' +
            partBadgeRow +
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
        // Middle area — items + notes (notes on last slip only).
        '<div class="middle">' +
          tablesHtml +
          pageNotesHtml +
        '</div>' +
        // Barcode block — fixed 85mm wide, never shrinks. Same on
        // every slip so a part-2 label scans the same as a part-1
        // label and lands at the same appointment in the system.
        '<div class="bc-bar">' +
          '<div class="bc-bar-inner">' +
            '<svg class="order-barcode" data-page="' + pageNumber + '"></svg>' +
            '<div class="bc-ref">' + safeRef + '</div>' +
          '</div>' +
        '</div>' +
      '</section>'
    );
  };

  const pagesHtml = plan.pages
    .map((items, idx) => renderPage(items, idx + 1, idx === plan.pages.length - 1))
    .join('');

  const html =
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Lab Work Order ' + safeRef + '</title>' +
    '<style>' + css + '</style>' +
    '<script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.5/dist/JsBarcode.all.min.js"><\/script>' +
    '</head><body>' +
    pagesHtml +
    // Cascade JS, per-page:
    //   1. Render one barcode per slip at fixed width:2 / height:70.
    //      displayValue:false keeps the LAP-ref text rendered as
    //      separate HTML on each slip so the cascade can hide it
    //      independently.
    //   2. For every .page, check whether its .middle is overflowing.
    //   3. If yes → page.compact (hides DENTURE / APPLIANCES bars).
    //   4. If still overflowing → page.extra-compact (also hides the
    //      LAP-ref text under the barcode, freeing ~16px).
    //   5. window.print() once all pages have been laid out.
    //
    // The barcode width never changes through any of this — locked
    // at 85mm via .bc-bar-inner on every slip.
    '<script>window.onload=function(){' +
      'if(typeof JsBarcode==="undefined"){throw new Error("JsBarcode failed to load — check CDN access and pop-up settings.");}' +
      'var barcodes=document.querySelectorAll(".order-barcode");' +
      'for(var i=0;i<barcodes.length;i++){' +
        'JsBarcode(barcodes[i],"' + safeRef + '",{format:"CODE128",width:2,height:70,displayValue:false,margin:0,background:"#fff",lineColor:"#000"});' +
      '}' +
      'function reflow(){return document.body.offsetHeight;}' +
      'var pages=document.querySelectorAll(".page");' +
      'reflow();' +
      'for(var j=0;j<pages.length;j++){' +
        'var p=pages[j];' +
        'var mid=p.querySelector(".middle");' +
        'function overflowing(){return mid&&mid.scrollHeight>mid.clientHeight+1;}' +
        'if(overflowing()){p.classList.add("compact");reflow();}' +
        'if(overflowing()){p.classList.add("extra-compact");reflow();}' +
      '}' +
      'window.print();' +
    '}<\/script>' +
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

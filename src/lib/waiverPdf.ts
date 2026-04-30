// Vector PDF rendering of the signed-waiver document.
//
// Earlier this module rasterised the rendered HTML body via html2canvas
// and then fed each canvas slice to jsPDF.addImage(). Two architectural
// problems with that approach surfaced in production:
//
//   1. The browser's @page rule (which owned the printable margins)
//      is silently ignored by every non-print rendering pipeline.
//      html2canvas captures whatever the body actually rendered to —
//      with body padding at 0, content sat flush against the page edge.
//
//   2. The output PDF was a series of JPEG pages. Text wasn't text;
//      patients couldn't copy a clause, screen readers couldn't read
//      a single word, and file sizes were 5-10× what a typed PDF
//      would be.
//
// This renderer draws every text run, line, rectangle, and image
// into jsPDF directly using its vector primitives. The resulting PDF
// reads like a Stripe receipt:
//
//   • text is selectable, copyable, and searchable
//   • file size is small (no rasterisation)
//   • margins are set in mm coordinates rather than relying on @page
//   • every page carries the same footer (Venneir · VAT … / Page N of M)
//
// Source of truth for the data is still WaiverDocInput. The HTML
// renderer in waiverDocument.ts continues to drive the on-screen
// preview iframe and the direct browser print path — both of those
// honour @page natively. This module is the second output pipeline:
// same input, vector PDF output, used by the Download and Email
// flows.

import type { WaiverDocInput, WaiverDocItem, WaiverDocSection } from './waiverDocument.ts';

// jsPDF is heavy (~390kB). Keep the dynamic import so it only loads
// when the receptionist actually clicks Download or Email.
type JsPdfTextOptions = {
  align?: 'left' | 'center' | 'right';
  baseline?: 'alphabetic' | 'top' | 'middle' | 'bottom';
};
type JsPdf = {
  setFont: (name: string, style?: 'normal' | 'bold' | 'italic' | 'bolditalic') => void;
  setFontSize: (n: number) => void;
  setTextColor: (r: number, g: number, b: number) => void;
  setDrawColor: (r: number, g: number, b: number) => void;
  setFillColor: (r: number, g: number, b: number) => void;
  setLineWidth: (w: number) => void;
  text: (text: string | string[], x: number, y: number, options?: JsPdfTextOptions) => void;
  line: (x1: number, y1: number, x2: number, y2: number) => void;
  rect: (x: number, y: number, w: number, h: number, style?: 'F' | 'S' | 'FD') => void;
  roundedRect: (x: number, y: number, w: number, h: number, rx: number, ry: number, style?: 'F' | 'S' | 'FD') => void;
  addImage: (
    data: string,
    type: string,
    x: number,
    y: number,
    w: number,
    h: number,
    alias?: unknown,
    compression?: 'NONE' | 'FAST' | 'MEDIUM' | 'SLOW',
  ) => unknown;
  addPage: (format?: string, orientation?: string) => unknown;
  setPage: (n: number) => void;
  getNumberOfPages: () => number;
  splitTextToSize: (text: string, maxWidth: number) => string[];
  getTextWidth: (text: string) => number;
  output: (kind: 'blob') => Blob;
  internal: { pageSize: { getWidth: () => number; getHeight: () => number } };
};
type JsPdfCtor = new (options?: { unit?: string; format?: string; orientation?: string }) => JsPdf;

let jsPdfPromise: Promise<JsPdfCtor> | null = null;
function loadJsPdf(): Promise<JsPdfCtor> {
  if (!jsPdfPromise) {
    jsPdfPromise = import('jspdf').then((m) => (m.jsPDF ?? m.default) as unknown as JsPdfCtor);
  }
  return jsPdfPromise;
}

// ─────────────────────────────────────────────────────────────────────
// Geometry & typography tokens
// ─────────────────────────────────────────────────────────────────────
//
// All units are millimetres. jsPDF accepts pt for font sizes regardless
// of the document unit, so font sizes below stay in pt and coordinates
// stay in mm. The numbers mirror waiverDocument.ts's @page margins so a
// receipt printed natively (HTML + browser) and a downloaded PDF have
// matching gutters.

const PAGE_W = 210;
const PAGE_H = 297;
const MARGIN_T = 18;
const MARGIN_R = 18;
const MARGIN_B = 16;
const MARGIN_L = 18;
const CONTENT_W = PAGE_W - MARGIN_L - MARGIN_R;
const CONTENT_BOTTOM = PAGE_H - MARGIN_B; // y where content must end before page break

// Per-page footer baseline (mm from top). Sits inside the bottom margin.
const FOOTER_Y = PAGE_H - 8;

// Approximate Inter typography mapped to Helvetica. We swallow a small
// metric delta in exchange for not embedding ~600kB of font data in the
// bundle. Helvetica is jsPDF's default and reads cleanly at print sizes.

// Colour tokens. Each tuple is [r,g,b] in 0-255.
const INK: RGB = [14, 20, 20];
const MUTED: RGB = [89, 95, 95]; // ≈ rgba(14,20,20,0.62) over white
const SUBTLE: RGB = [122, 127, 127]; // ≈ rgba(14,20,20,0.42) over white
const RULE: RGB = [228, 230, 230]; // ≈ rgba(14,20,20,0.08)
const WHITE: RGB = [255, 255, 255];

type RGB = [number, number, number];

function parseHexColor(hex: string): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`waiverPdf: brand accentColor must be a 6-digit hex string, got "${hex}".`);
  const v = parseInt(m[1]!, 16);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

// ─────────────────────────────────────────────────────────────────────
// Helpers shared with waiverDocument.ts. We deliberately duplicate the
// formatters rather than importing them — waiverDocument.ts is in
// charge of HTML output, this module is in charge of PDF output, and
// keeping their pure helpers parallel makes either side cheaper to
// modify in isolation.
// ─────────────────────────────────────────────────────────────────────

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
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(pence / 100);
}

// ─────────────────────────────────────────────────────────────────────
// Image loading
// ─────────────────────────────────────────────────────────────────────

// Fetch an image URL and return a base64 data URL plus its natural
// dimensions. We need the dimensions so we can preserve aspect ratio
// when placing the logo — the logo file's height/width ratio is the
// source of truth, not a hardcoded number.
async function fetchImage(
  url: string,
): Promise<{ dataUrl: string; width: number; height: number; format: 'PNG' | 'JPEG' }> {
  const response = await fetch(url, { credentials: 'omit' });
  if (!response.ok) {
    throw new Error(`waiverPdf: failed to load brand logo at ${url} (HTTP ${response.status}).`);
  }
  const blob = await response.blob();
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed reading logo.'));
    reader.readAsDataURL(blob);
  });
  // Decode to read natural dimensions. We use HTMLImageElement rather
  // than ImageBitmap so the same code path works on Safari without a
  // polyfill.
  const dims = await new Promise<{ width: number; height: number }>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('waiverPdf: brand logo failed to decode.'));
    img.src = dataUrl;
  });
  const format: 'PNG' | 'JPEG' = blob.type === 'image/jpeg' ? 'JPEG' : 'PNG';
  return { dataUrl, width: dims.width, height: dims.height, format };
}

// Render an SVG document string into a PNG data URL via a canvas. The
// captured signature is a vector path, but jsPDF's SVG support is
// experimental — rasterising at 3× the placement size keeps the
// strokes crisp on the printed page without dragging in a vector-svg
// PDF plugin. The signature is the only image we rasterise; everything
// else in this PDF is real vector text and shapes.
async function svgToPngDataUrl(svg: string, widthMm: number, heightMm: number): Promise<string> {
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('waiverPdf: signature SVG failed to decode.'));
      i.src = url;
    });
    // 3× up-sample so the printed strokes don't soften. mm → px at
    // 96 DPI = mm * 3.78. ×3 oversample keeps edges sharp at A4
    // print resolution (~300 DPI).
    const pxPerMm = 3.78 * 3;
    const w = Math.round(widthMm * pxPerMm);
    const h = Math.round(heightMm * pxPerMm);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('waiverPdf: could not acquire 2D context for signature rasterisation.');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Cursor — tracks the y position and current page through the render
// flow. Every render function takes the cursor, advances it past the
// content it drew, and asks for a new page when needed.
// ─────────────────────────────────────────────────────────────────────

interface Cursor {
  pdf: JsPdf;
  y: number;
  accent: RGB;
}

function ensureSpace(c: Cursor, neededHeight: number): void {
  if (c.y + neededHeight > CONTENT_BOTTOM) {
    c.pdf.addPage();
    c.y = MARGIN_T;
  }
}

function setText(pdf: JsPdf, size: number, color: RGB, style: 'normal' | 'bold' = 'normal'): void {
  pdf.setFont('helvetica', style);
  pdf.setFontSize(size);
  pdf.setTextColor(color[0], color[1], color[2]);
}

// ─────────────────────────────────────────────────────────────────────
// Section renderers
// ─────────────────────────────────────────────────────────────────────

interface LetterheadAssets {
  dataUrl: string;
  imgW: number; // natural px
  imgH: number; // natural px
  format: 'PNG' | 'JPEG';
}

function renderLetterhead(c: Cursor, input: WaiverDocInput, assets: LetterheadAssets): void {
  const { pdf } = c;
  const startY = c.y;

  // Logo: scale to a fixed printed height (8mm) and let the natural
  // aspect ratio dictate width. 8mm ≈ 24px at 96 DPI, matching the
  // HTML version's 24px brand-img height.
  const logoH = 8;
  const logoW = (assets.imgW / assets.imgH) * logoH;
  pdf.addImage(assets.dataUrl, assets.format, MARGIN_L, startY, logoW, logoH, undefined, 'FAST');

  // Accent stripe under the logo — a tight 8mm × 0.6mm bar in the
  // brand colour. 1.2mm gap so it kisses the wordmark without
  // touching it.
  pdf.setFillColor(c.accent[0], c.accent[1], c.accent[2]);
  pdf.rect(MARGIN_L, startY + logoH + 1.2, 8, 0.6, 'F');

  // Brand contact line (e.g. cs@venneir.com). Sits 4.5mm under the
  // accent stripe at 8.5pt muted — the same "meta-line" the HTML
  // letterhead runs.
  setText(pdf, 8.5, MUTED, 'normal');
  pdf.text(input.brand.contactEmail, MARGIN_L, startY + logoH + 5.5);

  // Right side: visit reference label, value, date.
  const rightX = PAGE_W - MARGIN_R;
  setText(pdf, 7.5, SUBTLE, 'bold');
  pdf.text('VISIT REFERENCE', rightX, startY + 1.5, { align: 'right' });
  setText(pdf, 13, c.accent, 'bold');
  pdf.text(input.lapRef, rightX, startY + 6.2, { align: 'right' });
  setText(pdf, 9, MUTED, 'normal');
  pdf.text(fmtDate(input.visitOpenedAt), rightX, startY + 10.5, { align: 'right' });

  c.y = startY + Math.max(logoH + 8, 12);
}

function renderPatientGrid(c: Cursor, input: WaiverDocInput): void {
  const { pdf } = c;
  // 6mm gap before the grid so it doesn't crowd the contact email.
  c.y += 6;

  const colGap = 8;
  const colW = (CONTENT_W - colGap) / 2;

  const drawField = (label: string, value: string, x: number, y: number, width: number) => {
    setText(pdf, 6.5, SUBTLE, 'bold');
    pdf.text(label.toUpperCase(), x, y);
    setText(pdf, 10, INK, 'normal');
    // Wrap long values (e.g. an address that spans multiple lines) so
    // they never overflow the column. splitTextToSize wraps on the
    // current font / size, so it has to come AFTER setText.
    const wrapped = pdf.splitTextToSize(value || '—', width);
    pdf.text(wrapped, x, y + 3.4);
    return wrapped.length;
  };

  const rowHeight = 9.5;

  // Row 1: Full name | Date of birth
  drawField('Full name', properCase(input.patient.fullName) || '—', MARGIN_L, c.y, colW);
  drawField(
    'Date of birth',
    input.patient.dateOfBirth ? fmtDate(input.patient.dateOfBirth) : '—',
    MARGIN_L + colW + colGap,
    c.y,
    colW,
  );
  c.y += rowHeight;

  // Row 2: Email | Phone
  drawField('Email', input.patient.email ?? '—', MARGIN_L, c.y, colW);
  drawField('Phone', input.patient.phone ?? '—', MARGIN_L + colW + colGap, c.y, colW);
  c.y += rowHeight;

  // Row 3: Address (full width). Multi-line wrap permitted; row grows
  // by ~3.4mm per extra line so the grid behaves whether the patient
  // gave a one-line or three-line address.
  const addressLine = [
    input.patient.addressLine1,
    input.patient.addressLine2,
    input.patient.city,
    input.patient.postcode,
  ]
    .filter(Boolean)
    .join(', ');
  const lines = drawField('Address', addressLine || '—', MARGIN_L, c.y, CONTENT_W);
  c.y += 6 + 3.4 * Math.max(1, lines);
}

function renderItemsTable(c: Cursor, input: WaiverDocInput): void {
  const { pdf } = c;
  c.y += 6;

  // Column geometry. Description fills the slack; right three columns
  // are fixed widths that stack into a numeric strip on the right.
  const xL = MARGIN_L;
  const xR = PAGE_W - MARGIN_R;
  const COL_AMOUNT_R = xR; // right edge of Amount
  const COL_EACH_R = xR - 26; // right edge of Each
  const COL_QTY_C = xR - 26 - 17; // centre of Qty
  const COL_QTY_L = xR - 26 - 26; // left edge of Qty (≈ end of description)

  // Header bar — solid black, 8mm tall, white type.
  const headerH = 8;
  ensureSpace(c, headerH + 4);
  pdf.setFillColor(INK[0], INK[1], INK[2]);
  pdf.rect(xL, c.y, CONTENT_W, headerH, 'F');
  setText(pdf, 7.5, WHITE, 'bold');
  pdf.text('DESCRIPTION', xL + 4, c.y + 5.2);
  pdf.text('QTY', COL_QTY_C, c.y + 5.2, { align: 'center' });
  pdf.text('EACH', COL_EACH_R, c.y + 5.2, { align: 'right' });
  pdf.text('AMOUNT', COL_AMOUNT_R - 1, c.y + 5.2, { align: 'right' });
  c.y += headerH;

  // Rows
  if (input.items.length === 0) {
    setText(pdf, 9, MUTED, 'normal');
    pdf.text('No billable items recorded for this visit.', xL + 4, c.y + 4);
    c.y += 8;
    return;
  }

  for (const item of input.items) {
    const description =
      item.category === 'denture' && item.repairType ? item.repairType : item.device;
    const subParts: string[] = [];
    if (item.arch) subParts.push(archLabel(item.arch));
    if (item.shade) subParts.push(`Shade ${item.shade}`);
    if (item.thickness) subParts.push(item.thickness);
    const sub = subParts.join(' · ');
    const qty = Math.max(1, item.qty);
    const lineTotal = item.unitPricePence * qty;

    // Wrap the description in case the catalogue label is unusually
    // long; sub-line wraps too.
    setText(pdf, 9.5, INK, 'bold');
    const descLines = pdf.splitTextToSize(description || '—', COL_QTY_L - xL - 8);
    setText(pdf, 8.5, MUTED, 'normal');
    const subLines = sub ? pdf.splitTextToSize(sub, COL_QTY_L - xL - 8) : [];

    const rowH = Math.max(8, 4 + descLines.length * 3.6 + subLines.length * 3.4 + 3);
    ensureSpace(c, rowH + 4);

    setText(pdf, 9.5, INK, 'bold');
    pdf.text(descLines, xL + 4, c.y + 4.2);

    if (subLines.length > 0) {
      setText(pdf, 8.5, MUTED, 'normal');
      pdf.text(subLines, xL + 4, c.y + 4.2 + descLines.length * 3.6 + 0.6);
    }

    // Numeric columns aligned to the same baseline as the first line
    // of the description so the eye lands on a single horizontal row.
    setText(pdf, 9.5, MUTED, 'normal');
    pdf.text(String(qty), COL_QTY_C, c.y + 4.2, { align: 'center' });
    setText(pdf, 9.5, INK, 'normal');
    pdf.text(formatGbp(item.unitPricePence), COL_EACH_R, c.y + 4.2, { align: 'right' });
    pdf.text(formatGbp(lineTotal), COL_AMOUNT_R - 1, c.y + 4.2, { align: 'right' });

    // Hairline divider (matches HTML's --rule colour).
    pdf.setDrawColor(RULE[0], RULE[1], RULE[2]);
    pdf.setLineWidth(0.1);
    pdf.line(xL, c.y + rowH, xR, c.y + rowH);
    c.y += rowH;
  }
}

function renderTotals(c: Cursor, input: WaiverDocInput): void {
  if (input.items.length === 0) return;
  const { pdf } = c;
  const xL = MARGIN_L;
  const xR = PAGE_W - MARGIN_R;
  c.y += 4;

  const subtotalPence = input.items.reduce(
    (sum, i) => sum + i.unitPricePence * Math.max(1, i.qty),
    0,
  );
  const depositPence = input.payment?.depositPence ?? 0;
  const depositProvider = input.payment?.depositProvider ?? null;
  const tillPence = input.payment?.amountPence ?? Math.max(0, subtotalPence - depositPence);
  const totalLabel = depositPence > 0 ? 'Total paid' : 'Total';

  // Subtotal row
  ensureSpace(c, 14);
  setText(pdf, 9.5, MUTED, 'normal');
  pdf.text('Subtotal', xL, c.y);
  setText(pdf, 9.5, INK, 'normal');
  pdf.text(formatGbp(subtotalPence), xR, c.y, { align: 'right' });
  c.y += 5;

  // Optional deposit row
  if (depositPence > 0) {
    setText(pdf, 9.5, MUTED, 'normal');
    const depositLabel = depositProvider
      ? `Deposit (${depositProvider === 'stripe' ? 'Stripe' : 'PayPal'} via Calendly)`
      : 'Deposit';
    pdf.text(depositLabel, xL, c.y);
    setText(pdf, 9.5, c.accent, 'bold');
    pdf.text(`−${formatGbp(depositPence)}`, xR, c.y, { align: 'right' });
    c.y += 5;
  }

  // 2px ink rule above the total — matches the HTML version's
  // border-top:2px solid --ink.
  pdf.setDrawColor(INK[0], INK[1], INK[2]);
  pdf.setLineWidth(0.5);
  pdf.line(xL, c.y, xR, c.y);
  c.y += 5;

  setText(pdf, 8, INK, 'bold');
  pdf.text(totalLabel.toUpperCase(), xL, c.y);
  setText(pdf, 14, INK, 'bold');
  pdf.text(formatGbp(tillPence), xR, c.y + 0.4, { align: 'right' });
  c.y += 5;
}

function renderPaymentRow(c: Cursor, input: WaiverDocInput): void {
  const { pdf } = c;
  c.y += 6;
  ensureSpace(c, 12);

  const xL = MARGIN_L;
  const xR = PAGE_W - MARGIN_R;
  const rowH = 9;

  // Card outline
  pdf.setDrawColor(RULE[0], RULE[1], RULE[2]);
  pdf.setLineWidth(0.2);
  pdf.roundedRect(xL, c.y, CONTENT_W, rowH, 2, 2, 'S');

  let pillLabel: string;
  let pillFill: RGB;
  let pillTextColor: RGB;
  let metaLeft: string;
  let metaStrong: string;
  if (input.payment) {
    if (input.payment.status === 'paid') {
      pillLabel = 'Paid in full';
      pillFill = c.accent;
      pillTextColor = WHITE;
    } else {
      pillLabel = 'Payment failed';
      pillFill = [184, 58, 42]; // alert-style; rare path
      pillTextColor = WHITE;
    }
    metaStrong = properCase(input.payment.method);
    metaLeft = ` · ${fmtDate(input.payment.takenAt)}`;
  } else {
    pillLabel = 'Awaiting payment';
    pillFill = [240, 224, 196]; // warm sand
    pillTextColor = [122, 74, 15];
    metaStrong = '';
    metaLeft = 'Settle the balance at the till before leaving the clinic.';
  }

  // Pill
  setText(pdf, 8, pillTextColor, 'bold');
  const pillTextW = pdf.getTextWidth(pillLabel);
  const pillW = pillTextW + 7;
  const pillH = 5;
  const pillX = xL + 3.5;
  const pillY = c.y + (rowH - pillH) / 2;
  pdf.setFillColor(pillFill[0], pillFill[1], pillFill[2]);
  pdf.roundedRect(pillX, pillY, pillW, pillH, pillH / 2, pillH / 2, 'F');
  pdf.text(pillLabel, pillX + pillW / 2, pillY + 3.5, { align: 'center' });

  // Right-side meta
  if (input.payment) {
    setText(pdf, 8.5, INK, 'bold');
    const strongW = pdf.getTextWidth(metaStrong);
    setText(pdf, 8.5, MUTED, 'normal');
    const restW = pdf.getTextWidth(metaLeft);
    const totalW = strongW + restW;
    const startX = xR - 4 - totalW;
    setText(pdf, 8.5, INK, 'bold');
    pdf.text(metaStrong, startX, c.y + rowH / 2 + 1.6);
    setText(pdf, 8.5, MUTED, 'normal');
    pdf.text(metaLeft, startX + strongW, c.y + rowH / 2 + 1.6);
  } else {
    setText(pdf, 8.5, MUTED, 'normal');
    pdf.text(metaLeft, xR - 4, c.y + rowH / 2 + 1.6, { align: 'right' });
  }

  c.y += rowH;
}

function renderTerms(c: Cursor, input: WaiverDocInput, patientName: string): void {
  const { pdf } = c;
  c.y += 8;
  ensureSpace(c, 10);

  // Section heading
  setText(pdf, 8, c.accent, 'bold');
  pdf.text('TERMS YOU AGREED TO', MARGIN_L, c.y);
  c.y += 4;

  // Deck text
  setText(pdf, 9, MUTED, 'normal');
  const deck = pdf.splitTextToSize(
    `By signing, ${patientName} confirmed they understood every clause below and accepted the work and warranty terms as described. Continued overleaf.`,
    CONTENT_W,
  );
  ensureSpace(c, deck.length * 4 + 2);
  pdf.text(deck, MARGIN_L, c.y);
  c.y += deck.length * 4 + 2;

  for (let i = 0; i < input.sections.length; i++) {
    const section = input.sections[i]!;
    if (input.sections.length > 1) {
      ensureSpace(c, 7);
      c.y += 3;
      setText(pdf, 8, c.accent, 'bold');
      pdf.text(section.title.toUpperCase(), MARGIN_L, c.y);
      c.y += 4;
    } else {
      c.y += 1;
    }
    renderTermsList(c, section);
  }
}

function renderTermsList(c: Cursor, section: WaiverDocSection): void {
  const { pdf } = c;
  const indent = 6.5;
  const listX = MARGIN_L;
  const textX = listX + indent;
  const textW = CONTENT_W - indent;

  for (let i = 0; i < section.terms.length; i++) {
    const num = `${i + 1}.`;
    setText(pdf, 9, INK, 'normal');
    const lines = pdf.splitTextToSize(section.terms[i]!, textW);
    const lineH = 3.8;
    const itemH = lines.length * lineH + 1.6;

    // Atomic clause: never split across pages. If the whole item
    // doesn't fit on the current page, push to the next.
    ensureSpace(c, itemH);

    setText(pdf, 9, c.accent, 'bold');
    pdf.text(num, listX, c.y + 3);

    setText(pdf, 9, INK, 'normal');
    pdf.text(lines, textX, c.y + 3);
    c.y += itemH;
  }
}

async function renderSignatureCard(c: Cursor, input: WaiverDocInput, patientName: string): Promise<void> {
  const { pdf } = c;
  c.y += 6;

  const cardH = 30;
  ensureSpace(c, cardH + 2);

  const xL = MARGIN_L;
  const cardW = CONTENT_W;

  pdf.setDrawColor(RULE[0], RULE[1], RULE[2]);
  pdf.setLineWidth(0.2);
  pdf.roundedRect(xL, c.y, cardW, cardH, 2, 2, 'S');

  // Patient name
  setText(pdf, 9.5, INK, 'bold');
  pdf.text(patientName, xL + 5, c.y + 6);

  // Signature pad area: 70mm × 16mm. Render the SVG to a PNG and
  // place inside the card. If signatureSvg is missing we draw a
  // muted placeholder.
  const padX = xL + 5;
  const padY = c.y + 8;
  const padW = 70;
  const padH = 16;
  if (input.signatureSvg) {
    try {
      const png = await svgToPngDataUrl(input.signatureSvg, padW, padH);
      pdf.addImage(png, 'PNG', padX, padY, padW, padH, undefined, 'MEDIUM');
    } catch {
      // Loud fallback: render the placeholder so the absence of a
      // signature is visible to anyone looking at the document
      // rather than silently rendering nothing.
      setText(pdf, 7.5, SUBTLE, 'normal');
      pdf.text('Signature unavailable', padX + padW / 2, padY + padH / 2 + 1, { align: 'center' });
    }
  } else {
    setText(pdf, 7.5, SUBTLE, 'normal');
    pdf.text('Signature unavailable', padX + padW / 2, padY + padH / 2 + 1, { align: 'center' });
  }
  // Bottom rule under the pad to mimic the HTML signature line.
  pdf.setDrawColor(RULE[0], RULE[1], RULE[2]);
  pdf.line(padX, padY + padH + 0.4, padX + padW, padY + padH + 0.4);

  // Meta row (Signed / Witnessed by) under the pad.
  const latest = input.sections.reduce(
    (acc, s) => (s.signedAt > acc.signedAt ? s : acc),
    input.sections[0]!,
  );
  const metaY = padY + padH + 4;
  setText(pdf, 6, SUBTLE, 'bold');
  pdf.text('SIGNED', xL + 5, metaY);
  pdf.text('WITNESSED BY', xL + cardW / 2, metaY);
  setText(pdf, 8.5, INK, 'normal');
  pdf.text(fmtDateTime(latest.signedAt), xL + 5, metaY + 3.4);
  pdf.text(input.witnessName ? properCase(input.witnessName) : '—', xL + cardW / 2, metaY + 3.4);

  c.y += cardH;
}

function paintFooters(pdf: JsPdf, brandName: string, vatNumber: string | null): void {
  const total = pdf.getNumberOfPages();
  const left = vatNumber ? `${brandName} · VAT ${vatNumber}` : brandName;
  for (let p = 1; p <= total; p++) {
    pdf.setPage(p);
    setText(pdf, 7.5, SUBTLE, 'normal');
    pdf.text(left, MARGIN_L, FOOTER_Y);
    pdf.text(`Page ${p} of ${total}`, PAGE_W - MARGIN_R, FOOTER_Y, { align: 'right' });
  }
}

// ─────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────

export async function buildWaiverPdf(input: WaiverDocInput): Promise<Blob> {
  if (input.sections.length === 0) {
    throw new Error('buildWaiverPdf called with zero waiver sections. Caller must gate on signed-state.');
  }

  // Pre-load the brand logo concurrently with jsPDF so the receptionist
  // doesn't pay for two sequential network round-trips on click.
  const [JsPdf, logo] = await Promise.all([loadJsPdf(), fetchImage(input.brand.logoUrl)]);

  const pdf = new JsPdf({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  const cursor: Cursor = {
    pdf,
    y: MARGIN_T,
    accent: parseHexColor(input.accentColor),
  };

  const patientName = properCase(input.patient.fullName) || 'Patient';

  renderLetterhead(cursor, input, {
    dataUrl: logo.dataUrl,
    imgW: logo.width,
    imgH: logo.height,
    format: logo.format,
  });
  renderPatientGrid(cursor, input);
  renderItemsTable(cursor, input);
  renderTotals(cursor, input);
  renderPaymentRow(cursor, input);
  renderTerms(cursor, input, patientName);
  await renderSignatureCard(cursor, input, patientName);

  paintFooters(pdf, input.brand.name, input.brand.vatNumber);

  return pdf.output('blob');
}

// Convenience for the email path — the edge function expects a
// base64 string, not a Blob. Strips the data: URI prefix.
export async function blobToBase64(blob: Blob): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('FileReader returned non-string result.'));
        return;
      }
      const idx = result.indexOf(',');
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed.'));
    reader.readAsDataURL(blob);
  });
}

// Trigger a browser-side download of a blob with a chosen filename.
// Used by the Download action on the WaiverViewerDialog.
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Revoke on next tick so the click navigates first.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

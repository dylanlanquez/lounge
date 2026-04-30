// Cash count signed PDF statement.
//
// Same lazy-loaded jsPDF approach as waiverPdf.ts so the chunk only
// downloads when an admin actually triggers a print/download. Plain
// A4 layout — header with brand + period, totals block, line table,
// signature block at the bottom.

import type { CashCountStatement } from './queries/cashCounts.ts';

interface JsPdfDoc {
  setFont: (fontName: string, fontStyle?: string) => void;
  setFontSize: (size: number) => void;
  setTextColor: (r: number, g: number, b: number) => void;
  setDrawColor: (r: number, g: number, b: number) => void;
  setLineWidth: (w: number) => void;
  text: (text: string, x: number, y: number, options?: { align?: string }) => void;
  line: (x1: number, y1: number, x2: number, y2: number) => void;
  rect: (x: number, y: number, w: number, h: number, style?: string) => void;
  addPage: () => void;
  output: (type: 'blob') => Blob;
}
type JsPdfCtor = new () => JsPdfDoc;

let jsPdfPromise: Promise<JsPdfCtor> | null = null;
function loadJsPdf(): Promise<JsPdfCtor> {
  if (!jsPdfPromise) {
    jsPdfPromise = import('jspdf').then((m) => (m.jsPDF ?? m.default) as unknown as JsPdfCtor);
  }
  return jsPdfPromise;
}

const INK: [number, number, number] = [14, 20, 20];
const MUTED: [number, number, number] = [120, 130, 130];
const ACCENT: [number, number, number] = [31, 77, 58];
const ALERT: [number, number, number] = [184, 58, 42];

const PAGE_W = 210;
const PAGE_H = 297;
const MARGIN_L = 18;
const MARGIN_R = 18;
const MARGIN_T = 18;
const MARGIN_B = 22;

export async function buildCashCountPdf(
  statement: CashCountStatement,
  brand: { name: string; addressLine: string | null },
): Promise<Blob> {
  const Ctor = await loadJsPdf();
  const pdf = new Ctor();
  let y = MARGIN_T;

  // Header
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(18);
  pdf.setTextColor(...INK);
  pdf.text('Cash count statement', MARGIN_L, y);
  y += 7;
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(10);
  pdf.setTextColor(...MUTED);
  pdf.text(brand.name, MARGIN_L, y);
  if (brand.addressLine) {
    y += 5;
    pdf.text(brand.addressLine, MARGIN_L, y);
  }

  // Period — top right
  const periodText = `${formatDate(statement.count.period_start)} → ${formatDate(statement.count.period_end)}`;
  pdf.setTextColor(...INK);
  pdf.setFontSize(10);
  pdf.text(periodText, PAGE_W - MARGIN_R, MARGIN_T, { align: 'right' });
  pdf.setTextColor(...MUTED);
  pdf.setFontSize(8);
  pdf.text(`Status: ${statement.count.status.toUpperCase()}`, PAGE_W - MARGIN_R, MARGIN_T + 5, { align: 'right' });

  y += 12;
  pdf.setDrawColor(...MUTED);
  pdf.setLineWidth(0.2);
  pdf.line(MARGIN_L, y, PAGE_W - MARGIN_R, y);
  y += 8;

  // Totals block — three columns
  const colW = (PAGE_W - MARGIN_L - MARGIN_R) / 3;
  const blocks: { label: string; value: string; tone?: 'accent' | 'alert' | 'normal' }[] = [
    { label: 'EXPECTED', value: formatGbp(statement.count.expected_pence) },
    {
      label: 'ACTUAL',
      value: statement.count.actual_pence === null ? '—' : formatGbp(statement.count.actual_pence),
    },
    {
      label: 'VARIANCE',
      value:
        statement.count.actual_pence === null
          ? '—'
          : `${statement.count.variance_pence >= 0 ? '+' : '−'}${formatGbp(Math.abs(statement.count.variance_pence))}`,
      tone: statement.count.variance_pence < 0 ? 'alert' : statement.count.variance_pence > 0 ? 'accent' : 'normal',
    },
  ];
  blocks.forEach((b, i) => {
    const x = MARGIN_L + colW * i;
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.setTextColor(...MUTED);
    pdf.text(b.label, x, y);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(14);
    if (b.tone === 'alert') pdf.setTextColor(...ALERT);
    else if (b.tone === 'accent') pdf.setTextColor(...ACCENT);
    else pdf.setTextColor(...INK);
    pdf.text(b.value, x, y + 6);
  });
  y += 14;

  // Notes
  if (statement.count.notes) {
    pdf.setFont('helvetica', 'italic');
    pdf.setFontSize(9);
    pdf.setTextColor(...INK);
    pdf.text(`Notes: ${statement.count.notes}`, MARGIN_L, y);
    y += 6;
  }
  y += 4;

  // Lines table header
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(8);
  pdf.setTextColor(...MUTED);
  pdf.text('DATE', MARGIN_L, y);
  pdf.text('PATIENT', MARGIN_L + 38, y);
  pdf.text('REF', MARGIN_L + 110, y);
  pdf.text('AMOUNT', PAGE_W - MARGIN_R, y, { align: 'right' });
  y += 2;
  pdf.setDrawColor(...MUTED);
  pdf.setLineWidth(0.2);
  pdf.line(MARGIN_L, y, PAGE_W - MARGIN_R, y);
  y += 5;

  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9);
  pdf.setTextColor(...INK);

  for (const line of statement.lines) {
    if (y > PAGE_H - MARGIN_B - 20) {
      pdf.addPage();
      y = MARGIN_T;
    }
    pdf.text(formatDateTime(line.taken_at), MARGIN_L, y);
    pdf.text(truncate(line.patient_name, 38), MARGIN_L + 38, y);
    pdf.text(line.appointment_ref ?? '—', MARGIN_L + 110, y);
    pdf.text(formatGbp(line.amount_pence), PAGE_W - MARGIN_R, y, { align: 'right' });
    y += 5;
  }

  y += 4;
  pdf.setDrawColor(...MUTED);
  pdf.line(MARGIN_L, y, PAGE_W - MARGIN_R, y);
  y += 5;
  pdf.setFont('helvetica', 'bold');
  pdf.text('TOTAL EXPECTED', MARGIN_L, y);
  pdf.text(formatGbp(statement.count.expected_pence), PAGE_W - MARGIN_R, y, { align: 'right' });
  y += 14;

  // Signatures
  if (y > PAGE_H - MARGIN_B - 30) {
    pdf.addPage();
    y = MARGIN_T;
  }
  const sigW = (PAGE_W - MARGIN_L - MARGIN_R - 8) / 2;
  drawSignatureBlock(pdf, MARGIN_L, y, sigW, 'Counted by', statement.count.counted_by_name, statement.count.counted_at);
  drawSignatureBlock(
    pdf,
    MARGIN_L + sigW + 8,
    y,
    sigW,
    'Signed off by',
    statement.count.signed_off_by_name ?? '— pending —',
    statement.count.signed_off_at,
  );

  return pdf.output('blob');
}

function drawSignatureBlock(
  pdf: JsPdfDoc,
  x: number,
  y: number,
  w: number,
  label: string,
  name: string,
  iso: string | null,
): void {
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8);
  pdf.setTextColor(...MUTED);
  pdf.text(label.toUpperCase(), x, y);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(11);
  pdf.setTextColor(...INK);
  pdf.text(name, x, y + 6);
  if (iso) {
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.setTextColor(...MUTED);
    pdf.text(formatDateTime(iso), x, y + 11);
  }
  pdf.setDrawColor(...MUTED);
  pdf.setLineWidth(0.2);
  pdf.line(x, y + 14, x + w, y + 14);
}

function formatGbp(pence: number): string {
  return `£${(pence / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

export function downloadCashCountPdf(blob: Blob, filename: string): void {
  if (typeof document === 'undefined') {
    throw new Error('downloadCashCountPdf called outside the browser');
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// Cash count signed PDF statement.
//
// Same lazy-loaded jsPDF approach as waiverPdf.ts so the chunk only
// downloads when an admin actually triggers a print/download. Plain
// A4 layout — header with brand + period, totals block, line table,
// signature block at the bottom.

import {
  withdrawalReasonLabel as withdrawalReasonLabelPdf,
  type CashCountStatement,
  type CashPosition,
} from './queries/cashCounts.ts';
import { buildActivityStatement } from './cashReconcile.ts';
import { fmtTzAbbr } from './dateFormat.ts';

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

  // Difference written off by the super admin: the count reads as
  // matched above; say what it was and why it was accepted.
  if (statement.count.written_off_pence !== null && statement.count.written_off_pence !== 0) {
    const wo = statement.count.written_off_pence;
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(9);
    pdf.setTextColor(...MUTED);
    pdf.text(
      truncate(
        `Was ${formatGbp(Math.abs(wo))} ${wo > 0 ? 'over' : 'short'}, written off by ${statement.count.written_off_by_name ?? 'the super admin'}${
          statement.count.written_off_at ? ` on ${formatDate(statement.count.written_off_at)}` : ''
        }: ${statement.count.write_off_reason ?? ''}`,
        110,
      ),
      MARGIN_L,
      y,
    );
    y += 6;
  }

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

  // Withdrawals — cash taken out of the safe during this period (bank
  // deposit, float top-up, etc.). Listed below the payment lines under
  // their own heading so the reader can reconcile the running balance
  // ("payments in" + "cash taken out" = "expected").
  if (statement.withdrawals && statement.withdrawals.length > 0) {
    y += 8;
    if (y > PAGE_H - MARGIN_B - 20) {
      pdf.addPage();
      y = MARGIN_T;
    }
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(10);
    pdf.text('CASH TAKEN FROM THE SAFE', MARGIN_L, y);
    y += 5;
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(9);
    for (const w of statement.withdrawals) {
      if (y > PAGE_H - MARGIN_B - 20) {
        pdf.addPage();
        y = MARGIN_T;
      }
      pdf.setTextColor(...(w.reversed_at ? MUTED : INK));
      pdf.text(formatDateTime(w.taken_at), MARGIN_L, y);
      pdf.text(truncate(w.note ? `${withdrawalReasonLabelPdf(w.reason)} · ${w.note}` : withdrawalReasonLabelPdf(w.reason), 38), MARGIN_L + 38, y);
      pdf.text(truncate(w.taken_by_name ?? '—', 24), MARGIN_L + 110, y);
      pdf.text(w.reversed_at ? `(−${formatGbp(w.amount_pence)}) reversed` : `−${formatGbp(w.amount_pence)}`, PAGE_W - MARGIN_R, y, { align: 'right' });
      y += 5;
      if (w.reversed_at) {
        pdf.setTextColor(...MUTED);
        pdf.text(truncate(`Reversed after this count: ${w.reversal_reason ?? ''}`, 90), MARGIN_L + 38, y);
        y += 5;
      }
      pdf.setTextColor(...INK);
    }
  }

  // Envelopes found at the count that no recorded payment matched:
  // what was written on them, how much was inside, who processed them.
  if (statement.unrecorded.length > 0) {
    y += 8;
    if (y > PAGE_H - MARGIN_B - 20) {
      pdf.addPage();
      y = MARGIN_T;
    }
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(10);
    pdf.setTextColor(...INK);
    pdf.text('ENVELOPES NOT RECORDED IN LOUNGE', MARGIN_L, y);
    y += 5;
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(9);
    for (const u of statement.unrecorded) {
      if (y > PAGE_H - MARGIN_B - 20) {
        pdf.addPage();
        y = MARGIN_T;
      }
      pdf.text(truncate(u.order_ref ?? '—', 16), MARGIN_L, y);
      pdf.text(truncate(u.customer_name ?? '—', 38), MARGIN_L + 38, y);
      pdf.text(truncate(u.processed_by_name ? `by ${u.processed_by_name}` : '—', 24), MARGIN_L + 110, y);
      pdf.setTextColor(...ACCENT);
      pdf.text(`+${formatGbp(u.amount_pence)}`, PAGE_W - MARGIN_R, y, { align: 'right' });
      pdf.setTextColor(...INK);
      y += 5;
      if (u.note) {
        pdf.setTextColor(...MUTED);
        pdf.text(truncate(u.note, 90), MARGIN_L + 38, y);
        pdf.setTextColor(...INK);
        y += 5;
      }
    }
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
    statement.count.witness_name ? 'Witnessed and signed by' : 'Signed off by',
    statement.count.signed_off_by_name ?? statement.count.witness_name ?? '— pending —',
    statement.count.signed_off_at,
  );
  if (statement.count.on_camera) {
    y += 22;
    if (y > PAGE_H - MARGIN_B - 10) {
      pdf.addPage();
      y = MARGIN_T;
    }
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(9);
    pdf.setTextColor(...MUTED);
    pdf.text('Done in front of the camera with the safe witness present.', MARGIN_L, y);
  }

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

// ── Cash since last count (unsigned working sheet) ─────────────────────────
//
// The export staff take to the safe: every movement since the last
// signed count, oldest first, with a running balance and a tick box per
// row so each recorded payment can be checked off against its receipt.
// Ends with blank Counted / Difference lines to fill in by hand.

export async function buildCashActivityPdf(
  position: CashPosition,
  brand: { name: string; addressLine: string | null },
): Promise<Blob> {
  const Ctor = await loadJsPdf();
  const pdf = new Ctor();
  let y = MARGIN_T;
  const rows = buildActivityStatement(position);

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(18);
  pdf.setTextColor(...INK);
  pdf.text('Cash since last count', MARGIN_L, y);
  y += 7;
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(10);
  pdf.setTextColor(...MUTED);
  pdf.text(brand.name, MARGIN_L, y);
  if (brand.addressLine) {
    y += 5;
    pdf.text(brand.addressLine, MARGIN_L, y);
  }
  pdf.setTextColor(...INK);
  pdf.setFontSize(10);
  pdf.text(`${formatDate(position.period_start)} → ${formatDateTime(position.period_end)}`, PAGE_W - MARGIN_R, MARGIN_T, { align: 'right' });
  pdf.setTextColor(...MUTED);
  pdf.setFontSize(8);
  pdf.text('Working sheet, not a signed count', PAGE_W - MARGIN_R, MARGIN_T + 5, { align: 'right' });

  y += 12;
  pdf.setDrawColor(...MUTED);
  pdf.setLineWidth(0.2);
  pdf.line(MARGIN_L, y, PAGE_W - MARGIN_R, y);
  y += 8;

  const colW = (PAGE_W - MARGIN_L - MARGIN_R) / 3;
  const blocks = [
    { label: 'OPENING BALANCE', value: formatGbp(position.baseline_pence) },
    { label: 'CASH IN', value: formatGbp(rows.reduce((s, r) => s + r.in_pence, 0)) },
    { label: 'CASH OUT', value: formatGbp(rows.reduce((s, r) => s + r.out_pence, 0)) },
  ];
  blocks.forEach((b, i) => {
    const x = MARGIN_L + colW * i;
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.setTextColor(...MUTED);
    pdf.text(b.label, x, y);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(14);
    pdf.setTextColor(...INK);
    pdf.text(b.value, x, y + 6);
  });
  y += 16;

  // Table header. Columns: tick box, date, detail, taken by, in, out, balance.
  const X_TICK = MARGIN_L;
  const X_DATE = MARGIN_L + 7;
  const X_DETAIL = MARGIN_L + 36;
  const X_BY = MARGIN_L + 96;
  const X_IN = MARGIN_L + 132;
  const X_OUT = MARGIN_L + 152;
  const X_BAL = PAGE_W - MARGIN_R;
  const header = () => {
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(8);
    pdf.setTextColor(...MUTED);
    pdf.text('DATE', X_DATE, y);
    pdf.text('DETAIL', X_DETAIL, y);
    pdf.text('TAKEN BY', X_BY, y);
    pdf.text('IN', X_IN, y, { align: 'right' });
    pdf.text('OUT', X_OUT, y, { align: 'right' });
    pdf.text('BALANCE', X_BAL, y, { align: 'right' });
    y += 2;
    pdf.setDrawColor(...MUTED);
    pdf.line(MARGIN_L, y, PAGE_W - MARGIN_R, y);
    y += 5;
  };
  header();

  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9);
  pdf.setTextColor(...INK);
  pdf.text('Opening balance', X_DETAIL, y);
  pdf.text(formatGbp(position.baseline_pence), X_BAL, y, { align: 'right' });
  y += 5;

  for (const r of rows) {
    if (y > PAGE_H - MARGIN_B - 20) {
      pdf.addPage();
      y = MARGIN_T;
      header();
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(9);
      pdf.setTextColor(...INK);
    }
    // Tick box, only for recorded payments (the rows you check
    // against receipts).
    if (r.in_pence > 0) {
      pdf.setDrawColor(...INK);
      pdf.setLineWidth(0.3);
      pdf.rect(X_TICK, y - 3.2, 3.6, 3.6);
    }
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(9);
    pdf.setTextColor(...INK);
    pdf.text(formatShortDateTime(r.when), X_DATE, y);
    const detail = r.reference ? `${r.detail} · ${r.reference}` : r.detail;
    pdf.text(truncate(r.type === 'Cash payment' ? detail : `${r.type}${r.detail ? ` · ${r.detail}` : ''}`, 34), X_DETAIL, y);
    pdf.text(truncate(r.taken_by ?? '—', 18), X_BY, y);
    if (r.in_pence > 0) {
      pdf.setTextColor(...ACCENT);
      pdf.text(formatGbp(r.in_pence), X_IN, y, { align: 'right' });
    }
    if (r.out_pence > 0) {
      pdf.setTextColor(...ALERT);
      pdf.text(formatGbp(r.out_pence), X_OUT, y, { align: 'right' });
    }
    pdf.setTextColor(...INK);
    pdf.text(formatGbp(r.balance_pence), X_BAL, y, { align: 'right' });
    y += 5;
  }

  y += 2;
  pdf.setDrawColor(...MUTED);
  pdf.setLineWidth(0.2);
  pdf.line(MARGIN_L, y, PAGE_W - MARGIN_R, y);
  y += 6;
  if (y > PAGE_H - MARGIN_B - 40) {
    pdf.addPage();
    y = MARGIN_T;
  }
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(10);
  pdf.setTextColor(...INK);
  pdf.text('EXPECTED IN SAFE', MARGIN_L, y);
  pdf.text(formatGbp(position.expected_in_safe_pence), X_BAL, y, { align: 'right' });
  y += 12;

  // Blank lines to complete by hand at the safe.
  const half = (PAGE_W - MARGIN_L - MARGIN_R - 8) / 2;
  const blank = (x: number, label: string) => {
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.setTextColor(...MUTED);
    pdf.text(label, x, y);
    pdf.setDrawColor(...MUTED);
    pdf.line(x, y + 10, x + half, y + 10);
  };
  blank(MARGIN_L, 'COUNTED IN SAFE');
  blank(MARGIN_L + half + 8, 'DIFFERENCE');
  y += 20;
  blank(MARGIN_L, 'COUNTED BY');
  blank(MARGIN_L + half + 8, 'DATE AND TIME');

  return pdf.output('blob');
}

function formatShortDateTime(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
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
  const stamp = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
  return `${stamp} ${fmtTzAbbr(iso)}`;
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

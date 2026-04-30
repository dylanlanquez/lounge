import { describe, expect, it } from 'vitest';
import { csvFilename, toCsv, type CsvColumn } from './csv.ts';

interface SaleRow {
  patient: string;
  amount_pence: number;
  taken_at: string;
  note: string | null;
}

const SAMPLE: SaleRow[] = [
  { patient: 'Beth Mackay', amount_pence: 12500, taken_at: '2026-04-15', note: null },
  { patient: 'Cameron Docherty', amount_pence: 7800, taken_at: '2026-04-15', note: 'Discount applied' },
  { patient: 'Sarah, Jr.', amount_pence: 4200, taken_at: '2026-04-16', note: 'Note with "quotes" and\na newline' },
];

const COLUMNS: CsvColumn<SaleRow>[] = [
  { key: 'patient', label: 'Patient' },
  { key: 'taken_at', label: 'Date' },
  { key: 'amount_pence', label: 'Amount (£)', format: (v) => (Number(v) / 100).toFixed(2) },
  { key: 'note', label: 'Note' },
];

describe('toCsv', () => {
  it('writes the header row first', () => {
    const out = toCsv(SAMPLE, COLUMNS);
    const firstLine = out.split('\r\n')[0];
    expect(firstLine).toBe('Patient,Date,Amount (£),Note');
  });

  it('formats values via the column.format hook', () => {
    const out = toCsv([SAMPLE[0]!], COLUMNS);
    expect(out).toContain('125.00');
  });

  it('renders null cells as empty', () => {
    const out = toCsv([SAMPLE[0]!], COLUMNS);
    const dataLine = out.split('\r\n')[1] ?? '';
    expect(dataLine.endsWith(',')).toBe(true);
  });

  it('quotes cells containing commas', () => {
    const out = toCsv([SAMPLE[2]!], COLUMNS);
    expect(out).toContain('"Sarah, Jr."');
  });

  it('quotes and doubles internal double-quotes', () => {
    const out = toCsv([SAMPLE[2]!], COLUMNS);
    expect(out).toContain('""quotes""');
  });

  it('quotes cells containing newlines so the CSV stays one-row-per-line in tools that handle quoted fields', () => {
    const out = toCsv([SAMPLE[2]!], COLUMNS);
    expect(out).toContain('"Note with ""quotes"" and\na newline"');
  });

  it('uses CRLF as the row separator (RFC 4180)', () => {
    const out = toCsv(SAMPLE, COLUMNS);
    expect(out).toContain('\r\n');
    // No bare LF line breaks except inside quoted cells.
    const lines = out.split('\r\n');
    expect(lines.length).toBeGreaterThan(SAMPLE.length); // header + rows; quoted-newline cell may add lines
  });

  it('handles an empty data array — header only', () => {
    const out = toCsv([], COLUMNS);
    expect(out).toBe('Patient,Date,Amount (£),Note');
  });

  it('throws when no columns are supplied — caller must declare schema', () => {
    expect(() => toCsv(SAMPLE, [])).toThrow(/at least one column/);
  });
});

describe('csvFilename', () => {
  it('combines slug + date range', () => {
    const f = csvFilename('financials_sales', { start: '2026-04-01', end: '2026-04-30' });
    expect(f).toBe('financials_sales_2026-04-01_to_2026-04-30.csv');
  });

  it('produces a filename for a single-day export', () => {
    const f = csvFilename('cash_count', { start: '2026-04-15', end: '2026-04-15' });
    expect(f).toBe('cash_count_2026-04-15_to_2026-04-15.csv');
  });
});

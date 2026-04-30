// CSV builder + browser-side download helper, used by every Reports /
// Financials list-shaped page that exposes a "Download CSV" button.
//
// Why a hand-rolled util rather than a library: the brief is precise
// about not introducing dependencies for things we can do safely in
// fewer lines than the import statement. CSV is one of those — the
// only subtle bit is escape rules (RFC 4180), which are short.
//
// Caller passes a typed array of rows + a column spec. The spec is
// strongly typed so a typo on a column key fails at compile time
// rather than producing a CSV with an undefined column.

export interface CsvColumn<T> {
  key: keyof T & string;
  // Header text that lands in the first row of the CSV. Not the same
  // as the JS key — that's what the spreadsheet user sees.
  label: string;
  // Optional formatter: lets a date / pence / array column render the
  // way a human reading the spreadsheet would expect, without coupling
  // the CSV layer to formatting helpers higher up. Default: String(v).
  format?: (value: T[keyof T & string], row: T) => string;
}

// Builds a CSV string from a row array + column spec. Rows can be any
// shape; the column.key picks a field per column and column.format (if
// supplied) renders it. Null and undefined become empty cells.
export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  if (columns.length === 0) {
    throw new Error('toCsv requires at least one column');
  }
  const lines: string[] = [];
  lines.push(columns.map((c) => escapeCell(c.label)).join(','));
  for (const row of rows) {
    lines.push(
      columns
        .map((c) => {
          const raw = row[c.key];
          if (raw === null || raw === undefined) return '';
          const rendered = c.format ? c.format(raw, row) : String(raw);
          return escapeCell(rendered);
        })
        .join(','),
    );
  }
  // RFC 4180 mandates CRLF between records; keeps the output legible
  // when opened in Excel for Windows and any modern spreadsheet tool.
  return lines.join('\r\n');
}

// RFC 4180 escape: wrap in double quotes if the cell contains a
// comma, newline, or quote; double up any internal quotes.
function escapeCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// Triggers a browser download of `content` named `filename`. Pulled out
// so the same util can serve the existing CSV exports + any future ones.
// SSR-safe: throws loudly if the document API isn't available rather
// than silently no-oping (per the brief — every unexpected condition
// throws).
export function downloadCsv(filename: string, content: string): void {
  if (typeof document === 'undefined') {
    throw new Error('downloadCsv called outside the browser');
  }
  const blob = new Blob([`﻿${content}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke so Safari has time to start the download. 0ms still
  // hands off to the next macrotask which is enough.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// Compose a sensible CSV filename for a report download. Lowercase
// kebab-case prefix + ISO date range so the file sorts naturally on
// disk and is unambiguous when emailed to an accountant.
export function csvFilename(reportSlug: string, range: { start: string; end: string }): string {
  return `${reportSlug}_${range.start}_to_${range.end}.csv`;
}

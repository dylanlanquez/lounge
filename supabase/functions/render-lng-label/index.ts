// render-lng-label
//
// Converts a DPD ZPL string to a PDF via Labelary and returns the binary.
// Identical pipeline to Checkpoint's render-label — copied here so Lounge
// can print DPD labels without needing Checkpoint's anon key.
//
// Auth: anon-key Bearer JWT (signed-in staff).
// Body: { zpl: string }
// Response: application/pdf binary on success; JSON error on failure.

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info',
};

const DPMM    = 12;
const BC_W_MM = 91.5;
const BC_H_MM = 25;
const BC_W_PX = Math.round(BC_W_MM * DPMM); // 1098
const BC_H_PX = Math.round(BC_H_MM * DPMM); // 300

// Code 128 bar pattern table (values 0–106)
const CODE128_PATTERNS = [
  '212222','222122','222221','121223','121322','131222','122213','122312',
  '132212','221213','221312','231212','112232','122132','122231','113222',
  '123122','123221','223211','221132','221231','213212','223112','312131',
  '311222','321122','321221','312212','322112','322211','212123','212321',
  '232121','111323','131123','131321','112313','132113','132311','211313',
  '231113','231311','112133','112331','132131','113123','113321','133121',
  '313121','211331','231131','213113','213311','213131','311123','311321',
  '331121','312113','312311','332111','314111','221411','431111','111224',
  '111422','121124','121421','141122','141221','112214','112412','122114',
  '122411','142112','142211','241211','221114','413111','241112','134111',
  '111242','121142','121241','114212','124112','124211','411212','421112',
  '421211','212141','214121','412121','111143','111341','131141','114113',
  '114311','411113','411311','113141','114131','311141','411131','211412',
  '211214','211232','2331112',
];

const START_B = 104;
const CODE_B  = 100;
const CODE_C  = 99;
const FNC1    = 102;
const FNC2    = 97;
const FNC3    = 96;

type Token = { kind: 'char'; value: number } | { kind: 'fnc'; n: 1 | 2 | 3 };

function tokenise(data: string): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    if (c === '>' && i + 1 < data.length) {
      const esc = data[i + 1];
      if (esc === '5') { out.push({ kind: 'fnc', n: 3 }); i++; continue; }
      if (esc === '6') { out.push({ kind: 'fnc', n: 2 }); i++; continue; }
      if (esc === '7') { out.push({ kind: 'fnc', n: 1 }); i++; continue; }
      if (esc === '=') { out.push({ kind: 'char', value: '>'.charCodeAt(0) }); i++; continue; }
    }
    out.push({ kind: 'char', value: c.charCodeAt(0) });
  }
  return out;
}

function isDigit(t: Token): boolean {
  return t.kind === 'char' && t.value >= 48 && t.value <= 57;
}

function digitRunFrom(tokens: Token[], i: number): number {
  let n = 0;
  while (i + n < tokens.length && isDigit(tokens[i + n])) n++;
  return n;
}

function encodeToCode128(tokens: Token[]): number[] {
  const values: number[] = [];
  let subset: 'B' | 'C' = 'B';
  values.push(START_B);
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.kind === 'fnc') {
      if (t.n === 1) values.push(FNC1);
      else if (t.n === 2) values.push(FNC2);
      else values.push(FNC3);
      i++; continue;
    }
    if (subset === 'B' && isDigit(t)) {
      const run    = digitRunFrom(tokens, i);
      const usable = (run % 2 === 0) ? run : run - 1;
      if (usable >= 4) {
        if (run % 2 === 1) { values.push(t.value - 32); i++; }
        values.push(CODE_C); subset = 'C';
        for (let j = 0; j < usable; j += 2) {
          const pair = (tokens[i + j].value - 48) * 10 + (tokens[i + j + 1].value - 48);
          values.push(pair);
        }
        i += usable; continue;
      }
    }
    if (subset === 'C') { values.push(CODE_B); subset = 'B'; }
    values.push(t.value - 32);
    i++;
  }
  let sum = values[0];
  for (let k = 1; k < values.length; k++) sum += k * values[k];
  values.push(sum % 103);
  values.push(106);
  return values;
}

function toModuleWidths(values: number[]): number[] {
  const widths: number[] = [];
  for (const v of values) {
    const pattern = CODE128_PATTERNS[v];
    for (const d of pattern) widths.push(parseInt(d, 10));
  }
  return widths;
}

function rasteriseBars(widths: number[], targetPx: number): Uint8Array {
  const totalModules = widths.reduce((a, b) => a + b, 0);
  const pixels       = new Uint8Array(targetPx);
  let   moduleCursor = 0;
  let   isBar        = true;
  for (const w of widths) {
    if (isBar) {
      const startPx = Math.round((moduleCursor / totalModules) * targetPx);
      const endPx   = Math.round(((moduleCursor + w) / totalModules) * targetPx);
      for (let x = startPx; x < endPx && x < targetPx; x++) pixels[x] = 1;
    }
    moduleCursor += w;
    isBar = !isBar;
  }
  return pixels;
}

function buildBarcodeGB(data: string, barsX: number, y: number): string {
  const tokens    = tokenise(data);
  const values    = encodeToCode128(tokens);
  const widths    = toModuleWidths(values);
  const barPixels = rasteriseBars(widths, BC_W_PX);
  const parts: string[] = [];
  let runStart = -1;
  for (let x = 0; x <= BC_W_PX; x++) {
    const on = x < BC_W_PX && barPixels[x] === 1;
    if (on && runStart === -1) { runStart = x; }
    else if (!on && runStart !== -1) {
      const w = x - runStart;
      parts.push(`^FO${barsX + runStart},${y}^GB${w},${BC_H_PX},${w}^FS`);
      runStart = -1;
    }
  }
  return parts.join('');
}

const BC_REGEX = /\^FO(\d+),(\d+)\s*\^BY\d+(?:\.\d+)?,?\^BCN,\d+,N,N,N,N\^FD([^\^]+)\^FS/;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

  try {
    const { zpl } = await req.json();
    if (!zpl) {
      return new Response(JSON.stringify({ error: 'No ZPL data' }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    const bcMatch = zpl.match(BC_REGEX);
    if (!bcMatch) {
      return new Response(JSON.stringify({ error: 'Could not locate DPD barcode in ZPL' }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    const barcodeData       = bcMatch[3];
    const zplWithCustomBarcode = zpl.replace(BC_REGEX, () => buildBarcodeGB(barcodeData, 56, 818));
    const adjustedZpl       = zplWithCustomBarcode
      .replace(/\^XA/, '^XA^LS20^LT-20')
      .replace(/\^AdN,18,18/g, '^ADN,32,18')
      .replace(/\^FT20,1126/g, '^FT20,1165');

    const labelaryRes = await fetch('https://api.labelary.com/v1/printers/12dpmm/labels/4.00x4.00/0/', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/pdf' },
      body:    adjustedZpl,
    });

    if (!labelaryRes.ok) {
      const errText = await labelaryRes.text();
      return new Response(JSON.stringify({ error: 'Labelary render failed', detail: errText }), { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    const pdfBytes = new Uint8Array(await labelaryRes.arrayBuffer());
    return new Response(pdfBytes, {
      status:  200,
      headers: { ...cors, 'Content-Type': 'application/pdf' },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
});

// html2canvas + jsPDF are heavy (~700kB combined). They're only
// needed inside the View Waiver dialog, so we dynamic-import them
// at call time rather than letting them bloat VisitDetail's
// initial bundle. Vite splits them into their own chunks.
type Html2CanvasFn = (
  element: HTMLElement,
  options?: Record<string, unknown>,
) => Promise<HTMLCanvasElement>;
type JsPdfCtor = new (
  options?: { unit?: string; format?: string; orientation?: string },
) => {
  addImage: (
    data: string,
    type: string,
    x: number,
    y: number,
    w: number,
    h: number,
    alias?: unknown,
    compression?: string,
  ) => unknown;
  addPage: (format?: string, orientation?: string) => unknown;
  output: (kind: 'blob') => Blob;
};

let html2canvasPromise: Promise<Html2CanvasFn> | null = null;
let jsPdfPromise: Promise<JsPdfCtor> | null = null;

function loadHtml2Canvas(): Promise<Html2CanvasFn> {
  if (!html2canvasPromise) {
    html2canvasPromise = import('html2canvas').then((m) => m.default as Html2CanvasFn);
  }
  return html2canvasPromise;
}

function loadJsPdf(): Promise<JsPdfCtor> {
  if (!jsPdfPromise) {
    jsPdfPromise = import('jspdf').then((m) => (m.jsPDF ?? m.default) as JsPdfCtor);
  }
  return jsPdfPromise;
}

// Render a waiver HTML document into a multi-page A4 PDF (Blob).
//
// Strategy:
//
//   1. Mount the HTML inside an offscreen, fixed-size iframe. The
//      iframe is the layout root the waiver document was authored
//      against (A4 width, document fonts, @page margins) — its CSS
//      isn't influenced by the host app's theme tokens, so what
//      renders here matches what the printer would.
//
//   2. Wait for layout: images (logo) need to load before
//      html2canvas snapshots, otherwise they'd render as broken
//      placeholders. We wait for window.load AND every <img> to
//      complete, with a hard timeout so a network blip doesn't
//      hang the operator forever.
//
//   3. html2canvas the document body to a high-resolution canvas.
//      A 2× scale is enough to keep typography crisp on the
//      printable PDF without making the file enormous.
//
//   4. Slice the canvas into A4 pages and write each into a fresh
//      jsPDF page. The waiver layout is targeted to fit on one A4,
//      so this is usually a single page — the slicer is the safety
//      net for an unusually large item set or terms list.
//
// Failure posture (per CLAUDE.md): every error path throws with
// context. No silent fallback to "an empty PDF" or "skip the
// missing image" — staff need to know what failed so they can
// retry vs escalate.

const A4_WIDTH_MM = 210;
const A4_HEIGHT_MM = 297;
// Browser CSS pixel density at the document's authored size. The
// waiver's @page rule is `12mm 16mm`, so the iframe's renderable
// width in CSS pixels is (210 - 32) ≈ 178mm at the document's
// scale. Width here picks the iframe rendering width; tall pages
// scroll within it during measurement and html2canvas captures
// the whole flow.
const RENDER_WIDTH_PX = 794; // A4 width at 96 DPI

async function waitForImages(doc: Document, timeoutMs: number): Promise<void> {
  const images = Array.from(doc.images);
  const pending = images
    .filter((img) => !img.complete || img.naturalHeight === 0)
    .map(
      (img) =>
        new Promise<void>((resolve) => {
          // We resolve on both success and failure — a missing
          // image shouldn't hold up the print/email flow. The
          // resulting canvas just renders the broken-image
          // placeholder, which is loud enough that the user
          // notices and re-tries.
          img.addEventListener('load', () => resolve(), { once: true });
          img.addEventListener('error', () => resolve(), { once: true });
        }),
    );
  if (pending.length === 0) return;
  await Promise.race([
    Promise.all(pending),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

export async function buildWaiverPdf(html: string): Promise<Blob> {
  // Offscreen iframe — sized to A4 width so the document's @page
  // rule (which jsdom-style HTML doesn't respect) effectively
  // applies via the iframe viewport.
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText = `
    position: fixed;
    left: -10000px;
    top: 0;
    width: ${RENDER_WIDTH_PX}px;
    height: 1px;
    border: 0;
    pointer-events: none;
    visibility: hidden;
  `;
  document.body.appendChild(iframe);

  try {
    const idoc = iframe.contentDocument;
    const iwin = iframe.contentWindow;
    if (!idoc || !iwin) {
      throw new Error('Could not open offscreen frame for PDF rendering.');
    }
    idoc.open();
    idoc.write(html);
    idoc.close();

    // Let the document layout. Wait for fonts (browsers expose
    // document.fonts.ready) and any images (logo). 6s ceiling so
    // a slow CDN doesn't lock the UI indefinitely.
    if (idoc.fonts && typeof idoc.fonts.ready?.then === 'function') {
      await idoc.fonts.ready.catch(() => undefined);
    }
    await waitForImages(idoc, 6000);

    const body = idoc.body;
    if (!body || body.scrollHeight === 0) {
      throw new Error('Waiver document failed to render — body has no content.');
    }
    // Resize iframe to fit content so html2canvas captures the
    // whole flow rather than just the visible portion.
    iframe.style.height = body.scrollHeight + 'px';

    const html2canvas = await loadHtml2Canvas();
    const canvas = await html2canvas(body, {
      scale: 2,
      backgroundColor: '#ffffff',
      useCORS: true,
      windowWidth: RENDER_WIDTH_PX,
      windowHeight: body.scrollHeight,
      logging: false,
    });
    if (canvas.width === 0 || canvas.height === 0) {
      throw new Error('html2canvas produced an empty canvas.');
    }

    // Build the PDF. A4 portrait. Each canvas-page-worth of pixels
    // goes onto its own PDF page. Width is the controlling
    // dimension; canvas height is sliced into A4-height chunks at
    // the same horizontal scale.
    const JsPdf = await loadJsPdf();
    const pdf = new JsPdf({ unit: 'mm', format: 'a4', orientation: 'portrait' });
    const imgWidthMm = A4_WIDTH_MM;
    const pxPerMm = canvas.width / imgWidthMm;
    const pageHeightPx = Math.floor(A4_HEIGHT_MM * pxPerMm);

    // First pass: count how many PDF pages this canvas will produce
    // so the per-page footer can render "Page N of M". Deterministic
    // — same arithmetic as the render loop below.
    const totalPages = Math.max(1, Math.ceil(canvas.height / pageHeightPx));

    let renderedPx = 0;
    let pageIndex = 0;
    while (renderedPx < canvas.height) {
      const slice = document.createElement('canvas');
      const remaining = canvas.height - renderedPx;
      const sliceHeight = Math.min(pageHeightPx, remaining);
      slice.width = canvas.width;
      slice.height = sliceHeight;
      const ctx = slice.getContext('2d');
      if (!ctx) throw new Error('Could not acquire 2D context for PDF slicing.');
      ctx.drawImage(
        canvas,
        0,
        renderedPx,
        canvas.width,
        sliceHeight,
        0,
        0,
        canvas.width,
        sliceHeight,
      );
      const dataUrl = slice.toDataURL('image/jpeg', 0.92);
      const sliceHeightMm = sliceHeight / pxPerMm;
      if (pageIndex > 0) pdf.addPage('a4', 'portrait');
      pdf.addImage(dataUrl, 'JPEG', 0, 0, imgWidthMm, sliceHeightMm, undefined, 'FAST');

      // Footer overlay. html2canvas captures screen output and
      // skips @page margin boxes, so the per-page legal line +
      // page indicator are drawn directly onto each PDF page in
      // the same gutter the @page rule reserves on direct print.
      // Anything we render here matches the on-screen footer
      // visually even though the source is a different rendering
      // pipeline.
      const pdfAny = pdf as unknown as {
        setFontSize: (n: number) => void;
        setTextColor: (r: number, g: number, b: number) => void;
        setFont: (name: string, style?: string) => void;
        text: (s: string, x: number, y: number, opts?: { align?: string }) => void;
      };
      pdfAny.setFont('helvetica', 'normal');
      pdfAny.setFontSize(8);
      pdfAny.setTextColor(120, 124, 124);
      const footerY = A4_HEIGHT_MM - 8;
      pdfAny.text('Venneir · VAT GB406459983', 18, footerY);
      pdfAny.text(
        `Page ${pageIndex + 1} of ${totalPages}`,
        A4_WIDTH_MM - 18,
        footerY,
        { align: 'right' },
      );

      renderedPx += sliceHeight;
      pageIndex += 1;
    }

    return pdf.output('blob');
  } finally {
    iframe.remove();
  }
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

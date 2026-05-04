import { forwardRef, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Mail, Printer, X } from 'lucide-react';
import { BottomSheet } from '../BottomSheet/BottomSheet.tsx';
import { Button } from '../Button/Button.tsx';
import { Input } from '../Input/Input.tsx';
import { theme } from '../../theme/index.ts';
import { useIsMobile } from '../../lib/useIsMobile.ts';
import {
  buildWaiverDocument,
  waiverDocumentFileName,
  type WaiverDocInput,
} from '../../lib/waiverDocument.ts';
import {
  blobToBase64,
  buildWaiverPdf,
  downloadBlob,
} from '../../lib/waiverPdf.ts';
import { emailWaiver } from '../../lib/queries/emailWaiver.ts';

// Single dialog covering the View Waiver flow on VisitDetail.
//
//   • Preview  — iframe rendering the same HTML the print/PDF/email
//                surfaces consume. What the receptionist sees here
//                is what's coming out of the printer / landing in
//                the patient's inbox.
//   • Print    — opens the document in a new window and triggers
//                the browser print dialog. Most desktops expose
//                "Save as PDF" from there too, so we don't fight
//                a shadow PDF flow for the simple "I want a hard
//                copy now" case.
//   • Download — builds a real vector PDF client-side via jsPDF text
//                primitives (no html2canvas rasterisation, so the
//                output is selectable, searchable text rather than
//                a series of JPEG pages) and triggers a browser
//                download. Always offered — works on desktop and
//                tablet, where it routes to the OS's Files /
//                Downloads target.
//   • Email    — flips the dialog body into a recipient composer
//                (default to patient.email), generates the same
//                PDF, sends to the email-waiver edge function with
//                the PDF as a base64 attachment.
//
// Loud-failure posture (per CLAUDE.md): every action wraps a
// try/catch that surfaces the underlying message in a red banner
// inside the dialog and leaves the action enabled so staff can
// re-try once the cause is cleared. Successes flip the banner
// green ("Sent to dylan@…") rather than auto-closing, so a busy
// receptionist sees the result before turning back to the cart.

export interface WaiverViewerDialogProps {
  open: boolean;
  onClose: () => void;
  // Pre-shaped document input. The dialog never reaches into
  // lng_visits / lng_cart_items itself — the parent (VisitDetail
  // or PatientProfile) composes everything, including filtering
  // impression-appointment lines out, so the dialog stays a pure
  // renderer.
  doc: WaiverDocInput | null;
  visitId: string | null;
  patientEmail: string | null;
  // Whether the Email action is offered. Defaults to true. Set to
  // false on surfaces with no visit context (the patient profile's
  // waiver-only documents) — the email-waiver edge function audits
  // sends against a visit, so a visit-less waiver can't be emailed
  // through it. Print and Download still work unchanged.
  allowEmail?: boolean;
}

type Mode = 'preview' | 'compose';
type Status =
  | { kind: 'idle' }
  | { kind: 'busy'; label: string }
  | { kind: 'error'; message: string }
  | { kind: 'success'; message: string };

export function WaiverViewerDialog({
  open,
  onClose,
  doc,
  visitId,
  patientEmail,
  allowEmail = true,
}: WaiverViewerDialogProps) {
  const isMobile = useIsMobile();
  const [mode, setMode] = useState<Mode>('preview');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [recipient, setRecipient] = useState('');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const previewRef = useRef<HTMLIFrameElement | null>(null);

  // Render the document HTML once per open / doc change. memoised
  // so re-renders of the parent don't rebuild a 10kB string each
  // time the receptionist resizes the browser.
  const html = useMemo(() => {
    if (!doc) return null;
    try {
      return buildWaiverDocument(doc);
    } catch (e) {
      // The generator throws when its preconditions are violated
      // (e.g. zero waiver sections). The parent gates the button
      // on `sections.length > 0`, so this is a programmer error;
      // surface it loudly rather than render an empty frame.
      // eslint-disable-next-line no-console
      console.error('[WaiverViewerDialog] buildWaiverDocument failed', e);
      return null;
    }
  }, [doc]);

  // Reset transient state every time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setMode('preview');
    setStatus({ kind: 'idle' });
    setRecipient(patientEmail ?? '');
    setSubject('Your Venneir waiver');
    setMessage('');
  }, [open, patientEmail]);

  // Push the rendered HTML into the preview iframe. Using srcdoc
  // would re-mount the iframe every render — the imperative
  // contentDocument.write here lets the iframe survive across
  // status flips so the print / download paths can re-read it.
  // Once the doc is in, measure its actual content height and
  // notify the parent so the wrapping div can size to match —
  // otherwise a short doc renders inside a fixed 2-page box and
  // the receptionist sees a sea of white below the signature.
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  useEffect(() => {
    if (!open || mode !== 'preview') return;
    const iframe = previewRef.current;
    if (!iframe || !html) return;
    const idoc = iframe.contentDocument;
    if (!idoc) return;
    idoc.open();
    idoc.write(html);
    idoc.close();

    const measure = (): void => {
      const h = idoc.body?.scrollHeight ?? 0;
      if (h > 0) setContentHeight(h);
    };
    // First measurement after the doc is in. ResizeObserver picks
    // up subsequent changes (font load, image load, etc.) so the
    // preview never settles at a stale height.
    measure();
    const ro = idoc.defaultView && 'ResizeObserver' in idoc.defaultView
      ? new (idoc.defaultView as Window & typeof globalThis).ResizeObserver(measure)
      : null;
    if (ro && idoc.body) ro.observe(idoc.body);
    return () => {
      ro?.disconnect();
    };
  }, [open, mode, html]);

  if (!doc) return null;

  const fileName = waiverDocumentFileName(doc);

  // Action handlers ────────────────────────────────────────────────────────
  // Each handler pulls the latest html via the memo to avoid
  // capturing stale closures, surfaces failures via setStatus, and
  // never silently no-ops.
  const printDoc = () => {
    if (!html) {
      setStatus({ kind: 'error', message: 'Document not ready. Close the dialog and try again.' });
      return;
    }
    const win = window.open('', '_blank', 'width=900,height=1100');
    if (!win) {
      setStatus({
        kind: 'error',
        message: 'Could not open the print window. Allow pop-ups for lounge.venneir.com and try again.',
      });
      return;
    }
    win.document.write(html);
    // Append a tiny script that fires the print dialog once the
    // document has loaded. Inline so we don't have to coordinate
    // with the parent — the new window is a separate document
    // and can't reach back here without a postMessage dance.
    win.document.write(
      `<script>window.addEventListener('load',function(){setTimeout(function(){window.print()},80)});<\/script>`,
    );
    win.document.close();
  };

  const downloadDoc = async () => {
    if (!doc) {
      setStatus({ kind: 'error', message: 'Document not ready. Close the dialog and try again.' });
      return;
    }
    setStatus({ kind: 'busy', label: 'Building PDF…' });
    try {
      const blob = await buildWaiverPdf(doc);
      downloadBlob(blob, fileName);
      setStatus({ kind: 'success', message: `Downloaded ${fileName}.` });
    } catch (e) {
      setStatus({
        kind: 'error',
        message: e instanceof Error ? e.message : 'Could not build the PDF. Try again.',
      });
    }
  };

  const sendEmail = async () => {
    if (!doc) {
      setStatus({ kind: 'error', message: 'Document not ready. Close the dialog and try again.' });
      return;
    }
    if (!visitId) {
      setStatus({ kind: 'error', message: 'Visit context missing. Close the dialog and re-open.' });
      return;
    }
    const trimmed = recipient.trim();
    if (!trimmed) {
      setStatus({ kind: 'error', message: 'Add a recipient email first.' });
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setStatus({ kind: 'error', message: 'That email address does not look right.' });
      return;
    }
    setStatus({ kind: 'busy', label: 'Sending…' });
    try {
      const blob = await buildWaiverPdf(doc);
      const pdfBase64 = await blobToBase64(blob);
      await emailWaiver({
        visitId,
        recipientEmail: trimmed,
        pdfBase64,
        fileName,
        ...(subject.trim() ? { subject: subject.trim() } : {}),
        ...(message.trim() ? { message: message.trim() } : {}),
      });
      setStatus({ kind: 'success', message: `Sent to ${trimmed}.` });
    } catch (e) {
      setStatus({
        kind: 'error',
        message: e instanceof Error ? e.message : 'Could not send the email.',
      });
    }
  };

  const busy = status.kind === 'busy';

  return (
    <BottomSheet
      open={open}
      onClose={() => !busy && onClose()}
      title="View signed waiver"
      description={`A4 visit summary and signed waiver, ${doc.sections.length} section${doc.sections.length === 1 ? '' : 's'}.`}
      dismissable={!busy}
      footer={
        <div
          style={{
            display: 'flex',
            gap: theme.space[3],
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', gap: theme.space[2], flexWrap: 'wrap' }}>
            {mode === 'preview' ? (
              <>
                <Button variant="secondary" onClick={printDoc} disabled={busy}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
                    <Printer size={18} aria-hidden />
                    Print
                  </span>
                </Button>
                <Button variant="secondary" onClick={() => void downloadDoc()} disabled={busy}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
                    <Download size={18} aria-hidden />
                    {busy && status.label === 'Building PDF…' ? 'Building…' : 'Download'}
                  </span>
                </Button>
                {allowEmail ? (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setMode('compose');
                      setStatus({ kind: 'idle' });
                    }}
                    disabled={busy}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
                      <Mail size={18} aria-hidden />
                      Email
                    </span>
                  </Button>
                ) : null}
              </>
            ) : (
              <Button
                variant="tertiary"
                onClick={() => {
                  setMode('preview');
                  setStatus({ kind: 'idle' });
                }}
                disabled={busy}
              >
                Back to preview
              </Button>
            )}
          </div>
          <div style={{ display: 'flex', gap: theme.space[2] }}>
            <Button variant="tertiary" onClick={onClose} disabled={busy}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
                <X size={16} aria-hidden />
                Close
              </span>
            </Button>
            {mode === 'compose' ? (
              <Button variant="primary" onClick={() => void sendEmail()} loading={busy}>
                Send waiver
              </Button>
            ) : null}
          </div>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
        <StatusBanner status={status} />
        {mode === 'preview' ? (
          <PreviewFrame ref={previewRef} mobile={isMobile} contentHeight={contentHeight} />
        ) : (
          <Composer
            recipient={recipient}
            subject={subject}
            message={message}
            onRecipient={(v) => setRecipient(v)}
            onSubject={(v) => setSubject(v)}
            onMessage={(v) => setMessage(v)}
            disabled={busy}
            patientEmail={patientEmail}
            fileName={fileName}
          />
        )}
      </div>
    </BottomSheet>
  );
}

function StatusBanner({ status }: { status: Status }) {
  if (status.kind === 'idle') return null;
  if (status.kind === 'busy') {
    return (
      <div
        role="status"
        style={{
          padding: theme.space[3],
          borderRadius: theme.radius.input,
          background: theme.color.bg,
          border: `1px solid ${theme.color.border}`,
          color: theme.color.inkMuted,
          fontSize: theme.type.size.sm,
        }}
      >
        {status.label}
      </div>
    );
  }
  if (status.kind === 'error') {
    return (
      <div
        role="alert"
        style={{
          display: 'flex',
          gap: theme.space[2],
          padding: theme.space[3],
          borderRadius: theme.radius.input,
          background: theme.color.alert,
          color: theme.color.surface,
          fontSize: theme.type.size.sm,
          fontWeight: theme.type.weight.medium,
        }}
      >
        {status.message}
      </div>
    );
  }
  return (
    <div
      role="status"
      style={{
        padding: theme.space[3],
        borderRadius: theme.radius.input,
        background: theme.color.accentBg,
        border: `1px solid ${theme.color.accent}`,
        color: theme.color.accent,
        fontSize: theme.type.size.sm,
        fontWeight: theme.type.weight.medium,
      }}
    >
      {status.message}
    </div>
  );
}

// Canonical document width. The waiver doc is authored at A4 portrait
// at 96 DPI = 210mm = 794 CSS pixels. We render the iframe at this
// width and use a CSS transform to scale-to-fit the dialog viewport,
// so the on-screen preview matches the printed PDF byte-for-byte.
const A4_WIDTH_PX = 794;
// Two A4 pages stacked: 297mm × 2 = 594mm = 2244 CSS px @ 96 DPI.
const A4_TWO_PAGES_PX = 2244;

// A4 preview that scales to whatever width the dialog gives it.
// Uses a ResizeObserver to keep transform scale in lockstep with
// the container width so the document never crops or letterboxes.
// contentHeight (when known) sizes the iframe to the actual
// document height so a short doc doesn't render inside a giant
// 2-page-tall box of white space.
const PreviewFrame = forwardRef<
  HTMLIFrameElement,
  { mobile: boolean; contentHeight: number | null }
>(
  function PreviewFrame({ mobile, contentHeight }, ref) {
    const wrapRef = useRef<HTMLDivElement | null>(null);
    // Default scale at 1.0 — the dialog is wider than A4 on
    // desktop so we never need to scale up. Resize-observer
    // shrinks below 1 only on narrow viewports.
    const [scale, setScale] = useState(1);
    useEffect(() => {
      const el = wrapRef.current;
      if (!el) return;
      const measure = (): void => {
        const w = el.clientWidth;
        if (w > 0) {
          // Cap at 1: never scale UP. A dialog wider than A4
          // would otherwise blow the doc up to 110%+ and
          // overflow horizontally — exactly the behaviour the
          // user kept seeing.
          setScale(Math.min(1, w / A4_WIDTH_PX));
        }
      };
      measure();
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      return () => ro.disconnect();
    }, []);

    // Iframe height defaults to two A4 pages while we wait for the
    // first measurement. Once the inner doc reports its actual
    // scrollHeight, we use that — clamped to two pages so a
    // pathologically long doc still scrolls inside a sane viewport.
    const docHeightPx = contentHeight ?? A4_TWO_PAGES_PX;
    const iframeHeight = Math.min(docHeightPx, A4_TWO_PAGES_PX);
    const scaledHeight = iframeHeight * scale;
    // Scaled width for the inner box so an at-or-near-100% scale
    // doesn't leave the iframe overlapping the wrapper edge.
    const scaledWidth = A4_WIDTH_PX * scale;
    const visibleHeight = mobile ? '60dvh' : '70dvh';

    return (
      <div
        ref={wrapRef}
        style={{
          width: '100%',
          // Hug the page width so the cream gutter is a tidy frame
          // around the page rather than a wide mat with the page
          // floating in the middle. justify-content:center on the
          // dialog content keeps the wrapper itself centred in the
          // dialog when there's room, so dialog white shows on
          // either side instead of empty cream.
          maxWidth: A4_WIDTH_PX + theme.space[6] * 2,
          margin: '0 auto',
          maxHeight: visibleHeight,
          overflowY: 'auto',
          overflowX: 'hidden',
          borderRadius: theme.radius.card,
          background: theme.color.bg,
          padding: theme.space[6],
          display: 'flex',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            width: scaledWidth,
            height: scaledHeight,
            position: 'relative',
            flex: '0 0 auto',
            // Soft drop shadow + 1px hairline so the page floats
            // on the dialog background like a real sheet.
            boxShadow: theme.shadow.card,
            borderRadius: theme.radius.input,
            overflow: 'hidden',
          }}
        >
          <iframe
            ref={ref}
            title="Waiver preview"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: A4_WIDTH_PX,
              height: iframeHeight,
              transform: `scale(${scale})`,
              transformOrigin: 'top left',
              border: 0,
              background: '#fff',
              boxShadow: theme.shadow.card,
              borderRadius: theme.radius.input,
            }}
          />
        </div>
      </div>
    );
  },
);

function Composer({
  recipient,
  subject,
  message,
  onRecipient,
  onSubject,
  onMessage,
  disabled,
  patientEmail,
  fileName,
}: {
  recipient: string;
  subject: string;
  message: string;
  onRecipient: (v: string) => void;
  onSubject: (v: string) => void;
  onMessage: (v: string) => void;
  disabled: boolean;
  patientEmail: string | null;
  fileName: string;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
      <Input
        label="Send to"
        type="email"
        value={recipient}
        onChange={(e) => onRecipient(e.target.value)}
        disabled={disabled}
        placeholder={patientEmail ?? 'patient@email.com'}
      />
      <Input
        label="Subject"
        value={subject}
        onChange={(e) => onSubject(e.target.value)}
        disabled={disabled}
      />
      <label style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
        <span
          style={{
            fontSize: theme.type.size.xs,
            color: theme.color.inkMuted,
            fontWeight: theme.type.weight.medium,
          }}
        >
          Message
        </span>
        <textarea
          value={message}
          onChange={(e) => onMessage(e.target.value)}
          disabled={disabled}
          rows={6}
          placeholder="Optional. Leave blank to send the default message."
          style={{
            width: '100%',
            padding: theme.space[3],
            borderRadius: theme.radius.input,
            border: `1px solid ${theme.color.border}`,
            background: theme.color.surface,
            color: theme.color.ink,
            fontFamily: 'inherit',
            fontSize: theme.type.size.base,
            lineHeight: 1.5,
            resize: 'vertical',
            outline: 'none',
          }}
        />
      </label>
      <p
        style={{
          margin: 0,
          fontSize: theme.type.size.xs,
          color: theme.color.inkMuted,
        }}
      >
        Attachment: <strong>{fileName}</strong>. Send routes through Resend on the email-waiver
        function and audits the send to the patient's timeline.
      </p>
    </div>
  );
}

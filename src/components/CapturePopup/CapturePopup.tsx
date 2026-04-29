import { type ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Camera, Image as ImageIcon, X } from 'lucide-react';
import { theme } from '../../theme/index.ts';

// Shared "Add a photo" capture flow used wherever a Lounge surface
// needs to upload a photo.
//
// Two intents in one component:
//   1. "Take a photo" — opens an in-app <video> driven by getUserMedia,
//      with our own capture button and X close. Required because the
//      Samsung Knox kiosk cannot navigate back from the OS Camera app
//      once `<input capture>` launches it; we keep the camera inside
//      the web app.
//   2. "Choose from gallery" — triggers a hidden `<input type=file
//      accept="image/*">` so the OS file picker is the gallery
//      affordance.
//
// `useCaptureFlow` returns an `open()` to show the source sheet and a
// `node` to mount somewhere in the consumer's JSX (the source sheet
// and camera modal both portal to document.body, so the consumer's
// DOM placement doesn't matter, but the React tree position controls
// callback identity / ref ownership).

interface UseCaptureFlowOptions {
  label: string;
  // Single-file callback — fired once per camera capture or once per
  // gallery file picked. Multi-select gallery inputs call this for
  // each file in turn.
  onFile: (file: File) => void;
  // When false, gallery picks are limited to one file. When true,
  // the file picker allows multi-select. Camera always emits one.
  multiple?: boolean;
}

export interface CaptureFlowHandle {
  open: () => void;
  node: ReactNode;
}

export function useCaptureFlow({
  label,
  onFile,
  multiple = false,
}: UseCaptureFlowOptions): CaptureFlowHandle {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);

  const open = () => setSheetOpen(true);

  const node = (
    <>
      <input
        ref={galleryInputRef}
        type="file"
        accept="image/*"
        multiple={multiple}
        style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
        onChange={(e) => {
          const files = e.target.files ? Array.from(e.target.files) : [];
          // Reset the value so picking the same file twice in a row
          // still fires onChange.
          e.target.value = '';
          for (const f of files) onFile(f);
        }}
      />
      {sheetOpen ? (
        <PhotoSourceSheet
          label={label}
          onTakePhoto={() => {
            setSheetOpen(false);
            setCameraOpen(true);
          }}
          onChooseGallery={() => {
            setSheetOpen(false);
            galleryInputRef.current?.click();
          }}
          onClose={() => setSheetOpen(false)}
        />
      ) : null}
      {cameraOpen ? (
        <InAppCameraModal
          label={label}
          onCapture={(file) => {
            setCameraOpen(false);
            onFile(file);
          }}
          onClose={() => setCameraOpen(false)}
        />
      ) : null}
    </>
  );

  return { open, node };
}

// ─── Internals ──────────────────────────────────────────────────────────────

// Locks the page-scroll container (#root) while a popup is open.
// The body is pinned at all times by globalStyles to suppress the
// iOS rubber-band; the real scroll element is #root, so that's
// what we toggle here.
function useLockBodyScroll(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const root = document.getElementById('root');
    const original = root?.style.overflow ?? '';
    if (root) root.style.overflow = 'hidden';
    return () => {
      if (root) root.style.overflow = original;
    };
  }, [active]);
}

function PhotoSourceSheet({
  label,
  onTakePhoto,
  onChooseGallery,
  onClose,
}: {
  label: string;
  onTakePhoto: () => void;
  onChooseGallery: () => void;
  onClose: () => void;
}) {
  useLockBodyScroll(true);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const node = (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Add a photo for ${label}`}
      onClick={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: theme.color.overlay,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: theme.space[4],
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: theme.color.surface,
          borderRadius: theme.radius.card,
          width: 'min(420px, 100%)',
          padding: `${theme.space[5]}px ${theme.space[5]}px ${theme.space[4]}px`,
          boxShadow: theme.shadow.overlay,
          display: 'flex',
          flexDirection: 'column',
          gap: theme.space[3],
          position: 'relative',
        }}
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          aria-label="Close"
          style={{
            position: 'absolute',
            top: theme.space[2],
            right: theme.space[2],
            appearance: 'none',
            border: 'none',
            background: 'transparent',
            padding: theme.space[2],
            borderRadius: theme.radius.pill,
            color: theme.color.inkMuted,
            cursor: 'pointer',
            display: 'inline-flex',
          }}
        >
          <X size={18} />
        </button>
        <div>
          <h2
            style={{
              margin: 0,
              fontSize: theme.type.size.lg,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
              letterSpacing: theme.type.tracking.tight,
            }}
          >
            Add a photo
          </h2>
          <p
            style={{
              margin: `${theme.space[1]}px 0 0`,
              fontSize: theme.type.size.sm,
              color: theme.color.inkMuted,
            }}
          >
            {label}
          </p>
        </div>
        <SourceButton
          icon={<Camera size={20} />}
          title="Take a photo"
          subtitle="Use the device camera"
          onClick={(e) => {
            e.stopPropagation();
            onTakePhoto();
          }}
        />
        <SourceButton
          icon={<ImageIcon size={20} />}
          title="Choose from gallery"
          subtitle="Pick an existing photo"
          onClick={(e) => {
            e.stopPropagation();
            onChooseGallery();
          }}
        />
      </div>
    </div>
  );

  return createPortal(node, document.body);
}

function SourceButton({
  icon,
  title,
  subtitle,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  onClick: (e: React.MouseEvent) => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: theme.space[3],
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
        borderRadius: theme.radius.card,
        border: `1px solid ${hover ? theme.color.ink : theme.color.border}`,
        background: hover ? theme.color.bg : theme.color.surface,
        color: theme.color.ink,
        cursor: 'pointer',
        fontFamily: 'inherit',
        textAlign: 'left',
        transition: `border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 40,
          height: 40,
          borderRadius: '50%',
          background: theme.color.accentBg,
          color: theme.color.accent,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        {icon}
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: theme.type.size.base, fontWeight: theme.type.weight.semibold }}>
          {title}
        </span>
        <span style={{ fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
          {subtitle}
        </span>
      </span>
    </button>
  );
}

// ─── In-app camera modal ────────────────────────────────────────────────────
//
// Live camera feed via getUserMedia, rendered into a popup window with a
// capture button and an X close. Required because the Samsung Knox kiosk
// can't navigate back from the OS Camera app once `<input capture>`
// launches it — we keep the camera inside the Lounge web app.
//
// Stream lifecycle: requested on mount, stopped on unmount + on capture.
// Falls back to the front camera if 'environment' is unavailable. Capture
// draws the current video frame to an offscreen canvas, encodes JPEG at
// 0.92, and hands the resulting File to onCapture.

function InAppCameraModal({
  label,
  onCapture,
  onClose,
}: {
  label: string;
  onCapture: (file: File) => void;
  onClose: () => void;
}) {
  useLockBodyScroll(true);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('This device does not expose a camera to the browser.');
        return;
      }
      try {
        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: { ideal: 'environment' },
              width: { ideal: 1920 },
              height: { ideal: 1080 },
            },
            audio: false,
          });
        } catch {
          stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        }
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const v = videoRef.current;
        if (v) {
          v.srcObject = stream;
          await v.play().catch(() => undefined);
          setReady(true);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Could not access the camera';
        setError(
          /denied|notallowed/i.test(msg)
            ? 'Camera permission denied. Allow camera access for this site, then try again.'
            : msg
        );
      }
    })();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, []);

  const handleCapture = async () => {
    const v = videoRef.current;
    if (!v || !ready || busy) return;
    setBusy(true);
    const w = v.videoWidth;
    const h = v.videoHeight;
    if (!w || !h) {
      setBusy(false);
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      setBusy(false);
      return;
    }
    ctx.drawImage(v, 0, 0, w, h);
    const blob: Blob | null = await new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.92)
    );
    if (!blob) {
      setBusy(false);
      return;
    }
    const filename = `${label.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${Date.now()}.jpg`;
    const file = new File([blob], filename, { type: 'image/jpeg' });
    onCapture(file);
  };

  const node = (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Take a photo for ${label}`}
      onClick={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: '#0E1414',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: theme.space[4],
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'relative',
          width: 'min(720px, 100%)',
          maxHeight: '100%',
          borderRadius: 16,
          overflow: 'hidden',
          background: '#0E1414',
          boxShadow: '0 24px 80px -16px rgba(0, 0, 0, 0.55)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: `${theme.space[3]}px ${theme.space[4]}px`,
            color: '#fff',
            background: 'rgba(0,0,0,0.3)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span style={{ fontSize: theme.type.size.base, fontWeight: theme.type.weight.semibold, color: '#fff' }}>
              Take a photo
            </span>
            <span style={{ fontSize: theme.type.size.xs, color: 'rgba(255,255,255,0.7)' }}>
              {label}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close camera"
            style={{
              appearance: 'none',
              width: 36,
              height: 36,
              borderRadius: 10,
              background: 'rgba(255,255,255,0.08)',
              border: '1px solid rgba(255,255,255,0.12)',
              color: '#fff',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <X size={18} />
          </button>
        </header>

        <div
          style={{
            position: 'relative',
            background: '#000',
            aspectRatio: '4 / 3',
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              opacity: ready ? 1 : 0,
              transition: 'opacity 200ms ease',
            }}
          />
          {!ready && !error ? (
            <span
              aria-live="polite"
              style={{
                position: 'absolute',
                color: 'rgba(255,255,255,0.7)',
                fontSize: theme.type.size.sm,
              }}
            >
              Starting camera…
            </span>
          ) : null}
          {error ? (
            <div
              role="alert"
              style={{
                position: 'absolute',
                inset: theme.space[4],
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#fff',
                background: 'rgba(220,38,38,0.85)',
                borderRadius: 12,
                padding: theme.space[4],
                fontSize: theme.type.size.sm,
                lineHeight: 1.4,
                textAlign: 'center',
              }}
            >
              {error}
            </div>
          ) : null}
        </div>

        <footer
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: theme.space[3],
            padding: theme.space[4],
            background: 'rgba(0,0,0,0.3)',
          }}
        >
          <button
            type="button"
            onClick={handleCapture}
            disabled={!ready || busy || !!error}
            aria-label="Capture photo"
            style={{
              appearance: 'none',
              width: 72,
              height: 72,
              borderRadius: '50%',
              background: '#fff',
              border: '4px solid rgba(255,255,255,0.4)',
              cursor: ready && !busy && !error ? 'pointer' : 'not-allowed',
              opacity: ready && !error ? 1 : 0.5,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
              transition: 'transform 120ms ease',
            }}
            onMouseDown={(e) => {
              (e.currentTarget as HTMLButtonElement).style.transform = 'scale(0.94)';
            }}
            onMouseUp={(e) => {
              (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1)';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1)';
            }}
          >
            <span
              aria-hidden
              style={{
                width: 56,
                height: 56,
                borderRadius: '50%',
                background: '#fff',
                border: '2px solid #0E1414',
              }}
            />
          </button>
        </footer>
      </div>
    </div>
  );

  return createPortal(node, document.body);
}

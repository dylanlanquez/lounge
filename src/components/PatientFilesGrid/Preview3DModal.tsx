import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { PanelLeft, Settings2, X } from 'lucide-react';
import { ModelViewer } from './ModelViewer.tsx';
import {
  LIGHT_BOTTOM_VARIANTS,
  PREVIEW_BACKGROUND_OPTIONS,
  PreviewBackground,
  type PreviewBackgroundVariant,
} from './PreviewBackground.tsx';
import type { PatientFileEntry, PatientProfileRow } from '../../lib/queries/patientProfile.ts';
import { properCase } from '../../lib/queries/appointments.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Preview3DModal — popup STL / OBJ / PLY viewer.
//
// Layout copied from Meridian's FilePreviewModal:
//  - Transparent WebGL canvas with a CSS PreviewBackground div behind it
//    so animated variants don't compete with the three.js render loop.
//  - Streaming progress card centred while the file downloads.
//  - Left flyout: patient identity + file metadata. Open by default.
//  - Right flyout: viewport settings — draggable LightBall, intensity,
//    mesh colour, background variant + optional custom hex. Closed by
//    default. Persists to localStorage.
//  - Both panels are *always mounted* — open / close is opacity + a
//    scale-from-corner transform so the affordance reads as "the button
//    grows into the panel" rather than a hard mount/unmount snap. The
//    toggle button shares the same corner; when the panel is open the
//    button fades to 0 and the panel's internal X close takes over.
// ─────────────────────────────────────────────────────────────────────────────

type ModelExt = 'stl' | 'obj' | 'ply';

const QUIRKY_LINES = [
  'Counting molars, one by one',
  'Polishing the polygons',
  'Aligning the bite',
  'Brushing the cusps',
  'Stitching the mesh together',
  'Polishing the enamel',
  'Centering the smile',
  'Levelling the occlusal plane',
];

// Bumped from v2 → v3 because the settings shape changed: `keyDirection`
// became `lightDir` + `lightBehind`. Older payloads are migrated in
// loadSettings rather than discarded so a returning user keeps the rest
// of their preferences.
const STORAGE_KEY = 'lng.preview3d.settings.v3';
const LEGACY_STORAGE_KEY = 'lng.preview3d.settings.v2';

interface ViewportSettings {
  background: PreviewBackgroundVariant;
  customColor: string; // empty string = no custom
  meshColor: string;
  intensity: number;
  lightDir: { x: number; y: number };
  lightBehind: boolean;
}

const DEFAULT_SETTINGS: ViewportSettings = {
  background: 'studio',
  customColor: '',
  meshColor: '#ffffff',
  intensity: 0.85,
  lightDir: { x: 0.6, y: -0.45 },
  lightBehind: false,
};

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

function loadSettings(): ViewportSettings {
  try {
    const raw =
      localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<ViewportSettings> & {
      keyDirection?: 'front' | 'back';
    };
    const validBg = PREVIEW_BACKGROUND_OPTIONS.some((o) => o.value === parsed.background)
      ? (parsed.background as PreviewBackgroundVariant)
      : DEFAULT_SETTINGS.background;
    const dir = parsed.lightDir;
    const lightDir =
      dir && typeof dir.x === 'number' && typeof dir.y === 'number'
        ? { x: clamp(dir.x, -1, 1), y: clamp(dir.y, -1, 1) }
        : DEFAULT_SETTINGS.lightDir;
    const lightBehind =
      typeof parsed.lightBehind === 'boolean'
        ? parsed.lightBehind
        : parsed.keyDirection === 'back';
    return {
      background: validBg,
      customColor: typeof parsed.customColor === 'string' ? parsed.customColor : '',
      meshColor: typeof parsed.meshColor === 'string' ? parsed.meshColor : DEFAULT_SETTINGS.meshColor,
      intensity:
        typeof parsed.intensity === 'number' && parsed.intensity >= 0 && parsed.intensity <= 2
          ? parsed.intensity
          : DEFAULT_SETTINGS.intensity,
      lightDir,
      lightBehind,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(s: ViewportSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // Quota or private mode — settings just won't persist.
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

// Decide whether the chrome (close button, hint text) should render
// in light or dark tone. The custom hex wins if it's set; otherwise
// we infer from the variant. The light-bottom variants are listed
// in PreviewBackground; everything else is dark-toned chrome.
function isLightBg(s: ViewportSettings): boolean {
  if (s.customColor && HEX_RE.test(s.customColor)) {
    return isLightHex(s.customColor);
  }
  return LIGHT_BOTTOM_VARIANTS.has(s.background);
}

function isLightHex(hex: string): boolean {
  const m = hex.replace('#', '');
  const full = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 160;
}

export function Preview3DModal({
  file,
  ext,
  fileUrl,
  patient,
  onClose,
}: {
  file: PatientFileEntry;
  ext: ModelExt;
  // Null while the signed URL is still resolving — we still render the
  // sized popup shell so the user doesn't see a fullscreen black flash.
  fileUrl: string | null;
  patient: PatientProfileRow | null;
  onClose: () => void;
}) {
  const [loaded, setLoadedBytes] = useState(0);
  const [total, setTotalBytes] = useState(0);
  const [done, setDone] = useState(false);
  // Both panels closed by default. Toggle buttons stay hidden until the
  // file has fully loaded (`done`), so the chrome is empty during the
  // loading card and only appears with the rendered mesh.
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [settings, setSettings] = useState<ViewportSettings>(() => loadSettings());

  const [quirkIdx, setQuirkIdx] = useState(0);
  useEffect(() => {
    if (done) return;
    const id = setInterval(() => setQuirkIdx((i) => (i + 1) % QUIRKY_LINES.length), 1700);
    return () => clearInterval(id);
  }, [done]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
    saveSettings(settings);
  }, [settings]);

  const percent = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : done ? 100 : 0;
  const onLightBg = isLightBg(settings);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={file.file_name}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 200,
        background: 'rgba(10, 24, 48, 0.40)',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'relative',
          width: 'min(1200px, 100%)',
          height: 'min(800px, 100%)',
          borderRadius: 16,
          overflow: 'hidden',
          boxShadow: '0 24px 80px -16px rgba(0, 0, 0, 0.55)',
          background: '#000',
        }}
      >
        <PreviewBackground
          variant={settings.background}
          customColor={settings.customColor || null}
          filename={file.file_name}
        />

        {/* ModelViewer only mounts once the signed URL is ready. While
            it's resolving the outer popup shell + loading card are
            already on screen, so the user sees a sized window from the
            very first frame instead of a fullscreen black flash. */}
        {fileUrl ? (
          <div style={{ position: 'absolute', inset: 0, zIndex: 2 }}>
            <ModelViewer
              url={fileUrl}
              ext={ext}
              meshColor={settings.meshColor}
              intensity={settings.intensity}
              lightDir={settings.lightDir}
              lightBehind={settings.lightBehind}
              onProgress={(l, t) => {
                setLoadedBytes(l);
                setTotalBytes(t);
              }}
              onLoaded={() => setDone(true)}
            />
          </div>
        ) : null}

        {/* Close button — top-left, always visible. */}
        <div style={{ position: 'absolute', top: 16, left: 16, zIndex: 6 }}>
          <IconBtn
            tone={onLightBg ? 'onLight' : 'onDark'}
            ariaLabel="Close preview"
            onClick={onClose}
          >
            <X size={18} />
          </IconBtn>
        </div>

        {/* Left toggle button — sits below the close button. Fades out
            and scales down when the panel opens; the panel itself
            scales up from the same corner on top of it. */}
        <CornerToggle
          corner="topLeft"
          offsetTop={64}
          open={leftOpen}
          tone={onLightBg ? 'onLight' : 'onDark'}
          ariaLabel="Show patient details"
          onClick={() => setLeftOpen(true)}
          disabled={!done}
        >
          <PanelLeft size={18} />
        </CornerToggle>

        {/* Right toggle button — top-right corner, mirror of Meridian's
            display-settings button. */}
        <CornerToggle
          corner="topRight"
          offsetTop={16}
          open={rightOpen}
          tone={onLightBg ? 'onLight' : 'onDark'}
          ariaLabel="Show viewport settings"
          onClick={() => setRightOpen(true)}
          disabled={!done}
        >
          <Settings2 size={18} />
        </CornerToggle>

        {!done ? (
          <LoadingCard
            percent={percent}
            loaded={loaded}
            total={total}
            quirk={QUIRKY_LINES[quirkIdx]!}
            onLightBg={onLightBg}
          />
        ) : null}

        {/* Both panels are always mounted once the file has loaded; we
            animate them in / out via opacity + scale rather than mount
            churn. They only mount AFTER `done` so they don't sit over
            the loading card. */}
        {done ? (
          <PatientPanel
            file={file}
            patient={patient}
            onLightBg={onLightBg}
            open={leftOpen}
            onClose={() => setLeftOpen(false)}
          />
        ) : null}

        {done ? (
          <ViewportPanel
            settings={settings}
            onChange={setSettings}
            onLightBg={onLightBg}
            open={rightOpen}
            onClose={() => setRightOpen(false)}
          />
        ) : null}

        {done ? (
          <div
            aria-hidden
            style={{
              position: 'absolute',
              bottom: 16,
              left: 0,
              right: 0,
              textAlign: 'center',
              fontSize: 12,
              color: onLightBg ? 'rgba(14,20,20,0.55)' : 'rgba(255,255,255,0.55)',
              pointerEvents: 'none',
              zIndex: 3,
            }}
          >
            Drag to rotate · Scroll to zoom · Right click to pan
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ─── Loading card ──────────────────────────────────────────────────────────

function LoadingCard({
  percent,
  loaded,
  total,
  quirk,
  onLightBg,
}: {
  percent: number;
  loaded: number;
  total: number;
  quirk: string;
  onLightBg: boolean;
}) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'none',
        zIndex: 3,
      }}
    >
      <div
        style={{
          minWidth: 320,
          maxWidth: '90vw',
          background: onLightBg ? 'rgba(255, 255, 255, 0.94)' : 'rgba(20, 22, 28, 0.92)',
          border: `1px solid ${onLightBg ? 'rgba(14,20,20,0.06)' : 'rgba(255,255,255,0.06)'}`,
          borderRadius: 12,
          padding: '20px 24px',
          boxShadow: '0 12px 32px rgba(0, 0, 0, 0.45)',
          color: onLightBg ? '#0E1414' : '#fff',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 600 }}>{quirk}</span>
          <span
            style={{
              fontSize: 13,
              fontWeight: 500,
              color: onLightBg ? 'rgba(14,20,20,0.6)' : 'rgba(255,255,255,0.6)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {percent}%
          </span>
        </div>
        <div
          style={{
            height: 4,
            width: '100%',
            background: onLightBg ? 'rgba(14,20,20,0.12)' : 'rgba(255,255,255,0.12)',
            borderRadius: 999,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${percent}%`,
              height: '100%',
              background: '#0891b2',
              transition: 'width 180ms linear',
            }}
          />
        </div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: 12,
            color: onLightBg ? 'rgba(14,20,20,0.55)' : 'rgba(255,255,255,0.55)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          <span>
            {total > 0 ? `${formatBytes(loaded)} of ${formatBytes(total)}` : `${formatBytes(loaded)} downloaded`}
          </span>
          <span>{percent >= 95 ? 'Almost done' : percent > 60 ? 'Hang tight' : 'Streaming'}</span>
        </div>
      </div>
    </div>
  );
}

// ─── Left flyout ────────────────────────────────────────────────────────────

function PatientPanel({
  file,
  patient,
  onLightBg,
  open,
  onClose,
}: {
  file: PatientFileEntry;
  patient: PatientProfileRow | null;
  onLightBg: boolean;
  open: boolean;
  onClose: () => void;
}) {
  const ink = onLightBg ? '#0E1414' : '#fff';
  const muted = onLightBg ? 'rgba(14,20,20,0.55)' : 'rgba(255,255,255,0.55)';
  const eyebrow = onLightBg ? 'rgba(14,20,20,0.4)' : 'rgba(255,255,255,0.4)';
  const divider = onLightBg ? 'rgba(14,20,20,0.1)' : 'rgba(255,255,255,0.1)';

  const patientName = patient
    ? `${properCase(patient.first_name ?? '')} ${properCase(patient.last_name ?? '')}`.trim() || 'Patient'
    : 'Patient';
  const dob = patient?.date_of_birth ? formatDob(patient.date_of_birth) : null;
  const allergies = (patient?.allergies ?? '').trim();
  const notes = (patient?.notes ?? '').trim();

  return (
    <aside
      aria-hidden={!open}
      style={{
        position: 'absolute',
        // Anchored at the toggle-button corner (top:64 left:16). We
        // intentionally don't bind the bottom edge — the panel sizes
        // itself to its content and only scrolls if it grows past the
        // available height. The close X above (top:16) lives on its
        // own z-stack tier so the panel never covers it.
        top: 64,
        left: 16,
        width: 300,
        maxHeight: 'calc(100% - 80px)',
        zIndex: 5,
        background: onLightBg ? 'rgba(255, 255, 255, 0.94)' : 'rgba(15, 17, 22, 0.92)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        border: `1px solid ${onLightBg ? 'rgba(14,20,20,0.06)' : 'rgba(255,255,255,0.06)'}`,
        borderRadius: 12,
        boxShadow: '0 16px 40px rgba(0,0,0,0.32)',
        padding: '20px 22px',
        color: ink,
        display: 'flex',
        flexDirection: 'column',
        gap: 18,
        overflowY: 'auto',
        opacity: open ? 1 : 0,
        transform: open ? 'scale(1)' : 'scale(0.22)',
        transformOrigin: 'top left',
        pointerEvents: open ? 'auto' : 'none',
        transition: 'opacity 220ms ease, transform 260ms cubic-bezier(0.4, 0, 0.2, 1)',
      }}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Hide patient panel"
        style={{
          position: 'absolute',
          top: 12,
          right: 12,
          appearance: 'none',
          border: 'none',
          background: 'transparent',
          color: muted,
          cursor: 'pointer',
          padding: 4,
          borderRadius: 999,
          display: 'inline-flex',
        }}
      >
        <X size={16} />
      </button>

      <div>
        <PanelEyebrow color={eyebrow}>Patient</PanelEyebrow>
        <p style={{ margin: '4px 0 0', fontSize: 16, fontWeight: 600 }}>{patientName}</p>
        {dob ? <p style={{ margin: '2px 0 0', fontSize: 13, color: muted }}>Born {dob}</p> : null}
      </div>

      {allergies ? (
        <div>
          <PanelEyebrow color={eyebrow}>Flags</PanelEyebrow>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#e07b1a' }}>{allergies}</p>
        </div>
      ) : null}

      {notes ? (
        <div>
          <PanelEyebrow color={eyebrow}>Notes</PanelEyebrow>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: muted, whiteSpace: 'pre-wrap' }}>{notes}</p>
        </div>
      ) : null}

      <div style={{ height: 1, background: divider }} />

      <div>
        <p style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
          {file.label_display ?? 'File'}
          {file.version != null ? (
            <span style={{ fontWeight: 400, color: muted, marginLeft: 8 }}>v{file.version}</span>
          ) : null}
        </p>
        {file.label_display ? (
          <p style={{ margin: '4px 0 0', fontSize: 13, color: muted, lineHeight: 1.45 }}>
            A 3D scan of the patient's {file.label_display.toLowerCase()}.
          </p>
        ) : null}
        <p
          style={{
            margin: '8px 0 0',
            fontSize: 12,
            color: muted,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            wordBreak: 'break-all',
          }}
        >
          {file.file_name}
        </p>
      </div>

      <div style={{ height: 1, background: divider }} />

      <div>
        <PanelEyebrow color={eyebrow}>Uploaded</PanelEyebrow>
        {file.uploaded_by_name ? (
          <p style={{ margin: '4px 0 0', fontSize: 14, fontWeight: 500 }}>{file.uploaded_by_name}</p>
        ) : null}
        <p style={{ margin: '2px 0 0', fontSize: 13, color: muted }}>{formatLongDateTime(file.uploaded_at)}</p>
        {file.file_size_bytes ? (
          <p style={{ margin: '2px 0 0', fontSize: 13, color: muted }}>{formatBytes(file.file_size_bytes)}</p>
        ) : null}
      </div>
    </aside>
  );
}

function PanelEyebrow({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 600,
        color,
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
      }}
    >
      {children}
    </span>
  );
}

// ─── Right flyout: viewport settings ───────────────────────────────────────

function ViewportPanel({
  settings,
  onChange,
  onLightBg,
  open,
  onClose,
}: {
  settings: ViewportSettings;
  onChange: (next: ViewportSettings) => void;
  onLightBg: boolean;
  open: boolean;
  onClose: () => void;
}) {
  const ink = onLightBg ? '#0E1414' : '#fff';
  const muted = onLightBg ? 'rgba(14,20,20,0.55)' : 'rgba(255,255,255,0.55)';
  const eyebrow = onLightBg ? 'rgba(14,20,20,0.4)' : 'rgba(255,255,255,0.4)';
  const surfaceBorder = onLightBg ? 'rgba(14,20,20,0.1)' : 'rgba(255,255,255,0.14)';

  return (
    <aside
      aria-hidden={!open}
      style={{
        position: 'absolute',
        top: 16,
        right: 16,
        bottom: 16,
        width: 320,
        zIndex: 5,
        background: onLightBg ? 'rgba(255, 255, 255, 0.94)' : 'rgba(15, 17, 22, 0.92)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        border: `1px solid ${surfaceBorder}`,
        borderRadius: 12,
        boxShadow: '0 16px 40px rgba(0,0,0,0.32)',
        padding: '20px 22px',
        color: ink,
        display: 'flex',
        flexDirection: 'column',
        gap: 18,
        overflowY: 'auto',
        opacity: open ? 1 : 0,
        transform: open ? 'scale(1)' : 'scale(0.22)',
        transformOrigin: 'top right',
        pointerEvents: open ? 'auto' : 'none',
        transition: 'opacity 220ms ease, transform 260ms cubic-bezier(0.4, 0, 0.2, 1)',
      }}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close viewport settings"
        style={{
          position: 'absolute',
          top: 10,
          right: 10,
          appearance: 'none',
          border: 'none',
          background: 'transparent',
          color: muted,
          cursor: 'pointer',
          padding: 6,
          borderRadius: 8,
          display: 'inline-flex',
        }}
      >
        <X size={16} />
      </button>

      <div>
        <PanelEyebrow color={eyebrow}>Light direction</PanelEyebrow>
        <LightBall
          dir={settings.lightDir}
          behind={settings.lightBehind}
          onChange={(next) => onChange({ ...settings, lightDir: next })}
          onReset={() =>
            onChange({
              ...settings,
              lightDir: DEFAULT_SETTINGS.lightDir,
              lightBehind: DEFAULT_SETTINGS.lightBehind,
            })
          }
        />
        <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
          <Pill
            active={!settings.lightBehind}
            ink={ink}
            onClick={() => onChange({ ...settings, lightBehind: false })}
            title="Light in front of the model"
          >
            Front
          </Pill>
          <Pill
            active={settings.lightBehind}
            ink={ink}
            onClick={() => onChange({ ...settings, lightBehind: true })}
            title="Light behind the model"
          >
            Back
          </Pill>
        </div>
      </div>

      <div>
        <PanelEyebrow color={eyebrow}>Light intensity</PanelEyebrow>
        <input
          type="range"
          min={0}
          max={2}
          step={0.05}
          value={settings.intensity}
          onChange={(e) => onChange({ ...settings, intensity: Number(e.target.value) })}
          style={{ width: '100%', marginTop: 8, accentColor: '#0891b2' }}
        />
      </div>

      <div>
        <PanelEyebrow color={eyebrow}>Colour of the object</PanelEyebrow>
        <ColourSwatch
          value={settings.meshColor}
          onChange={(v) => onChange({ ...settings, meshColor: v })}
          ink={ink}
          surfaceBorder={surfaceBorder}
          onLightBg={onLightBg}
        />
      </div>

      <div>
        <PanelEyebrow color={eyebrow}>Colour of the background</PanelEyebrow>
        <Dropdown
          value={settings.background}
          onChange={(v) => onChange({ ...settings, background: v as PreviewBackgroundVariant })}
          options={PREVIEW_BACKGROUND_OPTIONS}
          onLightBg={onLightBg}
          ariaLabel="Background variant"
        />
      </div>

      <div>
        <PanelEyebrow color={eyebrow}>Custom background colour</PanelEyebrow>
        <CustomColourField
          value={settings.customColor || ''}
          onChange={(v) => onChange({ ...settings, customColor: v })}
          ink={ink}
          surfaceBorder={surfaceBorder}
          onLightBg={onLightBg}
        />
        <p style={{ margin: '6px 0 0', fontSize: 11, color: muted, lineHeight: 1.4 }}>
          Leave empty to use the preset above.
        </p>
      </div>
    </aside>
  );
}

// ─── LightBall — a 100×100 disc with a draggable dot. ──────────────────────

const BALL_SIZE = 100;
const BALL_RADIUS = BALL_SIZE / 2;
const DOT_RADIUS = 8;

function LightBall({
  dir,
  behind,
  onChange,
  onReset,
}: {
  dir: { x: number; y: number };
  behind: boolean;
  onChange: (next: { x: number; y: number }) => void;
  onReset: () => void;
}) {
  const ballRef = useRef<HTMLDivElement | null>(null);

  // Project the unit-disc light direction onto the visible disc.
  // Y goes up in world space but DOM y grows downward, so invert.
  const dotX = BALL_RADIUS + dir.x * (BALL_RADIUS - DOT_RADIUS - 2);
  const dotY = BALL_RADIUS - dir.y * (BALL_RADIUS - DOT_RADIUS - 2);

  const setFromEvent = (clientX: number, clientY: number) => {
    const el = ballRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cx = clientX - (rect.left + rect.width / 2);
    const cy = clientY - (rect.top + rect.height / 2);
    const r = BALL_RADIUS - DOT_RADIUS - 2;
    let x = cx / r;
    let y = -cy / r;
    const mag = Math.hypot(x, y);
    if (mag > 1) {
      x /= mag;
      y /= mag;
    }
    onChange({ x, y });
  };

  const startDrag = (e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    const isTouch = 'touches' in e;
    const evX = (ev: MouseEvent | TouchEvent): number =>
      'touches' in ev ? ev.touches[0]?.clientX ?? 0 : ev.clientX;
    const evY = (ev: MouseEvent | TouchEvent): number =>
      'touches' in ev ? ev.touches[0]?.clientY ?? 0 : ev.clientY;
    const initialX = isTouch ? e.touches[0]?.clientX ?? 0 : (e as React.MouseEvent).clientX;
    const initialY = isTouch ? e.touches[0]?.clientY ?? 0 : (e as React.MouseEvent).clientY;
    setFromEvent(initialX, initialY);
    const onMove = (ev: MouseEvent | TouchEvent) => setFromEvent(evX(ev), evY(ev));
    const onUp = () => {
      window.removeEventListener(isTouch ? 'touchmove' : 'mousemove', onMove as EventListener);
      window.removeEventListener(isTouch ? 'touchend' : 'mouseup', onUp);
    };
    window.addEventListener(isTouch ? 'touchmove' : 'mousemove', onMove as EventListener);
    window.addEventListener(isTouch ? 'touchend' : 'mouseup', onUp);
  };

  return (
    <div style={{ display: 'flex', justifyContent: 'center', marginTop: 10 }}>
      <div
        ref={ballRef}
        onMouseDown={startDrag}
        onTouchStart={startDrag}
        onDoubleClick={onReset}
        role="slider"
        aria-label="Light direction"
        aria-valuetext={`x ${dir.x.toFixed(2)}, y ${dir.y.toFixed(2)}`}
        title="Drag to reposition the light. Double-click to reset."
        style={{
          position: 'relative',
          width: BALL_SIZE,
          height: BALL_SIZE,
          borderRadius: '50%',
          background: behind
            ? 'radial-gradient(circle at 50% 50%, rgba(255,255,255,0.06), rgba(255,255,255,0.02) 55%, rgba(0,0,0,0.18) 100%)'
            : 'radial-gradient(circle at 32% 30%, rgba(255,255,255,0.42), rgba(255,255,255,0.08) 55%, rgba(0,0,0,0.18) 100%)',
          border: '1px solid rgba(255,255,255,0.14)',
          cursor: 'grab',
          boxShadow: 'inset 0 0 14px rgba(0,0,0,0.35)',
          touchAction: 'none',
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: dotX - DOT_RADIUS,
            top: dotY - DOT_RADIUS,
            width: DOT_RADIUS * 2,
            height: DOT_RADIUS * 2,
            borderRadius: '50%',
            background: behind ? 'rgba(255,255,255,0.4)' : '#fff',
            boxShadow: behind
              ? '0 1px 3px rgba(0,0,0,0.5)'
              : '0 0 12px rgba(255,255,255,0.6), 0 1px 3px rgba(0,0,0,0.5)',
            pointerEvents: 'none',
            transition:
              'left 60ms linear, top 60ms linear, background 200ms ease, box-shadow 200ms ease',
          }}
        />
      </div>
    </div>
  );
}

// ─── Pill button (Front / Back hemisphere toggle). ─────────────────────────

function Pill({
  active,
  ink,
  onClick,
  title,
  children,
}: {
  active: boolean;
  ink: string;
  onClick: () => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{
        flex: 1,
        appearance: 'none',
        height: 32,
        borderRadius: 999,
        background: active ? '#0891b2' : 'transparent',
        border: `1px solid ${active ? '#0891b2' : 'rgba(255,255,255,0.18)'}`,
        color: active ? '#fff' : ink,
        fontFamily: 'inherit',
        fontSize: 12,
        fontWeight: active ? 600 : 500,
        cursor: 'pointer',
        transition: 'background 150ms ease, border-color 150ms ease, color 150ms ease',
      }}
    >
      {children}
    </button>
  );
}

// ─── Colour swatch — borderless, click anywhere to open the picker. ───────

function ColourSwatch({
  value,
  onChange,
  ink,
  surfaceBorder,
  onLightBg,
}: {
  value: string;
  onChange: (v: string) => void;
  ink: string;
  surfaceBorder: string;
  onLightBg: boolean;
}) {
  const safe = HEX_RE.test(value) ? value : '#ffffff';
  return (
    <label
      title="Click to change colour"
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        marginTop: 8,
        padding: '8px 12px',
        borderRadius: 10,
        background: onLightBg ? 'rgba(14,20,20,0.04)' : 'rgba(255,255,255,0.06)',
        border: `1px solid ${surfaceBorder}`,
        cursor: 'pointer',
      }}
    >
      <span
        aria-hidden
        style={{
          width: 22,
          height: 22,
          borderRadius: 6,
          background: safe,
          flexShrink: 0,
          // No border on the swatch itself — Dylan's note: 'no border
          // around the colour indicator button'. Subtle inset shadow
          // gives it depth without adding a hard line.
          boxShadow:
            'inset 0 0 0 1px rgba(255,255,255,0.06), 0 1px 2px rgba(0,0,0,0.18)',
        }}
      />
      <span
        style={{
          flex: 1,
          color: ink,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: 13,
          letterSpacing: '0.02em',
        }}
      >
        {safe.toUpperCase()}
      </span>
      <input
        type="color"
        value={safe}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Pick a colour"
        style={{
          position: 'absolute',
          inset: 0,
          opacity: 0,
          cursor: 'pointer',
        }}
      />
    </label>
  );
}

// ─── Custom background colour — text + small swatch + Clear. ──────────────

function CustomColourField({
  value,
  onChange,
  ink,
  surfaceBorder,
  onLightBg,
}: {
  value: string;
  onChange: (v: string) => void;
  ink: string;
  surfaceBorder: string;
  onLightBg: boolean;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  const commit = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) {
      onChange('');
      return;
    }
    const withHash = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
    if (HEX_RE.test(withHash)) onChange(withHash.toLowerCase());
    else setDraft(value);
  };

  const safe = HEX_RE.test(value) ? value : '#0891b2';

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            (e.currentTarget as HTMLInputElement).blur();
          }
        }}
        placeholder="#0891b2"
        spellCheck={false}
        style={{
          flex: 1,
          minWidth: 0,
          padding: '6px 10px',
          borderRadius: 8,
          background: onLightBg ? 'rgba(14,20,20,0.04)' : 'rgba(0,0,0,0.35)',
          border: `1px solid ${surfaceBorder}`,
          color: ink,
          fontSize: 12,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          letterSpacing: '0.02em',
          outline: 'none',
        }}
      />
      <label
        title="Pick a colour"
        style={{
          position: 'relative',
          width: 32,
          height: 32,
          borderRadius: 8,
          background: safe,
          flexShrink: 0,
          cursor: 'pointer',
          boxShadow:
            'inset 0 0 0 1px rgba(255,255,255,0.06), 0 1px 2px rgba(0,0,0,0.18)',
        }}
      >
        <input
          type="color"
          value={safe}
          onChange={(e) => onChange(e.target.value.toLowerCase())}
          aria-label="Pick a custom background colour"
          style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }}
        />
      </label>
      {value ? (
        <button
          type="button"
          onClick={() => onChange('')}
          style={{
            background: 'transparent',
            border: 'none',
            color: '#0891b2',
            fontSize: 12,
            fontWeight: 500,
            cursor: 'pointer',
            padding: '0 4px',
            fontFamily: 'inherit',
          }}
        >
          Clear
        </button>
      ) : null}
    </div>
  );
}

// ─── Dropdown — custom popover, no native <select>. Mirrors Meridian's
// DropdownSelect dark-tone style: 14px-radius card on translucent surface,
// 13px 600 option rows, accent-coloured selected row. ──────────────────────

function Dropdown({
  value,
  onChange,
  options,
  onLightBg,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  onLightBg: boolean;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const selected = options.find((o) => o.value === value);
  const ink = onLightBg ? '#0E1414' : '#fff';
  const surface = onLightBg ? 'rgba(14,20,20,0.04)' : 'rgba(255,255,255,0.06)';
  const surfaceBorder = onLightBg ? 'rgba(14,20,20,0.1)' : 'rgba(255,255,255,0.14)';
  const popoverBg = onLightBg ? '#fff' : 'rgba(20, 22, 28, 0.96)';
  const popoverBorder = onLightBg ? 'rgba(14,20,20,0.08)' : 'rgba(255,255,255,0.08)';
  const rowHover = onLightBg ? 'rgba(14,20,20,0.04)' : 'rgba(255,255,255,0.06)';
  const muted = onLightBg ? 'rgba(14,20,20,0.55)' : 'rgba(255,255,255,0.55)';

  return (
    <div ref={wrapRef} style={{ position: 'relative', width: '100%', marginTop: 8 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          width: '100%',
          height: 38,
          padding: '0 12px',
          borderRadius: 10,
          background: surface,
          border: `1px solid ${open ? '#0891b2' : surfaceBorder}`,
          color: ink,
          fontFamily: 'inherit',
          fontSize: 13,
          fontWeight: 600,
          cursor: 'pointer',
          outline: 'none',
          transition: 'border-color 150ms ease',
        }}
      >
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {selected?.label ?? 'Select…'}
        </span>
        <svg
          width="10"
          height="6"
          viewBox="0 0 10 6"
          fill="none"
          style={{
            flexShrink: 0,
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 180ms ease',
          }}
        >
          <path
            d="M1 1L5 5L9 1"
            stroke={muted}
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open ? (
        <div
          role="listbox"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            left: 0,
            right: 0,
            maxHeight: 275,
            overflowX: 'hidden',
            overflowY: 'auto',
            background: popoverBg,
            border: `1px solid ${popoverBorder}`,
            borderRadius: 14,
            boxShadow: '0 12px 40px rgba(0,0,0,0.32), 0 4px 12px rgba(0,0,0,0.18)',
            padding: '6px 0',
            zIndex: 30,
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
          }}
        >
          {options.map((opt) => {
            const isSelected = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = rowHover;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = isSelected ? rowHover : 'transparent';
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  width: '100%',
                  padding: '9px 16px',
                  background: isSelected ? rowHover : 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 13,
                  fontWeight: isSelected ? 600 : 400,
                  color: isSelected ? '#0891b2' : ink,
                  fontFamily: 'inherit',
                  textAlign: 'left',
                  transition: 'background 100ms ease, color 100ms ease',
                }}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// ─── Corner toggle button — fades + scales out when its panel opens. ───────

function CornerToggle({
  corner,
  offsetTop,
  open,
  tone,
  ariaLabel,
  onClick,
  disabled,
  children,
}: {
  corner: 'topLeft' | 'topRight';
  offsetTop: number;
  open: boolean;
  tone: 'onDark' | 'onLight';
  ariaLabel: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  const onDark = tone === 'onDark';
  const positionStyle: CSSProperties =
    corner === 'topLeft'
      ? { left: 16 }
      : { right: 16 };
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      title={ariaLabel}
      onClick={open || disabled ? undefined : onClick}
      disabled={disabled}
      style={{
        position: 'absolute',
        top: offsetTop,
        ...positionStyle,
        zIndex: 4,
        width: 36,
        height: 36,
        borderRadius: 10,
        appearance: 'none',
        background: onDark ? 'rgba(255,255,255,0.08)' : 'rgba(14,20,20,0.06)',
        border: `1px solid ${onDark ? 'rgba(255,255,255,0.12)' : 'rgba(14,20,20,0.1)'}`,
        color: onDark ? '#fff' : '#0E1414',
        cursor: open || disabled ? 'default' : 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        opacity: disabled ? 0 : open ? 0 : 1,
        transform: open ? 'scale(0.92)' : 'scale(1)',
        pointerEvents: open || disabled ? 'none' : 'auto',
        transition:
          'opacity 180ms ease, transform 220ms cubic-bezier(0.4, 0, 0.2, 1), background 200ms ease',
      }}
    >
      {children}
    </button>
  );
}

// ─── Shared icon button (non-toggling — used by close X). ──────────────────

function IconBtn({
  tone,
  ariaLabel,
  onClick,
  children,
}: {
  tone: 'onDark' | 'onLight';
  ariaLabel: string;
  onClick: () => void;
  children: ReactNode;
}) {
  const onDark = tone === 'onDark';
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      title={ariaLabel}
      onClick={onClick}
      style={{
        appearance: 'none',
        width: 36,
        height: 36,
        borderRadius: 10,
        background: onDark ? 'rgba(255,255,255,0.08)' : 'rgba(14,20,20,0.06)',
        border: `1px solid ${onDark ? 'rgba(255,255,255,0.12)' : 'rgba(14,20,20,0.1)'}`,
        color: onDark ? '#fff' : '#0E1414',
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
      }}
    >
      {children}
    </button>
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatLongDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${date} at ${time} BST`;
}

function formatDob(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

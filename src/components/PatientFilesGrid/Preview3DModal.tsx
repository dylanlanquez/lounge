import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ChevronDown, PanelLeft, PanelRight, X } from 'lucide-react';
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
// Preview3DModal — fullscreen STL / OBJ / PLY viewer.
//
// Layout copied from Meridian's FilePreviewModal:
//  - Transparent WebGL canvas with a CSS PreviewBackground div behind it
//    so animated variants don't compete with the three.js render loop.
//  - Streaming progress card centred while the file downloads. Quirky
//    cycling copy + bytes + percent + 'Almost done' tail.
//  - Left flyout: patient identity + file metadata. Open by default.
//  - Right flyout: viewport settings (light direction, intensity, mesh
//    colour, background variant + optional custom hex). Closed by
//    default. Persists to localStorage so the receptionist's preferred
//    look follows them between previews.
//  - Toggle buttons sit at the corners. When a panel is open the button
//    hides — the panel itself owns the same corner with its own X
//    close, so the affordance reads as 'the panel slides out from where
//    the button was'.
//  - Bottom hint: 'Drag to rotate · Scroll to zoom · Right click to pan'.
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

const STORAGE_KEY = 'lng.preview3d.settings.v2';

interface ViewportSettings {
  background: PreviewBackgroundVariant;
  customColor: string; // empty string = no custom
  meshColor: string;
  intensity: number;
  keyDirection: 'front' | 'back';
}

const DEFAULT_SETTINGS: ViewportSettings = {
  background: 'dark',
  customColor: '',
  meshColor: '#6d9dc5',
  intensity: 0.85,
  keyDirection: 'front',
};

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

function loadSettings(): ViewportSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<ViewportSettings>;
    const validBg = PREVIEW_BACKGROUND_OPTIONS.some((o) => o.value === parsed.background)
      ? (parsed.background as PreviewBackgroundVariant)
      : DEFAULT_SETTINGS.background;
    return {
      background: validBg,
      customColor: typeof parsed.customColor === 'string' ? parsed.customColor : '',
      meshColor: typeof parsed.meshColor === 'string' ? parsed.meshColor : DEFAULT_SETTINGS.meshColor,
      intensity:
        typeof parsed.intensity === 'number' && parsed.intensity >= 0 && parsed.intensity <= 2
          ? parsed.intensity
          : DEFAULT_SETTINGS.intensity,
      keyDirection: parsed.keyDirection === 'back' ? 'back' : 'front',
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
  fileUrl: string;
  patient: PatientProfileRow | null;
  onClose: () => void;
}) {
  const [loaded, setLoadedBytes] = useState(0);
  const [total, setTotalBytes] = useState(0);
  const [done, setDone] = useState(false);
  const [leftOpen, setLeftOpen] = useState(true);
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
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 200,
        overflow: 'hidden',
        background: '#000',
      }}
    >
      <PreviewBackground
        variant={settings.background}
        customColor={settings.customColor || null}
        filename={file.file_name}
      />

      <div style={{ position: 'absolute', inset: 0, zIndex: 2 }}>
        <ModelViewer
          url={fileUrl}
          ext={ext}
          meshColor={settings.meshColor}
          intensity={settings.intensity}
          keyDirection={settings.keyDirection}
          onProgress={(l, t) => {
            setLoadedBytes(l);
            setTotalBytes(t);
          }}
          onLoaded={() => setDone(true)}
        />
      </div>

      {/* Top-left: close + left-panel toggle. Toggle hides while
          the left panel is open (the panel owns that corner). */}
      <div
        style={{
          position: 'absolute',
          top: 16,
          left: 16,
          zIndex: 4,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        <IconBtn tone={onLightBg ? 'onLight' : 'onDark'} ariaLabel="Close preview" onClick={onClose}>
          <X size={18} />
        </IconBtn>
        {!leftOpen && done ? (
          <IconBtn
            tone={onLightBg ? 'onLight' : 'onDark'}
            ariaLabel="Show patient panel"
            onClick={() => setLeftOpen(true)}
          >
            <PanelLeft size={18} />
          </IconBtn>
        ) : null}
      </div>

      {/* Top-right: viewport-panel toggle. Hidden while open. */}
      {!rightOpen ? (
        <div style={{ position: 'absolute', top: 16, right: 16, zIndex: 4 }}>
          <IconBtn
            tone={onLightBg ? 'onLight' : 'onDark'}
            ariaLabel="Show viewport settings"
            onClick={() => setRightOpen(true)}
          >
            <PanelRight size={18} />
          </IconBtn>
        </div>
      ) : null}

      {!done ? <LoadingCard percent={percent} loaded={loaded} total={total} quirk={QUIRKY_LINES[quirkIdx]!} onLightBg={onLightBg} /> : null}

      {done && leftOpen ? (
        <PatientPanel
          file={file}
          patient={patient}
          onLightBg={onLightBg}
          onClose={() => setLeftOpen(false)}
        />
      ) : null}

      {done && rightOpen ? (
        <ViewportPanel
          settings={settings}
          onChange={setSettings}
          onLightBg={onLightBg}
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
  onClose,
}: {
  file: PatientFileEntry;
  patient: PatientProfileRow | null;
  onLightBg: boolean;
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
      style={{
        position: 'absolute',
        // Top-left corner — same x/y as the close button so the panel
        // visually 'opens from' that toggle position.
        top: 16,
        left: 16,
        bottom: 16,
        width: 300,
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

function PanelEyebrow({ color, children }: { color: string; children: React.ReactNode }) {
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
  onClose,
}: {
  settings: ViewportSettings;
  onChange: (next: ViewportSettings) => void;
  onLightBg: boolean;
  onClose: () => void;
}) {
  const ink = onLightBg ? '#0E1414' : '#fff';
  const muted = onLightBg ? 'rgba(14,20,20,0.55)' : 'rgba(255,255,255,0.55)';
  const eyebrow = onLightBg ? 'rgba(14,20,20,0.4)' : 'rgba(255,255,255,0.4)';
  const surface = onLightBg ? 'rgba(14,20,20,0.06)' : 'rgba(255,255,255,0.06)';
  const surfaceBorder = onLightBg ? 'rgba(14,20,20,0.1)' : 'rgba(255,255,255,0.1)';

  const swatchHighlight = useMemo<CSSProperties>(() => {
    if (settings.keyDirection === 'back') {
      return {
        background:
          'radial-gradient(circle at 30% 30%, rgba(255,255,255,0.15) 0%, rgba(255,255,255,0) 55%), #1f2530',
      };
    }
    return {
      background:
        'radial-gradient(circle at 70% 30%, rgba(255,255,255,0.95) 0%, rgba(255,255,255,0.4) 25%, rgba(255,255,255,0) 60%), #1f2530',
    };
  }, [settings.keyDirection]);

  return (
    <aside
      style={{
        position: 'absolute',
        // Anchored to the same top-right corner as the toggle button.
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
      }}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Hide viewport settings"
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

      <div
        aria-hidden
        style={{
          width: 96,
          height: 96,
          borderRadius: '50%',
          alignSelf: 'center',
          border: `1px solid ${surfaceBorder}`,
          ...swatchHighlight,
        }}
      />

      <div style={{ display: 'flex', gap: 8 }}>
        <SegBtn
          active={settings.keyDirection === 'front'}
          onClick={() => onChange({ ...settings, keyDirection: 'front' })}
          ink={ink}
          surface={surface}
          surfaceBorder={surfaceBorder}
        >
          Front
        </SegBtn>
        <SegBtn
          active={settings.keyDirection === 'back'}
          onClick={() => onChange({ ...settings, keyDirection: 'back' })}
          ink={ink}
          surface={surface}
          surfaceBorder={surfaceBorder}
        >
          Back
        </SegBtn>
      </div>

      <div>
        <PanelEyebrow color={eyebrow}>Intensity</PanelEyebrow>
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
        <PanelEyebrow color={eyebrow}>Colour</PanelEyebrow>
        <ColourField
          value={settings.meshColor}
          onChange={(v) => onChange({ ...settings, meshColor: v })}
          ink={ink}
          surface={surface}
          surfaceBorder={surfaceBorder}
        />
      </div>

      <div>
        <PanelEyebrow color={eyebrow}>Background</PanelEyebrow>
        <DropdownNative
          value={settings.background}
          onChange={(v) => onChange({ ...settings, background: v as PreviewBackgroundVariant })}
          options={PREVIEW_BACKGROUND_OPTIONS}
          ink={ink}
          surface={surface}
          surfaceBorder={surfaceBorder}
        />
      </div>

      <div>
        <PanelEyebrow color={eyebrow}>Custom colour</PanelEyebrow>
        <ColourField
          value={settings.customColor || ''}
          placeholder="#0891b2"
          allowEmpty
          onChange={(v) => onChange({ ...settings, customColor: v })}
          ink={ink}
          surface={surface}
          surfaceBorder={surfaceBorder}
        />
        <p style={{ margin: '6px 0 0', fontSize: 11, color: muted, lineHeight: 1.4 }}>
          Leave empty to use the preset above.
        </p>
      </div>
    </aside>
  );
}

function SegBtn({
  active,
  onClick,
  children,
  ink,
  surface,
  surfaceBorder,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  ink: string;
  surface: string;
  surfaceBorder: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        flex: 1,
        appearance: 'none',
        height: 36,
        borderRadius: 999,
        background: active ? '#0891b2' : surface,
        border: `1px solid ${active ? '#0891b2' : surfaceBorder}`,
        color: active ? '#fff' : ink,
        fontFamily: 'inherit',
        fontSize: 13,
        fontWeight: active ? 600 : 500,
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

function ColourField({
  value,
  placeholder,
  allowEmpty,
  onChange,
  ink,
  surface,
  surfaceBorder,
}: {
  value: string;
  placeholder?: string;
  allowEmpty?: boolean;
  onChange: (v: string) => void;
  ink: string;
  surface: string;
  surfaceBorder: string;
}) {
  const swatchValue = HEX_RE.test(value) ? value : '#0891b2';
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        marginTop: 8,
        padding: '8px 10px',
        borderRadius: 10,
        background: surface,
        border: `1px solid ${surfaceBorder}`,
      }}
    >
      <input
        type="color"
        value={swatchValue}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: 28,
          height: 28,
          padding: 0,
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
        }}
      />
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          const v = e.target.value.trim();
          if (allowEmpty && v === '') {
            onChange('');
            return;
          }
          if (v.startsWith('#') || HEX_RE.test(v)) onChange(v);
        }}
        style={{
          flex: 1,
          border: 'none',
          outline: 'none',
          background: 'transparent',
          color: ink,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: 13,
        }}
      />
    </label>
  );
}

function DropdownNative({
  value,
  onChange,
  options,
  ink,
  surface,
  surfaceBorder,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  ink: string;
  surface: string;
  surfaceBorder: string;
}) {
  return (
    <div style={{ position: 'relative', marginTop: 8 }}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          appearance: 'none',
          width: '100%',
          height: 40,
          borderRadius: 10,
          padding: '0 36px 0 14px',
          fontFamily: 'inherit',
          fontSize: 14,
          fontWeight: 500,
          color: ink,
          background: surface,
          border: `1px solid ${surfaceBorder}`,
          cursor: 'pointer',
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown
        size={16}
        aria-hidden
        style={{
          position: 'absolute',
          right: 12,
          top: '50%',
          transform: 'translateY(-50%)',
          color: ink,
          opacity: 0.6,
          pointerEvents: 'none',
        }}
      />
    </div>
  );
}

// ─── Shared icon button ────────────────────────────────────────────────────

function IconBtn({
  tone,
  ariaLabel,
  onClick,
  children,
}: {
  tone: 'onDark' | 'onLight';
  ariaLabel: string;
  onClick: () => void;
  children: React.ReactNode;
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

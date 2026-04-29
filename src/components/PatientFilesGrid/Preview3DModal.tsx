import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ChevronDown, PanelLeft, PanelLeftClose, PanelRight, PanelRightClose, X } from 'lucide-react';
import { ModelViewer } from './ModelViewer.tsx';
import type { PatientFileEntry, PatientProfileRow } from '../../lib/queries/patientProfile.ts';
import { properCase } from '../../lib/queries/appointments.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Preview3DModal — fullscreen STL / OBJ / PLY viewer.
//
// Mirrors Meridian's FilePreviewModal chrome adapted for the Lounge
// kiosk: the receptionist taps a 3D file, the modal goes fullscreen
// over the page, a streaming progress card with quirky copy sits
// centred while the bytes come down, and once parsed the canvas
// reveals with two collapsible flyouts:
//   - Left: patient identity + file metadata.
//   - Right: viewport settings (background, intensity, mesh colour,
//     key-light position). Settings persist to localStorage so a
//     receptionist's preferred look follows them between previews.
//
// Lounge stays view-only: no download, no upload, no flag actions.
// Just the mesh + the metadata + the look.
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

const STORAGE_KEY = 'lng.preview3d.settings.v1';

interface ViewportSettings {
  background: string; // 'dark' | 'light' | hex
  meshColor: string;
  intensity: number;
  keyDirection: 'front' | 'back';
}

const DEFAULT_SETTINGS: ViewportSettings = {
  background: 'dark',
  meshColor: '#6d9dc5',
  intensity: 0.85,
  keyDirection: 'front',
};

function backgroundColor(setting: string): string {
  if (setting === 'dark') return '#0b0c0f';
  if (setting === 'light') return '#f5f6f8';
  return setting;
}

function isHexColor(s: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(s);
}

function loadSettings(): ViewportSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<ViewportSettings>;
    return {
      background: typeof parsed.background === 'string' ? parsed.background : DEFAULT_SETTINGS.background,
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
    // Quota or private mode — ignore. Settings just won't persist.
  }
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

  // Cycle quirky loading copy every 1.7s while the file streams.
  const [quirkIdx, setQuirkIdx] = useState(0);
  useEffect(() => {
    if (done) return;
    const id = setInterval(() => setQuirkIdx((i) => (i + 1) % QUIRKY_LINES.length), 1700);
    return () => clearInterval(id);
  }, [done]);

  // Esc closes the modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Persist settings whenever they change.
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
    saveSettings(settings);
  }, [settings]);

  const percent = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : done ? 100 : 0;
  const bg = backgroundColor(settings.background);
  // Pick a sensible text colour for the bottom hint based on
  // background luminance — looks bad to put dark text on dark bg
  // when the receptionist switches to light mode.
  const onDarkBg = settings.background === 'dark';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={file.file_name}
      style={{
        position: 'fixed',
        inset: 0,
        background: bg,
        zIndex: 200,
        overflow: 'hidden',
      }}
    >
      <ModelViewer
        url={fileUrl}
        ext={ext}
        background={bg}
        meshColor={settings.meshColor}
        intensity={settings.intensity}
        keyDirection={settings.keyDirection}
        onProgress={(l, t) => {
          setLoadedBytes(l);
          setTotalBytes(t);
        }}
        onLoaded={() => setDone(true)}
      />

      {/* Top-left close + left-panel toggle. Stack vertically so the
          two icon buttons don't compete for the same corner space. */}
      <div
        style={{
          position: 'absolute',
          top: 16,
          left: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          zIndex: 3,
        }}
      >
        <IconBtn
          tone={onDarkBg ? 'onDark' : 'onLight'}
          ariaLabel="Close preview"
          onClick={onClose}
        >
          <X size={18} />
        </IconBtn>
        <IconBtn
          tone={onDarkBg ? 'onDark' : 'onLight'}
          ariaLabel={leftOpen ? 'Hide patient panel' : 'Show patient panel'}
          onClick={() => setLeftOpen((o) => !o)}
        >
          {leftOpen ? <PanelLeftClose size={18} /> : <PanelLeft size={18} />}
        </IconBtn>
      </div>

      {/* Top-right viewport-panel toggle. */}
      <div style={{ position: 'absolute', top: 16, right: 16, zIndex: 3 }}>
        <IconBtn
          tone={onDarkBg ? 'onDark' : 'onLight'}
          ariaLabel={rightOpen ? 'Hide viewport settings' : 'Show viewport settings'}
          onClick={() => setRightOpen((o) => !o)}
        >
          {rightOpen ? <PanelRightClose size={18} /> : <PanelRight size={18} />}
        </IconBtn>
      </div>

      {/* Loading card — centred, only while bytes are streaming. */}
      {!done ? (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
            zIndex: 2,
          }}
        >
          <div
            style={{
              minWidth: 320,
              maxWidth: '90vw',
              background: onDarkBg ? 'rgba(20, 22, 28, 0.92)' : 'rgba(255, 255, 255, 0.94)',
              border: `1px solid ${onDarkBg ? 'rgba(255,255,255,0.06)' : 'rgba(14,20,20,0.06)'}`,
              borderRadius: 12,
              padding: '20px 24px',
              boxShadow: '0 12px 32px rgba(0, 0, 0, 0.45)',
              color: onDarkBg ? '#fff' : '#0E1414',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>{QUIRKY_LINES[quirkIdx]}</span>
              <span
                style={{
                  fontSize: 13,
                  fontWeight: 500,
                  color: onDarkBg ? 'rgba(255,255,255,0.6)' : 'rgba(14,20,20,0.6)',
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
                background: onDarkBg ? 'rgba(255,255,255,0.12)' : 'rgba(14,20,20,0.12)',
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
                color: onDarkBg ? 'rgba(255,255,255,0.55)' : 'rgba(14,20,20,0.55)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              <span>
                {total > 0
                  ? `${formatBytes(loaded)} of ${formatBytes(total)}`
                  : `${formatBytes(loaded)} downloaded`}
              </span>
              <span>{percent >= 95 ? 'Almost done' : percent > 60 ? 'Hang tight' : 'Streaming'}</span>
            </div>
          </div>
        </div>
      ) : null}

      {/* Left flyout: patient + file meta. Hidden until done so the
          loading card has the centre stage. */}
      {done && leftOpen ? (
        <PatientPanel
          file={file}
          patient={patient}
          onDarkBg={onDarkBg}
          onClose={() => setLeftOpen(false)}
        />
      ) : null}

      {done && rightOpen ? (
        <ViewportPanel
          settings={settings}
          onChange={setSettings}
          onDarkBg={onDarkBg}
          onClose={() => setRightOpen(false)}
        />
      ) : null}

      {/* Bottom hint — instructional, fades in once the mesh shows. */}
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
            color: onDarkBg ? 'rgba(255,255,255,0.55)' : 'rgba(14,20,20,0.55)',
            pointerEvents: 'none',
          }}
        >
          Drag to rotate · Scroll to zoom · Right click to pan
        </div>
      ) : null}
    </div>
  );
}

// ─── Left flyout ────────────────────────────────────────────────────────────

function PatientPanel({
  file,
  patient,
  onDarkBg,
  onClose,
}: {
  file: PatientFileEntry;
  patient: PatientProfileRow | null;
  onDarkBg: boolean;
  onClose: () => void;
}) {
  const ink = onDarkBg ? '#fff' : '#0E1414';
  const muted = onDarkBg ? 'rgba(255,255,255,0.55)' : 'rgba(14,20,20,0.55)';
  const eyebrow = onDarkBg ? 'rgba(255,255,255,0.4)' : 'rgba(14,20,20,0.4)';
  const divider = onDarkBg ? 'rgba(255,255,255,0.1)' : 'rgba(14,20,20,0.1)';

  const patientName = patient
    ? `${properCase(patient.first_name ?? '')} ${properCase(patient.last_name ?? '')}`.trim() ||
      'Patient'
    : 'Patient';
  const dob = patient?.date_of_birth ? formatDob(patient.date_of_birth) : null;
  const allergies = (patient?.allergies ?? '').trim();
  const notes = (patient?.notes ?? '').trim();

  return (
    <aside
      style={{
        position: 'absolute',
        top: 16,
        left: 64,
        bottom: 16,
        width: 300,
        zIndex: 2,
        background: onDarkBg ? 'rgba(15, 17, 22, 0.92)' : 'rgba(255, 255, 255, 0.94)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        border: `1px solid ${onDarkBg ? 'rgba(255,255,255,0.06)' : 'rgba(14,20,20,0.06)'}`,
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
          <p style={{ margin: '4px 0 0', fontSize: 13, color: muted, whiteSpace: 'pre-wrap' }}>
            {notes}
          </p>
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
        <p style={{ margin: '2px 0 0', fontSize: 13, color: muted }}>
          {formatLongDateTime(file.uploaded_at)}
        </p>
        {file.file_size_bytes ? (
          <p style={{ margin: '2px 0 0', fontSize: 13, color: muted }}>
            {formatBytes(file.file_size_bytes)}
          </p>
        ) : null}
      </div>

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
        <PanelLeftClose size={16} />
      </button>
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
  onDarkBg,
  onClose,
}: {
  settings: ViewportSettings;
  onChange: (next: ViewportSettings) => void;
  onDarkBg: boolean;
  onClose: () => void;
}) {
  const ink = onDarkBg ? '#fff' : '#0E1414';
  const muted = onDarkBg ? 'rgba(255,255,255,0.55)' : 'rgba(14,20,20,0.55)';
  const eyebrow = onDarkBg ? 'rgba(255,255,255,0.4)' : 'rgba(14,20,20,0.4)';
  const surface = onDarkBg ? 'rgba(255,255,255,0.06)' : 'rgba(14,20,20,0.06)';
  const surfaceBorder = onDarkBg ? 'rgba(255,255,255,0.1)' : 'rgba(14,20,20,0.1)';

  // Light-direction selector — preview swatch on top showing where
  // the highlight lands.
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
        top: 16,
        right: 64,
        bottom: 16,
        width: 320,
        zIndex: 2,
        background: onDarkBg ? 'rgba(15, 17, 22, 0.92)' : 'rgba(255, 255, 255, 0.94)',
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

      {/* Light direction preview swatch */}
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
          style={{
            width: '100%',
            marginTop: 8,
            accentColor: '#0891b2',
          }}
        />
      </div>

      <div>
        <PanelEyebrow color={eyebrow}>Colour</PanelEyebrow>
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
            value={settings.meshColor}
            onChange={(e) => onChange({ ...settings, meshColor: e.target.value })}
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
            value={settings.meshColor}
            onChange={(e) => {
              const v = e.target.value;
              if (isHexColor(v) || v.startsWith('#')) {
                onChange({ ...settings, meshColor: v });
              }
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
      </div>

      <div>
        <PanelEyebrow color={eyebrow}>Background</PanelEyebrow>
        <BackgroundSelect
          value={settings.background}
          onChange={(v) => onChange({ ...settings, background: v })}
          ink={ink}
          surface={surface}
          surfaceBorder={surfaceBorder}
        />
      </div>

      {!isPresetBackground(settings.background) ? (
        <div>
          <PanelEyebrow color={eyebrow}>Custom colour</PanelEyebrow>
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
              value={isHexColor(settings.background) ? settings.background : '#0891b2'}
              onChange={(e) => onChange({ ...settings, background: e.target.value })}
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
              value={settings.background}
              onChange={(e) => {
                const v = e.target.value.trim();
                if (v === '') {
                  onChange({ ...settings, background: 'dark' });
                  return;
                }
                if (isHexColor(v) || v.startsWith('#')) {
                  onChange({ ...settings, background: v });
                }
              }}
              placeholder="#0891b2"
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
          <p style={{ margin: '6px 0 0', fontSize: 11, color: muted, lineHeight: 1.4 }}>
            Leave empty to use the preset above.
          </p>
        </div>
      ) : null}
    </aside>
  );
}

function isPresetBackground(v: string): boolean {
  return v === 'dark' || v === 'light';
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

function BackgroundSelect({
  value,
  onChange,
  ink,
  surface,
  surfaceBorder,
}: {
  value: string;
  onChange: (v: string) => void;
  ink: string;
  surface: string;
  surfaceBorder: string;
}) {
  // Three options like Meridian — Dark, Light, Custom. Custom keeps
  // any hex the user previously typed; if they pick it from a preset
  // state we fall back to '#0891b2' so the swatch renders something.
  const isCustom = !isPresetBackground(value);
  const display = value === 'dark' ? 'Dark' : value === 'light' ? 'Light' : 'Custom';
  return (
    <div style={{ position: 'relative', marginTop: 8 }}>
      <select
        value={isCustom ? 'custom' : value}
        onChange={(e) => {
          const v = e.target.value;
          if (v === 'custom') {
            onChange(isHexColor(value) ? value : '#0891b2');
          } else {
            onChange(v);
          }
        }}
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
        <option value="dark">Dark</option>
        <option value="light">Light</option>
        <option value="custom">Custom</option>
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
      {/* Display label — hidden because select already shows it,
          kept here for future when we restyle as a custom dropdown. */}
      <span style={{ display: 'none' }}>{display}</span>
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

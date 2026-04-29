import { useEffect, useRef } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// PreviewBackground — renders behind the transparent WebGL canvas in the
// Preview3DModal. A flat custom hex (when provided) wins over the variant
// dropdown; otherwise the variant matches Meridian's FilePreviewModal one
// for one. All animation is CSS / DOM only so nothing competes with the
// three.js render loop.
//
// Ported faithfully from meridian-app FilePreviewModal.jsx so a
// receptionist who's used to Meridian sees the same scenes here.
// ─────────────────────────────────────────────────────────────────────────────

export type PreviewBackgroundVariant =
  | 'studio'
  | 'dark'
  | 'teal'
  | 'blueprint'
  | 'crt-terminal'
  | 'space'
  | 'nebula'
  | 'milky-way'
  | 'vaporwave'
  | 'matrix'
  | 'disco'
  | 'aquarium'
  | 'win95';

export const PREVIEW_BACKGROUND_OPTIONS: { value: PreviewBackgroundVariant; label: string }[] = [
  { value: 'studio', label: 'Studio' },
  { value: 'dark', label: 'Dark' },
  { value: 'teal', label: 'Teal' },
  { value: 'blueprint', label: 'Blueprint' },
  { value: 'crt-terminal', label: 'CRT terminal' },
  { value: 'space', label: 'Space' },
  { value: 'nebula', label: 'Nebula' },
  { value: 'milky-way', label: 'Milky way' },
  { value: 'vaporwave', label: 'Vaporwave' },
  { value: 'matrix', label: 'Matrix' },
  { value: 'disco', label: 'Disco' },
  { value: 'aquarium', label: 'Aquarium' },
  { value: 'win95', label: 'Windows 95' },
];

// Variants whose lower half reads light (white-ish surface). The
// bottom-text hint flips to dark on these so it stays legible.
export const LIGHT_BOTTOM_VARIANTS = new Set<PreviewBackgroundVariant>(['studio', 'teal', 'win95']);

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function PreviewBackground({
  variant,
  customColor,
  filename,
  polyCount,
  caseRef,
}: {
  variant: PreviewBackgroundVariant;
  customColor: string | null;
  filename: string;
  polyCount?: number | null;
  caseRef?: string | null;
}) {
  if (customColor && HEX_RE.test(customColor)) {
    return (
      <div
        style={{ position: 'absolute', inset: 0, zIndex: 1, overflow: 'hidden', background: customColor }}
      />
    );
  }

  const lower = (filename || '').toLowerCase();
  const fileType = lower.includes('retainer')
    ? 'retainer'
    : lower.includes('crown')
      ? 'crown'
      : lower.includes('bridge')
        ? 'bridge'
        : lower.includes('veneer')
          ? 'veneer'
          : lower.includes('guard')
            ? 'night guard'
            : 'file';

  const base = { position: 'absolute' as const, inset: 0, zIndex: 1, overflow: 'hidden' as const };

  switch (variant) {
    case 'dark':
      return <div style={{ ...base, background: '#1a1a1a' }} />;

    case 'teal':
      return (
        <div style={{ ...base, background: 'linear-gradient(180deg, #e8f4f7 0%, #cfe7ec 100%)' }} />
      );

    case 'blueprint':
      return (
        <div style={{ ...base, background: '#1a5a7a' }}>
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background:
                'repeating-linear-gradient(0deg, transparent 0 19px, rgba(255,255,255,0.12) 19px 20px), repeating-linear-gradient(90deg, transparent 0 19px, rgba(255,255,255,0.12) 19px 20px)',
            }}
          />
          <div
            style={{
              position: 'absolute',
              top: 10,
              left: 14,
              color: 'rgba(255,255,255,0.72)',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: 11,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
            }}
          >
            {caseRef || 'Lounge'} / SCALE 1:1
          </div>
          <div
            style={{
              position: 'absolute',
              bottom: 10,
              right: 14,
              color: 'rgba(255,255,255,0.55)',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: 10,
              letterSpacing: '0.06em',
            }}
          >
            DETAIL A-A
          </div>
        </div>
      );

    case 'crt-terminal':
      return (
        <div style={{ ...base, background: '#030806' }}>
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background:
                'repeating-linear-gradient(0deg, transparent 0 2px, rgba(0,255,102,0.06) 2px 3px)',
              pointerEvents: 'none',
            }}
          />
          <pre
            style={{
              position: 'absolute',
              bottom: 10,
              left: 14,
              margin: 0,
              color: '#00ff66',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: 12,
              lineHeight: 1.5,
              textShadow: '0 0 4px #00ff66',
              whiteSpace: 'pre',
            }}
          >
            {`> load ${caseRef || 'file'}.stl\n> ${
              polyCount ? polyCount.toLocaleString() : 'ok'
            } triangles OK\n> `}
            <span className="lng-crt-cursor">_</span>
          </pre>
          <style>{`@keyframes lngCrtBlink { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } } .lng-crt-cursor { animation: lngCrtBlink 1s steps(1) infinite; }`}</style>
        </div>
      );

    case 'space':
      return (
        <div
          style={{
            ...base,
            background: 'radial-gradient(ellipse at center, #1a0b2e 0%, #050012 65%, #000 100%)',
          }}
        >
          <div
            style={{
              position: 'absolute',
              inset: 0,
              backgroundImage:
                'radial-gradient(1px 1px at 15% 20%, #fff 100%, transparent), radial-gradient(1px 1px at 80% 12%, #fff 100%, transparent), radial-gradient(0.8px 0.8px at 32% 72%, #fff 100%, transparent), radial-gradient(1px 1px at 70% 80%, #fff 100%, transparent), radial-gradient(0.6px 0.6px at 52% 45%, #fff 100%, transparent), radial-gradient(1px 1px at 90% 58%, #fff 100%, transparent), radial-gradient(0.6px 0.6px at 22% 88%, #fff 100%, transparent), radial-gradient(0.8px 0.8px at 62% 22%, #fff 100%, transparent), radial-gradient(1px 1px at 8% 48%, #fff 100%, transparent), radial-gradient(0.6px 0.6px at 42% 16%, #fff 100%, transparent)',
              animation: 'lngSpaceTwinkle 4s ease-in-out infinite alternate',
            }}
          />
          <style>{`@keyframes lngSpaceTwinkle { from { opacity: 0.55; } to { opacity: 1; } }`}</style>
        </div>
      );

    case 'nebula':
      return (
        <div style={{ ...base, background: '#060014' }}>
          <div
            style={{
              position: 'absolute',
              inset: '-10%',
              background:
                'radial-gradient(ellipse 45% 35% at 30% 40%, rgba(200,80,180,0.55) 0%, transparent 60%), radial-gradient(ellipse 40% 30% at 70% 60%, rgba(80,60,200,0.5) 0%, transparent 65%), radial-gradient(ellipse 35% 25% at 55% 25%, rgba(255,100,140,0.35) 0%, transparent 60%)',
              animation: 'lngNebulaDrift 22s ease-in-out infinite alternate',
            }}
          />
          <div
            style={{
              position: 'absolute',
              inset: 0,
              backgroundImage:
                'radial-gradient(1px 1px at 20% 25%, #fff 100%, transparent), radial-gradient(1px 1px at 75% 15%, #fff 100%, transparent), radial-gradient(0.8px 0.8px at 40% 80%, #fff 100%, transparent), radial-gradient(1px 1px at 85% 75%, #fff 100%, transparent), radial-gradient(0.6px 0.6px at 55% 50%, #fff 100%, transparent), radial-gradient(0.8px 0.8px at 10% 60%, #fff 100%, transparent)',
            }}
          />
          <style>{`@keyframes lngNebulaDrift { from { transform: translate(0, 0); opacity: 0.9; } to { transform: translate(-2%, 1%); opacity: 1; } }`}</style>
        </div>
      );

    case 'milky-way':
      return (
        <div style={{ ...base, background: '#020008' }}>
          <div
            style={{
              position: 'absolute',
              top: '-20%',
              left: '-30%',
              width: '160%',
              height: '140%',
              background:
                'linear-gradient(20deg, transparent 44%, rgba(180,160,230,0.25) 48%, rgba(230,210,250,0.35) 50%, rgba(180,160,230,0.25) 52%, transparent 56%)',
            }}
          />
          <div
            style={{
              position: 'absolute',
              inset: 0,
              backgroundImage:
                'radial-gradient(0.8px 0.8px at 12% 28%, #fff 100%, transparent), radial-gradient(1px 1px at 78% 18%, #fff 100%, transparent), radial-gradient(0.6px 0.6px at 42% 72%, #fff 100%, transparent), radial-gradient(1px 1px at 88% 82%, #fff 100%, transparent), radial-gradient(0.8px 0.8px at 30% 50%, #fff 100%, transparent), radial-gradient(1px 1px at 60% 40%, #fff 100%, transparent), radial-gradient(0.6px 0.6px at 18% 85%, #fff 100%, transparent), radial-gradient(0.8px 0.8px at 92% 42%, #fff 100%, transparent)',
            }}
          />
        </div>
      );

    case 'vaporwave':
      return (
        <div
          style={{
            ...base,
            background: 'linear-gradient(180deg, #ff7ac2 0%, #9d4edd 48%, #3a0ca3 88%, #10002b 100%)',
          }}
        >
          <div
            style={{
              position: 'absolute',
              top: '12%',
              left: '50%',
              transform: 'translateX(-50%)',
              width: 72,
              height: 72,
              borderRadius: '50%',
              background: 'linear-gradient(to bottom, #ffe95c 0%, #ff9a5c 55%, #ff5ca7 100%)',
            }}
          />
          <div
            style={{
              position: 'absolute',
              bottom: 0,
              left: '-20%',
              right: '-20%',
              height: '48%',
              background:
                'repeating-linear-gradient(90deg, transparent 0 calc(10% - 1px), #ff44a8 calc(10% - 1px) 10%), repeating-linear-gradient(0deg, transparent 0 calc(14% - 1px), #ff44a8 calc(14% - 1px) 14%)',
              transform: 'perspective(120px) rotateX(62deg)',
              transformOrigin: 'bottom center',
            }}
          />
        </div>
      );

    case 'matrix':
      return <MatrixBackground />;

    case 'disco':
      return (
        <div style={{ ...base, background: '#0a0508' }}>
          <div
            style={{
              position: 'absolute',
              inset: '-25%',
              background:
                'radial-gradient(circle at 28% 30%, rgba(255,46,99,0.75) 0%, transparent 22%), radial-gradient(circle at 75% 70%, rgba(8,217,214,0.75) 0%, transparent 22%), radial-gradient(circle at 75% 28%, rgba(255,253,130,0.6) 0%, transparent 20%)',
              animation: 'lngDiscoA 5s linear infinite',
            }}
          />
          <div
            style={{
              position: 'absolute',
              inset: '-25%',
              background:
                'radial-gradient(circle at 30% 75%, rgba(164,94,229,0.75) 0%, transparent 22%), radial-gradient(circle at 60% 45%, rgba(255,154,0,0.55) 0%, transparent 20%)',
              animation: 'lngDiscoB 7s linear infinite reverse',
            }}
          />
          <style>{`@keyframes lngDiscoA { to { transform: rotate(360deg); } } @keyframes lngDiscoB { to { transform: rotate(360deg); } }`}</style>
        </div>
      );

    case 'aquarium':
      return <AquariumBackground />;

    case 'win95':
      return (
        <div style={{ ...base, background: '#c0c0c0' }}>
          <div
            style={{
              position: 'absolute',
              inset: 4,
              border: '2px solid',
              borderColor: '#fff #808080 #808080 #fff',
              background: '#c0c0c0',
            }}
          />
          <div
            style={{
              position: 'absolute',
              top: 6,
              left: 6,
              right: 6,
              height: 18,
              background: 'linear-gradient(to right, #000080, #1084d0)',
              color: '#fff',
              fontSize: 11,
              fontWeight: 700,
              padding: '2px 8px',
              fontFamily: 'Tahoma, Geneva, sans-serif',
              boxSizing: 'border-box',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            3D Preview.exe
          </div>
          <div
            style={{
              position: 'absolute',
              bottom: 10,
              right: 10,
              background: '#fffbcc',
              color: '#000',
              fontSize: 11,
              padding: '6px 8px',
              border: '1px solid #000',
              maxWidth: 140,
              lineHeight: 1.3,
              fontFamily: 'Tahoma, Geneva, sans-serif',
            }}
          >
            It looks like you're previewing a {fileType}!
          </div>
        </div>
      );

    case 'studio':
    default:
      return <div style={{ ...base, background: '#f5f5f5' }} />;
  }
}

function MatrixBackground() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const chars = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉ0123456789$*#';
    const cols = 6;
    for (let i = 0; i < cols; i++) {
      const col = document.createElement('pre');
      col.style.cssText = `position:absolute;top:-4%;left:${
        i * (100 / cols) + 50 / cols - 1.5
      }%;margin:0;color:#00ff66;font-family:ui-monospace,Menlo,monospace;font-size:12px;line-height:1.2;white-space:pre;text-shadow:0 0 4px #00ff66;animation:lngMatrixFall ${
        3 + Math.random() * 3
      }s linear infinite;animation-delay:${-Math.random() * 3}s`;
      let s = '';
      for (let j = 0; j < 22; j++) s += chars.charAt(Math.floor(Math.random() * chars.length)) + '\n';
      col.textContent = s;
      host.appendChild(col);
    }
    return () => {
      while (host.firstChild) host.removeChild(host.firstChild);
    };
  }, []);
  return (
    <div
      ref={hostRef}
      style={{ position: 'absolute', inset: 0, zIndex: 1, overflow: 'hidden', background: '#000' }}
    >
      <style>{`@keyframes lngMatrixFall { from { transform: translateY(-100%); } to { transform: translateY(100%); } }`}</style>
    </div>
  );
}

function AquariumBackground() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    for (let i = 0; i < 8; i++) {
      const b = document.createElement('div');
      const sz = 4 + Math.random() * 10;
      b.style.cssText = `position:absolute;bottom:-20px;width:${sz}px;height:${sz}px;left:${
        Math.random() * 90 + 3
      }%;border-radius:50%;background:radial-gradient(circle at 32% 30%, rgba(255,255,255,0.6), rgba(255,255,255,0.1));border:0.5px solid rgba(255,255,255,0.5);animation:lngAquaRise ${
        4 + Math.random() * 4
      }s linear infinite;animation-delay:${-Math.random() * 6}s`;
      host.appendChild(b);
    }
    return () => {
      while (host.firstChild) host.removeChild(host.firstChild);
    };
  }, []);
  return (
    <div
      ref={hostRef}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 1,
        overflow: 'hidden',
        background: 'linear-gradient(180deg, #6bc2e8 0%, #2a88bd 55%, #0e3a5a 100%)',
      }}
    >
      <style>{`@keyframes lngAquaRise { 0% { transform: translateY(0); opacity: 0.85; } 100% { transform: translateY(-260px); opacity: 0; } }`}</style>
    </div>
  );
}

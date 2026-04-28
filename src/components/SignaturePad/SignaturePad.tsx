import { useCallback, useEffect, useRef, useState } from 'react';
import { theme } from '../../theme/index.ts';

// Captures a freehand signature on a canvas-shaped surface and emits the
// strokes as a single SVG path string. SVG (vector) over PNG (raster)
// because: tiny payload, scales for A4 print, no Storage upload, easy to
// re-render the original ink on any future audit.
//
// The path string is in the form
//   "M x1 y1 L x2 y2 L x3 y3 ... M xN yN L ..."
// — each pen-down starts a new "M" subpath, each move adds an "L". This is
// the same shape an SVG <path d="…"/> consumes directly.

export interface SignaturePadProps {
  // Pixel size of the drawing area. Defaults to 600x180 — wide enough that
  // signatures look natural on a tablet, short enough to fit two-up on a
  // tall sheet without scrolling.
  width?: number;
  height?: number;
  // Fired on every stroke change so the parent can enable / disable the
  // submit button without poking a ref.
  onChange?: (path: string, isEmpty: boolean) => void;
  ariaLabel?: string;
}

export interface SignaturePadHandle {
  getPath: () => string;
  clear: () => void;
  isEmpty: () => boolean;
}

interface Point {
  x: number;
  y: number;
}

export function SignaturePad({
  width = 600,
  height = 180,
  onChange,
  ariaLabel = 'Signature',
}: SignaturePadProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const strokesRef = useRef<Point[][]>([]);
  const currentRef = useRef<Point[] | null>(null);
  const [, forceRender] = useState(0);

  // Render one stroke (already-recorded points) onto the 2D context as a
  // smooth quadratic curve through midpoints. Quadratics over straight
  // lines because pen ink doesn't have hard angles — the smoothing reads
  // as a real signature, not a connect-the-dots polygon.
  const drawStroke = useCallback((ctx: CanvasRenderingContext2D, pts: Point[]) => {
    if (pts.length === 0) return;
    const first = pts[0]!;
    ctx.beginPath();
    if (pts.length === 1) {
      ctx.arc(first.x, first.y, 1.2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < pts.length - 1; i++) {
      const cur = pts[i]!;
      const next = pts[i + 1]!;
      const mid = {
        x: (cur.x + next.x) / 2,
        y: (cur.y + next.y) / 2,
      };
      ctx.quadraticCurveTo(cur.x, cur.y, mid.x, mid.y);
    }
    const last = pts[pts.length - 1]!;
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
  }, []);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = theme.color.ink;
    ctx.fillStyle = theme.color.ink;
    for (const stroke of strokesRef.current) {
      drawStroke(ctx, stroke);
    }
    if (currentRef.current && currentRef.current.length > 0) {
      drawStroke(ctx, currentRef.current);
    }
    ctx.restore();
  }, [drawStroke, height, width]);

  // Set up the canvas backing store at devicePixelRatio so strokes stay
  // crisp on retina screens. Re-runs only when size changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    redraw();
  }, [width, height, redraw]);

  const pointFromEvent = (e: PointerEvent | React.PointerEvent): Point => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  };

  const buildPath = useCallback((): string => {
    const parts: string[] = [];
    for (const stroke of strokesRef.current) {
      if (stroke.length === 0) continue;
      const first = stroke[0]!;
      parts.push(`M ${first.x.toFixed(1)} ${first.y.toFixed(1)}`);
      for (let i = 1; i < stroke.length; i++) {
        const p = stroke[i]!;
        parts.push(`L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`);
      }
    }
    return parts.join(' ');
  }, []);

  const emitChange = useCallback(() => {
    if (!onChange) return;
    const path = buildPath();
    onChange(path, strokesRef.current.length === 0);
  }, [buildPath, onChange]);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    currentRef.current = [pointFromEvent(e)];
    redraw();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!currentRef.current) return;
    currentRef.current.push(pointFromEvent(e));
    redraw();
  };

  const onPointerUp = () => {
    if (!currentRef.current || currentRef.current.length === 0) {
      currentRef.current = null;
      return;
    }
    strokesRef.current.push(currentRef.current);
    currentRef.current = null;
    redraw();
    emitChange();
    forceRender((n) => n + 1);
  };

  const clear = () => {
    strokesRef.current = [];
    currentRef.current = null;
    redraw();
    emitChange();
    forceRender((n) => n + 1);
  };

  const empty = strokesRef.current.length === 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
      <div
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: width,
          border: `1px dashed ${theme.color.border}`,
          borderRadius: theme.radius.input,
          background: theme.color.surface,
          overflow: 'hidden',
        }}
      >
        <canvas
          ref={canvasRef}
          aria-label={ariaLabel}
          role="img"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={(e) => {
            if (currentRef.current) onPointerUp();
            // Stop the parent sheet from receiving the synthetic event.
            e.stopPropagation();
          }}
          style={{
            display: 'block',
            touchAction: 'none',
            cursor: 'crosshair',
          }}
        />
        {empty ? (
          <span
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: theme.color.inkSubtle,
              fontSize: theme.type.size.sm,
              pointerEvents: 'none',
              userSelect: 'none',
            }}
          >
            Sign here
          </span>
        ) : null}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          type="button"
          onClick={clear}
          disabled={empty}
          style={{
            appearance: 'none',
            border: 'none',
            background: 'transparent',
            color: empty ? theme.color.inkSubtle : theme.color.ink,
            cursor: empty ? 'default' : 'pointer',
            fontFamily: 'inherit',
            fontSize: theme.type.size.sm,
            padding: `${theme.space[1]}px ${theme.space[2]}px`,
            textDecoration: empty ? 'none' : 'underline',
          }}
        >
          Clear
        </button>
      </div>
    </div>
  );
}

// Wraps the path string in a complete <svg> document. Used at sign time
// to produce the value stored in lng_waiver_signatures.signature_svg.
export function svgFromPath(path: string, width: number, height: number): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`,
    `<path d="${path}" stroke="black" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
    `</svg>`,
  ].join('');
}

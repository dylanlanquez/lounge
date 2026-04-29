import { useEffect, useRef, useState } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// ModelViewer — minimal STL / OBJ / PLY mesh previewer.
//
// three.js is loaded on demand from CDN the first time a 3D file is
// opened, so the main bundle stays small. Pinned to r143 (the last
// release that ships UMD examples/js loaders on jsdelivr) — same
// pinning Meridian's FilePreviewModal uses, so behaviour matches
// across both surfaces.
//
// Lounge runs view-only on Samsung tablets: the receptionist just
// needs to identify the mesh. No lighting controls, no presets, no
// dental-orient knobs — fit the mesh, drop a neutral material on it,
// give the user OrbitControls (drag to rotate, pinch to zoom). Cleanup
// disposes the renderer + geometry + material on unmount so a second
// preview doesn't leak the first one's WebGL context.
// ─────────────────────────────────────────────────────────────────────────────

const CDN = {
  three: 'https://cdn.jsdelivr.net/npm/three@0.143.0/build/three.min.js',
  trackballControls:
    'https://cdn.jsdelivr.net/npm/three@0.143.0/examples/js/controls/TrackballControls.js',
  stlLoader: 'https://cdn.jsdelivr.net/npm/three@0.143.0/examples/js/loaders/STLLoader.js',
  objLoader: 'https://cdn.jsdelivr.net/npm/three@0.143.0/examples/js/loaders/OBJLoader.js',
  plyLoader: 'https://cdn.jsdelivr.net/npm/three@0.143.0/examples/js/loaders/PLYLoader.js',
};

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve();
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

async function loadThree(): Promise<void> {
  await loadScript(CDN.three);
  await Promise.all([
    loadScript(CDN.trackballControls),
    loadScript(CDN.stlLoader),
    loadScript(CDN.objLoader),
    loadScript(CDN.plyLoader),
  ]);
}

type ModelExt = 'stl' | 'obj' | 'ply';

export interface ModelViewerProps {
  url: string;
  ext: ModelExt;
  // Visual settings, all optional. Sensible defaults match Meridian's
  // out-of-the-box look. Caller can pass these from a viewport panel.
  background?: string; // hex/rgb string; default '#0b0c0f' (dark)
  meshColor?: string; // hex; default '#b8c4cf'
  intensity?: number; // 0..2; default 0.85
  keyDirection?: 'front' | 'back'; // default 'front'
  // Progress hooks for the wrapping modal's loading bar. Fire while the
  // file streams from Supabase Storage; fire again when the renderer
  // has fitted the camera and the canvas is showing pixels.
  onProgress?: (loadedBytes: number, totalBytes: number) => void;
  onLoaded?: () => void;
}

export function ModelViewer({
  url,
  ext,
  background = '#0b0c0f',
  meshColor = '#b8c4cf',
  intensity = 0.85,
  keyDirection = 'front',
  onProgress,
  onLoaded,
}: ModelViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Refs we mutate from outside the bootstrap effect so the second
  // settings effect can change colour / intensity / background / key
  // direction without rebuilding the scene.
  const sceneRef = useRef<any>(null);
  const meshRef = useRef<any>(null);
  const keyLightRef = useRef<any>(null);

  // ── Bootstrap: load three, fetch + parse, build scene ──
  useEffect(() => {
    let cancelled = false;
    let raf = 0;
    let cleanup: (() => void) | null = null;

    (async () => {
      try {
        await loadThree();
        if (cancelled || !canvasRef.current) return;

        const THREE = (window as unknown as { THREE: any }).THREE;
        if (!THREE) throw new Error('three.js failed to load');

        const canvas = canvasRef.current;
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;

        const scene = new THREE.Scene();
        // Transparent scene so the parent's <PreviewBackground> div
        // renders behind the canvas via CSS — same trick Meridian's
        // FilePreviewModal uses to support animated background
        // variants without competing with the three.js render loop.
        scene.background = null;
        sceneRef.current = scene;

        const camera = new THREE.PerspectiveCamera(45, w / h, 0.01, 1000);
        camera.position.set(0, 0, 3);

        const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
        renderer.setClearColor(0x000000, 0);
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.setSize(w, h, false);

        const ambient = new THREE.AmbientLight(0xffffff, 0.55);
        scene.add(ambient);
        const key = new THREE.DirectionalLight(0xffffff, intensity);
        key.position.set(keyDirection === 'back' ? -0.6 : 0.6, 0.8, keyDirection === 'back' ? -1 : 1);
        scene.add(key);
        keyLightRef.current = key;
        const fill = new THREE.DirectionalLight(0xffffff, 0.35);
        fill.position.set(-0.5, -0.4, -0.7);
        scene.add(fill);

        // ── Stream + parse the file with progress ──
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const total = Number(res.headers.get('content-length') || 0);
        let buf: ArrayBuffer;
        if (res.body && total > 0 && onProgress) {
          const reader = res.body.getReader();
          const chunks: Uint8Array[] = [];
          let loaded = 0;
          // Loud-fail on early break; the catch below converts to UI.
          // eslint-disable-next-line no-constant-condition
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              chunks.push(value);
              loaded += value.length;
              onProgress(loaded, total);
            }
          }
          if (cancelled) return;
          // Concat chunks into a single ArrayBuffer.
          const merged = new Uint8Array(loaded);
          let off = 0;
          for (const c of chunks) {
            merged.set(c, off);
            off += c.length;
          }
          buf = merged.buffer;
        } else {
          buf = await res.arrayBuffer();
          if (onProgress && total > 0) onProgress(total, total);
        }
        if (cancelled) return;

        let mesh: any;
        if (ext === 'stl') {
          const loader = new THREE.STLLoader();
          const geometry = loader.parse(buf);
          geometry.computeVertexNormals();
          const material = new THREE.MeshStandardMaterial({
            color: new THREE.Color(meshColor),
            roughness: 0.55,
            metalness: 0.05,
            flatShading: false,
          });
          mesh = new THREE.Mesh(geometry, material);
        } else if (ext === 'ply') {
          const loader = new THREE.PLYLoader();
          const geometry = loader.parse(buf);
          geometry.computeVertexNormals();
          const material = new THREE.MeshStandardMaterial({
            color: new THREE.Color(meshColor),
            roughness: 0.55,
            metalness: 0.05,
          });
          mesh = new THREE.Mesh(geometry, material);
        } else {
          // OBJ — text-based, parse from the decoded string.
          const text = new TextDecoder().decode(buf);
          const loader = new THREE.OBJLoader();
          mesh = loader.parse(text);
          mesh.traverse((child: any) => {
            if (child.isMesh) {
              child.material = new THREE.MeshStandardMaterial({
                color: new THREE.Color(meshColor),
                roughness: 0.55,
                metalness: 0.05,
              });
            }
          });
        }

        // ── Centre + fit camera ──
        const box = new THREE.Box3().setFromObject(mesh);
        const size = new THREE.Vector3();
        box.getSize(size);
        const center = new THREE.Vector3();
        box.getCenter(center);
        mesh.position.sub(center);

        scene.add(mesh);
        meshRef.current = mesh;

        const maxDim = Math.max(size.x, size.y, size.z);
        const fov = (camera.fov * Math.PI) / 180;
        const camZ = (maxDim / 2) / Math.tan(fov / 2) * 1.6;
        camera.position.set(0, 0, camZ || 3);
        camera.near = (camZ || 3) / 100;
        camera.far = (camZ || 3) * 100;
        camera.updateProjectionMatrix();

        // TrackballControls — true 3-axis rotation with no up-axis
        // lock, matches Meridian's FilePreviewModal feel exactly so a
        // receptionist who's used to the lab tool isn't surprised.
        // Numbers ported verbatim from Meridian.
        const controls = new THREE.TrackballControls(camera, canvas);
        controls.rotateSpeed = 3.5;
        controls.zoomSpeed = 1.2;
        controls.panSpeed = 0.8;
        controls.noZoom = false;
        controls.noPan = false;
        controls.staticMoving = false;
        controls.dynamicDampingFactor = 0.18;
        controls.target.set(0, 0, 0);
        controls.update();

        const onResize = () => {
          if (!canvasRef.current) return;
          const W = canvasRef.current.clientWidth;
          const H = canvasRef.current.clientHeight;
          camera.aspect = W / H;
          camera.updateProjectionMatrix();
          renderer.setSize(W, H, false);
          // TrackballControls caches screen geometry internally and
          // needs a kick after the canvas resizes so the rotate axis
          // stays correct.
          controls.handleResize?.();
        };
        const ro = new ResizeObserver(onResize);
        ro.observe(canvas);

        const animate = () => {
          raf = requestAnimationFrame(animate);
          controls.update();
          renderer.render(scene, camera);
        };
        animate();

        if (!cancelled) {
          setLoading(false);
          onLoaded?.();
        }

        cleanup = () => {
          cancelAnimationFrame(raf);
          ro.disconnect();
          controls.dispose();
          if (mesh.geometry) mesh.geometry.dispose?.();
          mesh.traverse?.((child: any) => {
            child.geometry?.dispose?.();
            if (Array.isArray(child.material)) child.material.forEach((m: any) => m.dispose?.());
            else child.material?.dispose?.();
          });
          renderer.dispose();
          // Force loss of context so Safari frees the GPU resources
          // before the next preview opens.
          renderer.forceContextLoss?.();
        };
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Could not render model');
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      cleanup?.();
    };
    // url + ext are the rebuild keys. Visual settings live on a
    // separate effect below so a slider tweak doesn't refetch the file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, ext]);

  // Live settings effect — applies mesh colour / light intensity /
  // key direction to the existing scene without rebuilding. Scene
  // background stays null; the parent renders the visible background
  // as a CSS layer behind the transparent canvas.
  useEffect(() => {
    void background; // background lives on the parent's CSS layer.
    const THREE = (window as unknown as { THREE: any }).THREE;
    const scene = sceneRef.current;
    const mesh = meshRef.current;
    const key = keyLightRef.current;
    if (!THREE || !scene || !mesh) return;
    if (key) {
      key.intensity = intensity;
      key.position.set(keyDirection === 'back' ? -0.6 : 0.6, 0.8, keyDirection === 'back' ? -1 : 1);
    }
    const colour = new THREE.Color(meshColor);
    mesh.traverse?.((child: any) => {
      if (child.isMesh && child.material?.color) {
        child.material.color = colour;
        child.material.needsUpdate = true;
      }
    });
    if (mesh.material?.color) {
      mesh.material.color = colour;
      mesh.material.needsUpdate = true;
    }
  }, [background, meshColor, intensity, keyDirection]);

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          display: 'block',
          width: '100%',
          height: '100%',
          touchAction: 'none',
          // Hide canvas pixels until first paint completes so the
          // wrapping modal's loading card sits over a clean
          // background instead of a flicker of three's clear colour.
          opacity: loading && !error ? 0 : 1,
          transition: 'opacity 200ms ease',
        }}
      />
      {error ? (
        <span
          role="alert"
          style={{
            position: 'absolute',
            color: '#fff',
            fontSize: 13,
            background: 'rgba(220,38,38,0.85)',
            padding: '8px 12px',
            borderRadius: 999,
          }}
        >
          {error}
        </span>
      ) : null}
    </div>
  );
}

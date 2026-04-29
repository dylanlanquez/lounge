import { useEffect, useRef, useState } from 'react';
import { theme } from '../../theme/index.ts';

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
  orbitControls: 'https://cdn.jsdelivr.net/npm/three@0.143.0/examples/js/controls/OrbitControls.js',
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
    loadScript(CDN.orbitControls),
    loadScript(CDN.stlLoader),
    loadScript(CDN.objLoader),
    loadScript(CDN.plyLoader),
  ]);
}

type ModelExt = 'stl' | 'obj' | 'ply';

export function ModelViewer({ url, ext }: { url: string; ext: ModelExt }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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
        scene.background = new THREE.Color(0xf7f6f2); // theme.color.bg

        const camera = new THREE.PerspectiveCamera(45, w / h, 0.01, 1000);
        camera.position.set(0, 0, 3);

        const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.setSize(w, h, false);

        // Neutral two-light setup — receptionist's identification needs
        // a clean, evenly-lit mesh, not a dramatic look.
        const ambient = new THREE.AmbientLight(0xffffff, 0.55);
        scene.add(ambient);
        const key = new THREE.DirectionalLight(0xffffff, 0.85);
        key.position.set(0.6, 0.8, 1);
        scene.add(key);
        const fill = new THREE.DirectionalLight(0xffffff, 0.35);
        fill.position.set(-0.5, -0.4, -0.7);
        scene.add(fill);

        // ── Fetch + parse the file ──
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        if (cancelled) return;

        let mesh: any;
        if (ext === 'stl') {
          const loader = new THREE.STLLoader();
          const geometry = loader.parse(buf);
          geometry.computeVertexNormals();
          const material = new THREE.MeshStandardMaterial({
            color: 0xb8c4cf,
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
            color: 0xb8c4cf,
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
                color: 0xb8c4cf,
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

        const maxDim = Math.max(size.x, size.y, size.z);
        const fov = (camera.fov * Math.PI) / 180;
        const camZ = (maxDim / 2) / Math.tan(fov / 2) * 1.6;
        camera.position.set(0, 0, camZ || 3);
        camera.near = (camZ || 3) / 100;
        camera.far = (camZ || 3) * 100;
        camera.updateProjectionMatrix();

        const controls = new THREE.OrbitControls(camera, canvas);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.target.set(0, 0, 0);
        controls.update();

        const onResize = () => {
          if (!canvasRef.current) return;
          const W = canvasRef.current.clientWidth;
          const H = canvasRef.current.clientHeight;
          camera.aspect = W / H;
          camera.updateProjectionMatrix();
          renderer.setSize(W, H, false);
        };
        const ro = new ResizeObserver(onResize);
        ro.observe(canvas);

        const animate = () => {
          raf = requestAnimationFrame(animate);
          controls.update();
          renderer.render(scene, camera);
        };
        animate();

        if (!cancelled) setLoading(false);

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
  }, [url, ext]);

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        background: theme.color.bg,
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
        }}
      />
      {loading && !error ? (
        <span
          style={{
            position: 'absolute',
            color: theme.color.inkMuted,
            fontSize: theme.type.size.sm,
            background: theme.color.surface,
            padding: `${theme.space[2]}px ${theme.space[3]}px`,
            borderRadius: theme.radius.pill,
            border: `1px solid ${theme.color.border}`,
          }}
        >
          Loading model…
        </span>
      ) : null}
      {error ? (
        <span
          style={{
            position: 'absolute',
            color: theme.color.alert,
            fontSize: theme.type.size.sm,
            background: theme.color.surface,
            padding: `${theme.space[2]}px ${theme.space[3]}px`,
            borderRadius: theme.radius.pill,
            border: `1px solid ${theme.color.border}`,
          }}
        >
          {error}
        </span>
      ) : null}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { loadObjMaterials } from "../lib/loadObjMaterials";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

interface Props {
  datasetId: string;
  datasetName: string;
  // Present only when the OBJ was uploaded as a bundle (.obj + .mtl +
  // textures) — a bare .obj carries no color data of its own to load.
  mtlFilename?: string;
  onClose: () => void;
}

// Renders the *original* uploaded .obj mesh in a real WebGL 3D scene
// (geometry + faces + camera/orbit), instead of the flattened per-vertex
// map points the ingestion pipeline stores for the 2D map/analytics views.
export function Obj3DViewer({ datasetId, datasetName, mtlFilename, onClose }: Props) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<{ vertices: number; triangles: number } | null>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let disposed = false;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b1013);

    const camera = new THREE.PerspectiveCamera(50, mount.clientWidth / mount.clientHeight, 0.01, 10000);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    mount.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.0);
    key.position.set(1, 1, 1);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.4);
    fill.position.set(-1, -0.5, -1);
    scene.add(fill);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    let animationId = 0;
    const animate = () => {
      animationId = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };

    const resize = () => {
      if (!mount) return;
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
    };
    window.addEventListener("resize", resize);

    (async () => {
      try {
        const [materials, res] = await Promise.all([
          loadObjMaterials(datasetId, mtlFilename),
          fetch(`${API_BASE}/api/v1/datasets/${datasetId}/raw-file`, { credentials: "include" }),
        ]);
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const text = await res.text();
        if (disposed) return;

        const objLoader = new OBJLoader();
        if (materials) objLoader.setMaterials(materials);
        const object = objLoader.parse(text);

        let vertices = 0;
        let triangles = 0;
        object.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            // Only fall back to a flat placeholder color when the file had
            // no real materials to load (a bare .obj carries no color data, unless it has vertex colors).
            if (!materials) {
              const hasVertexColors = child.geometry.hasAttribute("color");
              child.material = new THREE.MeshStandardMaterial({
                color: hasVertexColors ? 0xffffff : 0x3aa1ff,
                flatShading: true,
                vertexColors: hasVertexColors,
              });
            }
            const geom = child.geometry;
            vertices += geom.attributes.position?.count ?? 0;
            triangles += geom.index ? geom.index.count / 3 : (geom.attributes.position?.count ?? 0) / 3;
          }
        });
        setStats({ vertices, triangles: Math.round(triangles) });

        // Center the mesh at the origin and frame the camera to its
        // bounding sphere — raw OBJ coordinates are in arbitrary local
        // units/offsets with no reliable scale to assume up front.
        const box = new THREE.Box3().setFromObject(object);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        object.position.sub(center);

        const radius = Math.max(size.length() / 2, 0.001);
        camera.near = radius / 100;
        camera.far = radius * 100;
        camera.updateProjectionMatrix();
        camera.position.set(radius * 1.5, radius * 1.2, radius * 1.5);
        controls.target.set(0, 0, 0);
        controls.update();

        scene.add(object);
        setLoading(false);
        animate();
      } catch (e) {
        if (!disposed) {
          setError((e as Error).message);
          setLoading(false);
        }
      }
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(animationId);
      window.removeEventListener("resize", resize);
      controls.dispose();
      renderer.dispose();
      scene.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          const mat = child.material;
          if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
          else mat.dispose();
        }
      });
      if (mount && renderer.domElement.parentNode === mount) {
        mount.removeChild(renderer.domElement);
      }
    };
  }, [datasetId]);

  return (
    <section className="obj3d-wrap" data-testid="obj3d-viewer">
      <div className="attr-table-head">
        <div>
          <h3>3D View — {datasetName}</h3>
          {stats && (
            <span className="grid-head__count">
              {stats.vertices.toLocaleString()} vertices · {stats.triangles.toLocaleString()} triangles · drag to orbit, scroll to zoom
            </span>
          )}
        </div>
        <button type="button" className="btn btn--danger btn--sm" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="obj3d-canvas" ref={mountRef}>
        {loading && !error && <div className="obj3d-status">Loading 3D model…</div>}
        {error && <div className="obj3d-status obj3d-status--error">Couldn't load 3D model: {error}</div>}
      </div>
    </section>
  );
}

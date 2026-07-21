/**
 * WelcomeScene — the procedural 3D urban mesh that forms the visual
 * foundation of the landing walkthrough.
 *
 * Design rules followed here:
 *  - Raw Three.js only (no react-three-fiber/drei) to avoid new deps and
 *    version conflicts; the project already ships three 0.169.0.
 *  - Procedural, low-poly geometry: InstancedMesh for buildings/trees/agents,
 *    simple boxes, planes, line paths. No external assets / textures.
 *  - Palette strictly #88A991 / #D4EDDA / #FFFFFF (+ derived alpha/ink).
 *  - Scroll progress (normalized ref) is the single source of camera truth.
 *  - Deterministic keyframe interpolation: position.lerp + lookAt lerp.
 *  - Deterministic scene generation (seeded RNG) — no Math.random at build,
 *    stable across reloads; buildings never intersect green zones.
 *  - No React state churn per frame: the render loop reads refs only.
 *  - dpr capped at 1.5, shadows dropped on mobile, RAF paused when hidden,
 *    full disposal on unmount (no leaks / duplicates).
 */
import { useEffect, useRef } from "react";
import * as THREE from "three";
import {
  PALETTE,
  INK_GREEN,
  CAMERA_KEYFRAMES,
  INTRO_START,
  OVERVIEW_KEYFRAME,
  SECTIONS,
  DESKTOP_DENSITY,
  MOBILE_DENSITY,
  type DensityConfig,
} from "./urbanSceneConfig";
import { makeTextSprite, disposeSprite } from "./textTexture";
import { createCity } from "./city/buildCity";
import { AGENT_DENSITY } from "./city/config";
import { makeRng } from "./city/collisionUtils";

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

interface PulseTarget {
  mesh: THREE.Mesh;
  baseScale: number;
  phase: number;
}

interface CityBuild {
  group: THREE.Object3D;
  update: (elapsed: number) => void;
  setStatic: () => void;
  dispose: () => void;
  pulsing: PulseTarget[];
}

function buildDecor(
  scene: THREE.Scene,
  density: DensityConfig,
  isMobile: boolean
): CityBuild {
  const disposables: Array<{ dispose: () => void }> = [];
  const track = <T extends { dispose: () => void }>(o: T): T => {
    disposables.push(o);
    return o;
  };
  const pulsing: PulseTarget[] = [];
  const rng = makeRng(909);

  const green = new THREE.Color(PALETTE.green);

  // ---- Utility lines (network paths) ---------------------------------------
  const utilPts: number[] = [];
  for (let i = 0; i < 14; i++) {
    const x1 = (rng() * 2 - 1) * 100;
    const z1 = (rng() * 2 - 1) * 80;
    const x2 = x1 + (rng() * 2 - 1) * 30;
    const z2 = z1 + (rng() * 2 - 1) * 30;
    utilPts.push(x1, 0.4, z1, x2, 0.4, z2);
  }
  const utilGeo = track(new THREE.BufferGeometry());
  utilGeo.setAttribute("position", new THREE.Float32BufferAttribute(utilPts, 3));
  const utilMat = track(
    new THREE.LineBasicMaterial({ color: green, transparent: true, opacity: 0.55 })
  );
  const utilLines = new THREE.LineSegments(utilGeo, utilMat);
  scene.add(utilLines);

  // ---- Utility nodes (instanced small spheres) -----------------------------
  const nodeGeo = track(new THREE.SphereGeometry(0.5, 10, 10));
  const nodeMat = track(
    new THREE.MeshStandardMaterial({
      color: green,
      emissive: green,
      emissiveIntensity: 0.25,
      roughness: 0.6,
    })
  );
  const nodeCount = 40;
  const nodes = new THREE.InstancedMesh(nodeGeo, nodeMat, nodeCount);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < nodeCount; i++) {
    dummy.position.set((rng() * 2 - 1) * 100, 0.5, (rng() * 2 - 1) * 80);
    dummy.scale.set(1, 1, 1);
    dummy.rotation.set(0, 0, 0);
    dummy.updateMatrix();
    nodes.setMatrixAt(i, dummy.matrix);
  }
  scene.add(nodes);

  // ---- Pulsing markers (monitoring & section highlights) -------------------
  const markerGeo = track(new THREE.SphereGeometry(0.9, 12, 12));
  const markerMat = track(
    new THREE.MeshStandardMaterial({
      color: green,
      emissive: green,
      emissiveIntensity: 0.5,
      roughness: 0.4,
    })
  );
  const markerSpots: Array<[number, number, number]> = [
    [-30, 6, 10],
    [-26, 5, 6],
    [-34, 5, 14],
    [30, 6, -8],
    [34, 5, -4],
    [26, 5, -12],
    [52, 6, 14],
    [48, 5, 10],
    [-52, 6, -14],
    [-48, 5, -10],
  ];
  for (let i = 0; i < Math.min(density.markers * 2, markerSpots.length); i++) {
    const [x, y, z] = markerSpots[i];
    const mesh = new THREE.Mesh(markerGeo, markerMat);
    mesh.position.set(x, y, z);
    mesh.castShadow = !isMobile;
    scene.add(mesh);
    pulsing.push({ mesh, baseScale: 1, phase: i * 0.7 });
  }

  // ---- 3D text labels (integrated into the scene) --------------------------
  const sprites: THREE.Sprite[] = [];
  SECTIONS.forEach((s) => {
    const isHero = s.keyframe === 0;
    const sprite = makeTextSprite(s.title, {
      color: INK_GREEN,
      background: isHero ? PALETTE.white : undefined,
      worldHeight: isHero ? 5.5 : 3.2,
      padding: isHero ? 36 : 22,
    });
    sprite.position.set(s.anchor[0], s.anchor[1], s.anchor[2]);
    (sprite.material as THREE.SpriteMaterial).depthTest = false;
    sprite.renderOrder = 10;
    scene.add(sprite);
    sprites.push(sprite);
  });

  const dispose = () => {
    disposables.forEach((d) => d.dispose());
    sprites.forEach((s) => {
      scene.remove(s);
      disposeSprite(s);
    });
  };

  return {
    group: new THREE.Group(),
    update: () => {},
    setStatic: () => {},
    dispose,
    pulsing,
  };
}

export default function WelcomeScene({
  reducedMotion,
  progressRef,
}: {
  reducedMotion: boolean;
  progressRef: React.MutableRefObject<number>;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const reducedRef = useRef(reducedMotion);

  useEffect(() => {
    reducedRef.current = reducedMotion;
  }, [reducedMotion]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const isMobile = window.innerWidth <= 768;
    const density = isMobile ? MOBILE_DENSITY : DESKTOP_DENSITY;
    const agents = isMobile ? AGENT_DENSITY.mobile : AGENT_DENSITY.desktop;

    let width = mount.clientWidth || window.innerWidth;
    let height = mount.clientHeight || window.innerHeight;

    const renderer = new THREE.WebGLRenderer({
      antialias: !isMobile,
      alpha: false,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(width, height);
    renderer.shadowMap.enabled = !isMobile;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mount.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(PALETTE.white);
    scene.fog = new THREE.Fog(PALETTE.white, 70, 210);

    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 1000);

    // ---- Lights --------------------------------------------------------------
    const ambient = new THREE.AmbientLight(0xffffff, 0.9);
    scene.add(ambient);
    const dir = new THREE.DirectionalLight(0xffffff, 0.65);
    dir.position.set(40, 70, 30);
    if (!isMobile) {
      dir.castShadow = true;
      dir.shadow.mapSize.set(1024, 1024);
      dir.shadow.camera.near = 1;
      dir.shadow.camera.far = 260;
      dir.shadow.camera.left = -120;
      dir.shadow.camera.right = 120;
      dir.shadow.camera.top = 120;
      dir.shadow.camera.bottom = -120;
    }
    scene.add(dir);

    // ---- Ground --------------------------------------------------------------
    const groundGeo = new THREE.PlaneGeometry(260, 220);
    const groundMat = new THREE.MeshStandardMaterial({
      color: PALETTE.light,
      roughness: 1,
      metalness: 0,
    });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = 0;
    ground.receiveShadow = !isMobile;
    scene.add(ground);

    // ---- City (modular, deterministic, exclusion-aware) ---------------------
    const city = createCity({
      isMobile,
      buildingCount: density.buildings,
      treeCount: density.trees,
      agents,
    });
    scene.add(city.object3D);

    // ---- Decorative overlays (utility, markers, labels) ---------------------
    const decor = buildDecor(scene, density, isMobile);

    if (reducedRef.current) {
      city.setStatic();
    }

    // ---- Camera path helpers -------------------------------------------------
    const introVec = new THREE.Vector3(...INTRO_START.position);
    const introLook = new THREE.Vector3(...INTRO_START.lookAt);
    const samplePos = new THREE.Vector3();
    const sampleLook = new THREE.Vector3();
    const tmpLook = new THREE.Vector3();

    const sampleCamera = (p: number) => {
      const N = CAMERA_KEYFRAMES.length;
      const seg = clamp(p, 0, 1) * (N - 1);
      let i = Math.floor(seg);
      if (i >= N - 1) i = N - 2;
      if (i < 0) i = 0;
      const f = easeInOutCubic(seg - i);
      const a = CAMERA_KEYFRAMES[i];
      const b = CAMERA_KEYFRAMES[i + 1];
      samplePos.set(
        lerp(a.position[0], b.position[0], f),
        lerp(a.position[1], b.position[1], f),
        lerp(a.position[2], b.position[2], f)
      );
      sampleLook.set(
        lerp(a.lookAt[0], b.lookAt[0], f),
        lerp(a.lookAt[1], b.lookAt[1], f),
        lerp(a.lookAt[2], b.lookAt[2], f)
      );
    };

    // ---- Render loop ---------------------------------------------------------
    const clock = new THREE.Clock();
    let introT = 0;
    const INTRO_DUR = 2.6;
    let raf = 0;
    let running = true;
    let elapsed = 0;

    const renderFrame = () => {
      if (!running) return;
      raf = requestAnimationFrame(renderFrame);
      const dt = clock.getDelta();
      const reduced = reducedRef.current;

      if (reduced) {
        camera.position.set(...OVERVIEW_KEYFRAME.position);
        camera.lookAt(...OVERVIEW_KEYFRAME.lookAt);
      } else {
        elapsed += dt;
        if (introT < 1) introT = Math.min(1, introT + dt / INTRO_DUR);
        const blend = easeInOutCubic(introT);
        sampleCamera(progressRef.current);
        camera.position.lerpVectors(introVec, samplePos, blend);
        tmpLook.lerpVectors(introLook, sampleLook, blend);
        camera.lookAt(tmpLook);

        city.update(elapsed);

        for (const m of decor.pulsing) {
          const s = m.baseScale * (1 + 0.16 * Math.sin(elapsed * 2 + m.phase));
          m.mesh.scale.setScalar(s);
          (m.mesh.material as THREE.MeshStandardMaterial).emissiveIntensity =
            0.4 + 0.3 * (0.5 + 0.5 * Math.sin(elapsed * 2 + m.phase));
        }
      }

      renderer.render(scene, camera);
    };
    renderFrame();

    // ---- Visibility pause ----------------------------------------------------
    const onVisibility = () => {
      if (document.hidden) {
        running = false;
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
      } else if (!running) {
        running = true;
        clock.getDelta();
        renderFrame();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    // ---- Resize (no scroll reset, no restart) -------------------------------
    const onResize = () => {
      const w = mount.clientWidth || window.innerWidth;
      const h = mount.clientHeight || window.innerHeight;
      if (!w || !h) return;
      width = w;
      height = h;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    };
    window.addEventListener("resize", onResize);
    const ro = new ResizeObserver(onResize);
    ro.observe(mount);

    return () => {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
      ro.disconnect();
      city.dispose();
      decor.dispose();
      groundGeo.dispose();
      groundMat.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode) {
        renderer.domElement.parentNode.removeChild(renderer.domElement);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div className="welcome-scene" ref={mountRef} aria-hidden="true" />;
}

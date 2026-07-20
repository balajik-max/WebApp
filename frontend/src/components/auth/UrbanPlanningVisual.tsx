/**
 * UrbanPlanningVisual — a lightweight, original 3D urban-planning scene for
 * the Login page's right-hand panel.
 *
 * Design notes:
 *  - Raw Three.js (the project already ships three 0.169.0; no react-three
 *    fiber / drei to avoid a second dependency or version clash).
 *  - Procedural, low-poly, GIS-inspired: raised terrain platform, instanced
 *    white buildings, green road network, a drainage corridor, utility/
 *    infrastructure lines, poles, open-space markers, a civic building, a
 *    planning grid, and a few pulsing markers.
 *  - Palette STRICTLY #88A991 / #D4EDDA / #FFFFFF (+ alpha/tonal variants).
 *  - Subtle motion only: gentle oscillation of the city group (a few
 *    degrees) + soft marker pulse. prefers-reduced-motion => a single static
 *    isometric render, no loop.
 *  - dpr capped at 1.5, shadows off on mobile, InstancedMesh for repeats,
 *    one directional light + ambient. No React state per frame; the RAF loop
 *    reads only local refs. Full disposal + listener cleanup on unmount.
 */
import { useEffect, useRef } from "react";
import * as THREE from "three";

function isReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export default function UrbanPlanningVisual() {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const isMobile = window.innerWidth <= 900;
    const reduced = isReducedMotion();
    let width = mount.clientWidth || 600;
    let height = mount.clientHeight || 600;

    const renderer = new THREE.WebGLRenderer({
      antialias: !isMobile,
      alpha: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(width, height);
    renderer.shadowMap.enabled = !isMobile;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mount.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";
    renderer.domElement.setAttribute("aria-hidden", "true");

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 1000);
    camera.position.set(36, 30, 40);
    camera.lookAt(0, 2, 0);

    const ambient = new THREE.AmbientLight(0xffffff, 0.9);
    scene.add(ambient);
    const dir = new THREE.DirectionalLight(0xffffff, 0.6);
    dir.position.set(24, 44, 22);
    if (!isMobile) {
      dir.castShadow = true;
      dir.shadow.mapSize.set(1024, 1024);
      dir.shadow.camera.near = 1;
      dir.shadow.camera.far = 200;
      dir.shadow.camera.left = -80;
      dir.shadow.camera.right = 80;
      dir.shadow.camera.top = 80;
      dir.shadow.camera.bottom = -80;
    }
    scene.add(dir);

    const city = new THREE.Group();
    scene.add(city);

    const disposables: Array<{ dispose: () => void }> = [];
    const track = <T extends { dispose: () => void }>(o: T): T => {
      disposables.push(o);
      return o;
    };
    const green = new THREE.Color("#88A991");
    const white = new THREE.Color("#FFFFFF");
    const light = new THREE.Color("#D4EDDA");

    // ---- Raised terrain platform ------------------------------------------
    const platGeo = track(new THREE.BoxGeometry(74, 3, 74));
    const platMat = track(new THREE.MeshStandardMaterial({ color: light, roughness: 1 }));
    const plat = new THREE.Mesh(platGeo, platMat);
    plat.position.y = -1.5;
    plat.receiveShadow = !isMobile;
    city.add(plat);

    // ---- Planning grid boundary (lines) -----------------------------------
    const gridPts: number[] = [];
    for (let i = -32; i <= 32; i += 8) {
      gridPts.push(i, 0.06, -32, i, 0.06, 32);
      gridPts.push(-32, 0.06, i, 32, 0.06, i);
    }
    const gridGeo = track(new THREE.BufferGeometry());
    gridGeo.setAttribute("position", new THREE.Float32BufferAttribute(gridPts, 3));
    const gridMat = track(new THREE.LineBasicMaterial({ color: green, transparent: true, opacity: 0.32 }));
    city.add(new THREE.LineSegments(gridGeo, gridMat));

    // ---- Road network (green bars) -----------------------------------------
    const roadGeo = track(new THREE.BoxGeometry(1, 0.12, 1));
    const roadMat = track(new THREE.MeshStandardMaterial({ color: green, roughness: 0.9 }));
    const roadDefs: Array<[number, number, number, number]> = [
      [0, 0, 0, 62],
      [0, 0, 62, 0],
      [20, 0, 0, 44],
      [-20, 0, 0, 44],
      [0, 0, 0, 62],
    ];
    const roads = new THREE.InstancedMesh(roadGeo, roadMat, roadDefs.length);
    const dummy = new THREE.Object3D();
    roadDefs.forEach((r, i) => {
      const [x, , lz, lx] = r;
      dummy.position.set(x, 0.12, 0);
      dummy.scale.set(Math.max(lx, 1.6), 1, Math.max(lz, 1.6));
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      roads.setMatrixAt(i, dummy.matrix);
    });
    roads.receiveShadow = !isMobile;
    city.add(roads);

    // ---- Drainage / water corridor (translucent green strip) ---------------
    const drainGeo = track(new THREE.PlaneGeometry(6, 70));
    const drainMat = track(
      new THREE.MeshStandardMaterial({
        color: green,
        transparent: true,
        opacity: 0.4,
        roughness: 0.7,
      }),
    );
    const drain = new THREE.Mesh(drainGeo, drainMat);
    drain.rotation.x = -Math.PI / 2;
    drain.position.set(-12, 0.1, 0);
    city.add(drain);

    // ---- Buildings (instanced) ---------------------------------------------
    const buildingCount = isMobile ? 70 : 150;
    const buildingGeo = track(new THREE.BoxGeometry(1, 1, 1));
    const buildingMat = track(
      new THREE.MeshStandardMaterial({ color: white, roughness: 0.85 }),
    );
    const buildings = new THREE.InstancedMesh(buildingGeo, buildingMat, buildingCount);
    buildings.castShadow = !isMobile;
    buildings.receiveShadow = !isMobile;
    const buildingSpots: Array<[number, number, number, number, number]> = [];
    for (let i = 0; i < buildingCount; i++) {
      const gx = Math.round((Math.random() * 2 - 1) * 3) * 8;
      const gz = Math.round((Math.random() * 2 - 1) * 3) * 8;
      const w = 3 + Math.random() * 3;
      const d = 3 + Math.random() * 3;
      const h = 2 + Math.random() * 11;
      // keep clear of the central civic plaza
      if (Math.abs(gx) < 7 && Math.abs(gz) < 7) continue;
      buildingSpots.push([gx + (Math.random() * 3 - 1.5), h, gz + (Math.random() * 3 - 1.5), w, d]);
    }
    buildingSpots.forEach((b, i) => {
      const [x, h, z, w, d] = b;
      dummy.position.set(x, h / 2, z);
      dummy.scale.set(w, h, d);
      dummy.rotation.set(0, Math.random() < 0.5 ? 0 : Math.PI / 2, 0);
      dummy.updateMatrix();
      buildings.setMatrixAt(i, dummy.matrix);
      buildings.setColorAt(i, Math.random() < 0.25 ? green : white);
    });
    buildings.count = buildingSpots.length;
    buildings.instanceMatrix.needsUpdate = true;
    if (buildings.instanceColor) buildings.instanceColor.needsUpdate = true;
    city.add(buildings);

    // ---- Civic / public building (prominent green) -------------------------
    const civicGeo = track(new THREE.BoxGeometry(8, 9, 8));
    const civicMat = track(new THREE.MeshStandardMaterial({ color: green, roughness: 0.8 }));
    const civic = new THREE.Mesh(civicGeo, civicMat);
    civic.position.set(0, 4.5, 0);
    civic.castShadow = !isMobile;
    civic.receiveShadow = !isMobile;
    city.add(civic);

    // ---- Poles (instanced cylinders) ---------------------------------------
    const poleCount = isMobile ? 8 : 16;
    const poleGeo = track(new THREE.CylinderGeometry(0.25, 0.3, 4, 6));
    const poleMat = track(new THREE.MeshStandardMaterial({ color: green, roughness: 0.7 }));
    const poles = new THREE.InstancedMesh(poleGeo, poleMat, poleCount);
    poles.castShadow = !isMobile;
    for (let i = 0; i < poleCount; i++) {
      const x = (Math.random() * 2 - 1) * 30;
      const z = (Math.random() * 2 - 1) * 30;
      dummy.position.set(x, 2, z);
      dummy.scale.set(1, 1, 1);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      poles.setMatrixAt(i, dummy.matrix);
    }
    city.add(poles);

    // ---- Open-space / tree markers (low-poly cones) ------------------------
    const treeCount = isMobile ? 10 : 22;
    const treeGeo = track(new THREE.ConeGeometry(1.2, 3.2, 7));
    const treeMat = track(new THREE.MeshStandardMaterial({ color: green, roughness: 0.9 }));
    const trees = new THREE.InstancedMesh(treeGeo, treeMat, treeCount);
    trees.castShadow = !isMobile;
    for (let i = 0; i < treeCount; i++) {
      const x = -28 + Math.random() * 12;
      const z = -28 + Math.random() * 56;
      dummy.position.set(x, 1.8, z);
      dummy.scale.set(1, 1, 1);
      dummy.rotation.set(0, Math.random() * Math.PI, 0);
      dummy.updateMatrix();
      trees.setMatrixAt(i, dummy.matrix);
    }
    city.add(trees);

    // ---- Utility / infrastructure lines ------------------------------------
    const utilPts: number[] = [];
    for (let i = 0; i < 10; i++) {
      const x1 = (Math.random() * 2 - 1) * 30;
      const z1 = (Math.random() * 2 - 1) * 30;
      const x2 = x1 + (Math.random() * 2 - 1) * 22;
      const z2 = z1 + (Math.random() * 2 - 1) * 22;
      utilPts.push(x1, 0.4, z1, x2, 0.4, z2);
    }
    const utilGeo = track(new THREE.BufferGeometry());
    utilGeo.setAttribute("position", new THREE.Float32BufferAttribute(utilPts, 3));
    const utilMat = track(new THREE.LineBasicMaterial({ color: green, transparent: true, opacity: 0.55 }));
    city.add(new THREE.LineSegments(utilGeo, utilMat));

    // ---- Pulsing infrastructure markers ------------------------------------
    const markerGeo = track(new THREE.SphereGeometry(0.9, 12, 12));
    const markerMat = track(
      new THREE.MeshStandardMaterial({
        color: green,
        emissive: green,
        emissiveIntensity: 0.5,
        roughness: 0.4,
      }),
    );
    const markerSpots: Array<[number, number, number]> = [
      [12, 6, 10],
      [-14, 5, 16],
      [18, 5, -12],
      [-18, 5, -14],
      [0, 13, 0],
    ];
    const pulsing: Array<{ mesh: THREE.Mesh; phase: number }> = [];
    markerSpots.forEach((p, i) => {
      const mesh = new THREE.Mesh(markerGeo, markerMat);
      mesh.position.set(p[0], p[1], p[2]);
      mesh.castShadow = !isMobile;
      city.add(mesh);
      pulsing.push({ mesh, phase: i * 0.8 });
    });

    // ---- Render loop -------------------------------------------------------
    const clock = new THREE.Clock();
    let raf = 0;
    let running = true;
    const REST_ANGLE = 0.16;

    const renderFrame = () => {
      if (!running) return;
      raf = requestAnimationFrame(renderFrame);
      const t = clock.getElapsedTime();
      if (!reduced) {
        city.rotation.y = REST_ANGLE + Math.sin(t * 0.18) * 0.18;
        for (const m of pulsing) {
          const s = 1 + 0.18 * Math.sin(t * 2 + m.phase);
          m.mesh.scale.setScalar(s);
          (m.mesh.material as THREE.MeshStandardMaterial).emissiveIntensity =
            0.4 + 0.3 * (0.5 + 0.5 * Math.sin(t * 2 + m.phase));
        }
      }
      renderer.render(scene, camera);
    };

    if (reduced) {
      city.rotation.y = REST_ANGLE;
      renderer.render(scene, camera);
    } else {
      renderFrame();
    }

    // ---- Pause when tab hidden --------------------------------------------
    const onVisibility = () => {
      if (document.hidden) {
        running = false;
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
      } else if (!running && !reduced) {
        running = true;
        clock.getDelta();
        renderFrame();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    // ---- Resize (no scroll reset) -----------------------------------------
    const onResize = () => {
      const w = mount.clientWidth || 600;
      const h = mount.clientHeight || 600;
      if (!w || !h) return;
      width = w;
      height = h;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
      if (reduced) renderer.render(scene, camera);
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
      disposables.forEach((d) => d.dispose());
      renderer.dispose();
      if (renderer.domElement.parentNode) {
        renderer.domElement.parentNode.removeChild(renderer.domElement);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div className="urban-planning-visual" ref={mountRef} aria-hidden="true" />;
}

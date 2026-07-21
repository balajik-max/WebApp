import * as THREE from "three";
import { buildCityLayout, type CityLayout } from "./cityLayout";
import { createGreenZones } from "./GreenZones";
import { createBuildings } from "./BuildingGenerator";
import { createStreetLights } from "./StreetLights";
import { createCars } from "./MovingCars";
import { createPedestrians } from "./Pedestrians";
import { createCyclists } from "./Cyclists";
import type { CityEntity } from "./types";
import type { AgentCounts } from "./collisionUtils";

export type CityOptions = {
  isMobile: boolean;
  buildingCount: number;
  treeCount: number;
  agents: AgentCounts;
};

export type City = CityEntity & { layout: CityLayout };

export function createCity(opts: CityOptions): City {
  const group = new THREE.Group();
  const layout = buildCityLayout();
  const entities: CityEntity[] = [];

  const add = (e: CityEntity) => {
    entities.push(e);
    group.add(e.object3D);
  };

  add(createGreenZones(layout, opts.isMobile, opts.treeCount));
  add(createBuildings(layout, opts.buildingCount, opts.isMobile));
  add(createStreetLights(opts.agents.streetlights));
  add(createCars(layout.carPaths, opts.agents.cars, opts.isMobile));
  add(
    createPedestrians(layout.pedPaths, opts.agents.pedestrians, opts.isMobile)
  );
  add(createCyclists(layout.pedPaths, opts.agents.cyclists, opts.isMobile));

  return {
    object3D: group,
    layout,
    update: (elapsed: number) => {
      for (const e of entities) e.update(elapsed);
    },
    setStatic: () => {
      for (const e of entities) e.setStatic();
    },
    dispose: () => {
      for (const e of entities) e.dispose();
    },
  };
}

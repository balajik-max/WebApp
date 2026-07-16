"""Drainage Line Consolidation Utility

Consolidates multiple parallel, overlapping drainage LineStrings inside a
street corridor into a single clean centerline using:
  1. Buffer + dissolve to merge overlapping paths into corridor polygons
  2. Voronoi-based medial axis skeleton to derive the centerline
  3. Snapping manhole points onto the generated centerline

Dependencies: geopandas, shapely, scipy (for sparse Voronoi)
"""
from __future__ import annotations

import math
from typing import Sequence

import geopandas as gpd
import numpy as np
from shapely.geometry import LineString, MultiLineString, MultiPoint, Point, Polygon, MultiPolygon
from shapely.ops import (
    linemerge,
    snap,
    split,
    voronoi_diagram,
    unary_union,
)


# ---------------------------------------------------------------------------
# 1. Corridor generation — buffer + dissolve
# ---------------------------------------------------------------------------

def build_corridor_polygons(
    lines: gpd.GeoDataFrame,
    buffer_m: float = 2.5,
    *,
    geometry_column: str = "geometry",
) -> gpd.GeoDataFrame:
    """Buffer every drainage LineString by *buffer_m* metres and dissolve
    overlapping buffers into unified street-corridor polygons.

    Parameters
    ----------
    lines : GeoDataFrame
        Input drainage network with LineString geometries.
    buffer_m : float
        Half-width of the corridor buffer (default 2.5 m — a 5 m wide
        corridor around each pipe centreline).
    geometry_column : str
        Name of the geometry column (default ``"geometry"``).

    Returns
    -------
    GeoDataFrame
        One row per dissolved corridor polygon.
    """
    if lines.empty:
        return gpd.GeoDataFrame(columns=[geometry_column], crs=lines.crs)

    # Project to a metric CRS for accurate buffering if needed
    orig_crs = lines.crs
    work = lines.copy()

    # Detect geographic CRS and project to UTM for metric buffering
    if orig_crs and orig_crs.is_geographic:
        utm_zone = _utm_zone(work)
        work = work.to_crs(f"+proj=utm +zone={utm_zone} +datum=WGS84")
    else:
        utm_zone = None

    buffered = work.copy()
    buffered[geometry_column] = buffered[geometry_column].buffer(buffer_m)

    dissolved = gpd.GeoDataFrame(
        geometry=[unary_union(buffered[geometry_column].tolist())],
        crs=work.crs,
    )

    # If unary_union produced a MultiPolygon, explode to individual corridors
    if dissolved.geometry.iloc[0].geom_type == "MultiPolygon":
        dissolved = dissolved.explode(index_parts=False).reset_index(drop=True)

    # Project back to original CRS
    if utm_zone is not None:
        dissolved = dissolved.to_crs(orig_crs)

    return dissolved


def _utm_zone(gdf: gpd.GeoDataFrame) -> int:
    """Guess the UTM zone from the centroid of the GeoDataFrame bounds."""
    bounds = gdf.total_bounds  # [minx, miny, maxx, maxy]
    centroid_lon = (bounds[0] + bounds[2]) / 2
    return int(math.floor((centroid_lon + 180) / 6) + 1)


# ---------------------------------------------------------------------------
# 2. Medial axis (centerline) via Voronoi diagram
# ---------------------------------------------------------------------------

def _voronoi_centerline(polygon: Polygon, sample_dist: float = 2.0) -> LineString | None:
    """Compute the medial axis of a corridor polygon using Shapely's
    Voronoi diagram on a densified boundary.

    Algorithm:
      1. Densify the polygon boundary with points every *sample_dist* metres
      2. Compute the Voronoi diagram of those boundary points
      3. Keep Voronoi edges that lie inside the polygon
      4. Union those edges → the medial axis skeleton
      5. Extract the longest connected LineString as the centerline

    Returns None if the polygon is degenerate (area ≈ 0).
    """
    if polygon.is_empty or polygon.area < 1e-8:
        return None

    boundary = polygon.boundary
    if boundary.is_empty:
        return None

    # Densify the boundary — add intermediate points so Voronoi captures
    # the corridor shape accurately
    coords = list(boundary.coords) if boundary.geom_type == "LineString" else []
    if boundary.geom_type in ("MultiLineString", "LinearRing", "GeometryCollection"):
        for part in getattr(boundary, "geoms", [boundary]):
            if hasattr(part, "coords"):
                coords.extend(part.coords)

    if len(coords) < 3:
        return None

    densified = _densify_coords(coords, sample_dist)
    if len(densified) < 3:
        return None

    multipoint = MultiPoint(densified)

    try:
        voronoi = voronoi_diagram(multipoint, envelope=polygon.buffer(0.1))
    except Exception:
        return None

    # Collect Voronoi edges that fall inside the corridor polygon
    inside_lines: list[LineString] = []
    for region in voronoi.geoms:
        if region.is_empty:
            continue
        # Each Voronoi region is a polygon — its boundary is the skeleton edges
        region_boundary = region.boundary
        parts = (
            list(region_boundary.geoms)
            if region_boundary.geom_type in ("MultiLineString", "GeometryCollection")
            else [region_boundary]
        )
        for part in parts:
            if not isinstance(part, LineString):
                continue
            # Keep edges (or parts of edges) that lie inside the corridor
            clipped = part.intersection(polygon)
            if clipped.is_empty:
                continue
            if clipped.geom_type == "LineString":
                inside_lines.append(clipped)
            elif clipped.geom_type in ("MultiLineString", "GeometryCollection"):
                for sub in clipped.geoms:
                    if isinstance(sub, LineString):
                        inside_lines.append(sub)

    if not inside_lines:
        return None

    # Merge into a single connected skeleton
    skeleton = linemerge(MultiLineString(inside_lines))

    if skeleton.is_empty:
        return None

    if skeleton.geom_type == "LineString":
        return skeleton

    # MultiLineString → keep the longest connected component
    if skeleton.geom_type in ("MultiLineString", "GeometryCollection"):
        lines = [g for g in skeleton.geoms if isinstance(g, LineString)]
        if not lines:
            return None
        return max(lines, key=lambda l: l.length)

    return None


def _densify_coords(
    coords: Sequence[tuple[float, float]], max_dist: float
) -> list[tuple[float, float]]:
    """Insert intermediate points along a coordinate sequence so that no
    consecutive pair is farther than *max_dist* apart."""
    result: list[tuple[float, float]] = [coords[0]]
    for i in range(1, len(coords)):
        p1 = np.array(coords[i - 1])
        p2 = np.array(coords[i])
        seg_len = float(np.linalg.norm(p2 - p1))
        if seg_len <= max_dist:
            result.append(coords[i])
        else:
            n_inserts = max(1, int(math.ceil(seg_len / max_dist)))
            for j in range(1, n_inserts + 1):
                t = j / n_inserts
                pt = tuple(p1 + t * (p2 - p1))
                result.append(pt)
    return result


def extract_centerlines(
    corridors: gpd.GeoDataFrame,
    sample_dist: float = 2.0,
    *,
    geometry_column: str = "geometry",
) -> gpd.GeoDataFrame:
    """Extract a medial-axis centerline from each corridor polygon.

    Parameters
    ----------
    corridors : GeoDataFrame
        Corridor polygons (output of :func:`build_corridor_polygons`).
    sample_dist : float
        Densification distance for Voronoi sampling (metres).

    Returns
    -------
    GeoDataFrame
        One row per corridor, with a LineString centerline geometry.
    """
    if corridors.empty:
        return gpd.GeoDataFrame(columns=[geometry_column], crs=corridors.crs)

    orig_crs = corridors.crs
    work = corridors.copy()

    # Project to metric CRS for Voronoi computation
    if orig_crs and orig_crs.is_geographic:
        utm_zone = _utm_zone(work)
        work = work.to_crs(f"+proj=utm +zone={utm_zone} +datum=WGS84")
    else:
        utm_zone = None

    centerlines: list[LineString] = []
    for geom in work[geometry_column]:
        if geom.geom_type == "Polygon":
            cl = _voronoi_centerline(geom, sample_dist)
        elif geom.geom_type == "MultiPolygon":
            # Process each polygon and merge
            parts = []
            for poly in geom.geoms:
                cl = _voronoi_centerline(poly, sample_dist)
                if cl:
                    parts.append(cl)
            cl = linemerge(MultiLineString(parts)) if parts else None
            if cl and cl.geom_type == "MultiLineString":
                cl = max(cl.geoms, key=lambda l: l.length)
        else:
            cl = None
        centerlines.append(cl)

    result = gpd.GeoDataFrame(
        geometry=centerlines,
        crs=work.crs,
    )

    # Drop empty / None rows
    result = result.dropna(subset=["geometry"]).reset_index(drop=True)

    # Project back
    if utm_zone is not None:
        result = result.to_crs(orig_crs)

    return result


# ---------------------------------------------------------------------------
# 3. Snap manhole points onto centerlines
# ---------------------------------------------------------------------------

def snap_manholes_to_centerlines(
    manholes: gpd.GeoDataFrame,
    centerlines: gpd.GeoDataFrame,
    tolerance_m: float = 3.0,
    *,
    manhole_geometry_column: str = "geometry",
    centerline_geometry_column: str = "geometry",
) -> gpd.GeoDataFrame:
    """Snap each manhole point to the nearest centreline within *tolerance_m*.

    Parameters
    ----------
    manholes : GeoDataFrame
        Point features representing manhole locations.
    centerlines : GeoDataFrame
        LineString features (the consolidated centerlines).
    tolerance_m : float
        Maximum snap distance in metres. Manholes farther than this from
        any centerline are left at their original position.

    Returns
    -------
    GeoDataFrame
        Copy of *manholes* with geometries snapped to the nearest centerline.
    """
    if manholes.empty or centerlines.empty:
        return manholes.copy()

    orig_crs = manholes.crs
    mh = manholes.copy()
    cl = centerlines.copy()

    # Project to metric CRS for accurate snapping
    if orig_crs and orig_crs.is_geographic:
        utm_zone = _utm_zone(mh)
        mh = mh.to_crs(f"+proj=utm +zone={utm_zone} +datum=WGS84")
        cl = cl.to_crs(f"+proj=utm +zone={utm_zone} +datum=WGS84")
        utm_zone_num = utm_zone
    else:
        utm_zone_num = None

    # Union all centerlines for a single snap target
    all_lines = unary_union(cl[centerline_geometry_column].tolist())

    snapped_coords: list[tuple[float, float]] = []
    for pt in mh[manhole_geometry_column]:
        snapped_pt = snap(pt, all_lines, tolerance_m)
        if snapped_pt.equals(pt):
            # snap didn't move it — check if within tolerance manually
            dist = pt.distance(all_lines)
            if dist <= tolerance_m:
                # Project point onto nearest line
                nearest_line = _nearest_line(pt, all_lines)
                if nearest_line:
                    projected = nearest_line.interpolate(nearest_line.project(pt))
                    snapped_coords.append((projected.x, projected.y))
                else:
                    snapped_coords.append((pt.x, pt.y))
            else:
                snapped_coords.append((pt.x, pt.y))
        elif snapped_pt.geom_type == "Point":
            snapped_coords.append((snapped_pt.x, snapped_pt.y))
        else:
            # snap returned a different geometry type — use nearest point on line
            nearest_line = _nearest_line(pt, all_lines)
            if nearest_line:
                projected = nearest_line.interpolate(nearest_line.project(pt))
                snapped_coords.append((projected.x, projected.y))
            else:
                snapped_coords.append((pt.x, pt.y))

    mh[manhole_geometry_column] = gpd.points_from_xy(
        [c[0] for c in snapped_coords],
        [c[1] for c in snapped_coords],
        crs=mh.crs,
    )

    # Project back
    if utm_zone_num is not None:
        mh = mh.to_crs(orig_crs)

    return mh


def _nearest_line(point: Point, geometry) -> LineString | None:
    """Find the nearest LineString to *point* within a geometry collection."""
    if isinstance(geometry, LineString):
        return geometry
    if isinstance(geometry, MultiLineString):
        return min(geometry.geoms, key=lambda l: l.distance(point))
    if hasattr(geometry, "geoms"):
        lines = [g for g in geometry.geoms if isinstance(g, LineString)]
        if lines:
            return min(lines, key=lambda l: l.distance(point))
    return None


# ---------------------------------------------------------------------------
# 4. Full pipeline — end-to-end consolidation
# ---------------------------------------------------------------------------

def consolidate_drainage_network(
    drainage_lines: gpd.GeoDataFrame,
    manholes: gpd.GeoDataFrame | None = None,
    buffer_m: float = 2.5,
    snap_tolerance_m: float = 3.0,
    sample_dist: float = 2.0,
) -> dict:
    """End-to-end pipeline: duplicate drainage lines → clean centerline.

    Parameters
    ----------
    drainage_lines : GeoDataFrame
        Raw drainage LineStrings (may contain parallel duplicates).
    manholes : GeoDataFrame | None
        Optional manhole Point layer to snap onto the new centerlines.
    buffer_m : float
        Corridor half-width for buffer+dissolve (metres, default 2.5).
    snap_tolerance_m : float
        Max snap distance for manhole points (metres, default 3.0).
    sample_dist : float
        Voronoi densification distance (metres, default 2.0).

    Returns
    -------
    dict with keys:
        ``"corridors"``   — dissolved corridor polygons (GeoDataFrame)
        ``"centerlines"`` — clean single centerlines (GeoDataFrame)
        ``"manholes"``    — snapped manhole points (GeoDataFrame, if provided)
        ``"stats"``       — summary counts
    """
    # Step 1: buffer + dissolve → corridor polygons
    corridors = build_corridor_polygons(drainage_lines, buffer_m=buffer_m)

    # Step 2: extract medial axis centerlines
    centerlines = extract_centerlines(corridors, sample_dist=sample_dist)

    # Step 3: snap manholes
    snapped_manholes = None
    if manholes is not None and not manholes.empty:
        snapped_manholes = snap_manholes_to_centerlines(
            manholes, centerlines, tolerance_m=snap_tolerance_m
        )

    stats = {
        "input_line_count": len(drainage_lines),
        "corridor_count": len(corridors),
        "output_centerline_count": len(centerlines),
        "manhole_count": len(manholes) if manholes is not None else 0,
        "manholes_snapped": (
            len(snapped_manholes) if snapped_manholes is not None else 0
        ),
    }

    return {
        "corridors": corridors,
        "centerlines": centerlines,
        "manholes": snapped_manholes,
        "stats": stats,
    }


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import sys

    if len(sys.argv) < 3:
        print(
            "Usage: python drainage_consolidation.py <drainage.geojson> <manholes.geojson> [buffer_m] [snap_tolerance_m]"
        )
        print("  drainage.geojson  — LineStrings of the raw drainage network")
        print("  manholes.geojson  — Points of manhole locations")
        print("  buffer_m          — corridor half-width in metres (default 2.5)")
        print("  snap_tolerance_m  — max snap distance in metres (default 3.0)")
        sys.exit(1)

    drain_path = sys.argv[1]
    manhole_path = sys.argv[2]
    buf_m = float(sys.argv[3]) if len(sys.argv) > 3 else 2.5
    snap_m = float(sys.argv[4]) if len(sys.argv) > 4 else 3.0

    print(f"Loading drainage lines from {drain_path} ...")
    drain_gdf = gpd.read_file(drain_path)
    print(f"  {len(drain_gdf)} LineStrings loaded")

    print(f"Loading manholes from {manhole_path} ...")
    mh_gdf = gpd.read_file(manhole_path)
    print(f"  {len(mh_gdf)} manholes loaded")

    result = consolidate_drainage_network(
        drain_gdf, mh_gdf, buffer_m=buf_m, snap_tolerance_m=snap_m
    )

    stats = result["stats"]
    print("\n=== Consolidation Complete ===")
    print(f"  Input lines:       {stats['input_line_count']}")
    print(f"  Corridor polygons: {stats['corridor_count']}")
    print(f"  Output lines:      {stats['output_centerline_count']}")
    print(f"  Manholes snapped:  {stats['manholes_snapped']}/{stats['manhole_count']}")

    out_drain = "consolidated_centerlines.geojson"
    out_manholes = "snapped_manholes.geojson"
    result["centerlines"].to_file(out_drain, driver="GeoJSON")
    print(f"\n  Saved centerlines → {out_drain}")
    if result["manholes"] is not None:
        result["manholes"].to_file(out_manholes, driver="GeoJSON")
        print(f"  Saved manholes    → {out_manholes}")

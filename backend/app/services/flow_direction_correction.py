"""Drainage Flow Direction Correction Utility

Corrects the flow direction of a drainage network line layer by sampling
elevation from a DTM raster at each line's start and end vertices. Lines
drawn uphill (end Z > start Z) are reversed so every segment points
downhill, ensuring physically correct gravity flow.

Dependencies: geopandas, shapely, rasterio, numpy
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Sequence

import geopandas as gpd
import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.warp import transform as warp_transform
from shapely.geometry import LineString, MultiLineString
from shapely.ops import transform as shapely_transform

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Core elevation sampling
# ---------------------------------------------------------------------------

def sample_dtm_elevation(
    raster_path: str | Path,
    lon: float,
    lat: float,
    *,
    src_crs: CRS | None = None,
) -> float | None:
    """Sample a single elevation value from a DTM raster at (lon, lat).

    Parameters
    ----------
    raster_path : str | Path
        Path to the GeoTIFF DTM.
    lon, lat : float
        Longitude and latitude of the query point (WGS-84 by default).
    src_crs : CRS | None
        CRS of the input coordinates. If None, assumes EPSG:4326.

    Returns
    -------
    float | None
        Elevation in metres, or None if the point falls outside the raster
        or on a nodata pixel.
    """
    with rasterio.open(raster_path) as src:
        # Reproject query point into the raster's CRS if needed
        raster_crs = src.crs
        input_crs = src_crs or CRS.from_epsg(4326)

        if raster_crs and input_crs != raster_crs:
            xs, ys = warp_transform(input_crs, raster_crs, [lon], [lat])
            q_x, q_y = xs[0], ys[0]
        else:
            q_x, q_y = lon, lat

        # Check bounds
        if not (src.bounds.left <= q_x <= src.bounds.right and
                src.bounds.bottom <= q_y <= src.bounds.top):
            return None

        # Sample — row, col from coordinates
        try:
            row, col = rasterio.transform.rowcol(src.transform, q_x, q_y)
        except Exception:
            return None

        if row < 0 or row >= src.height or col < 0 or col >= src.width:
            return None

        values = src.read(1, window=((row, row + 1), (col, col + 1)))
        val = float(values[0, 0])

        if src.nodata is not None and np.isclose(val, src.nodata):
            return None
        if np.isnan(val) or np.isinf(val):
            return None

        return val


def sample_dtm_elevations_batch(
    raster_path: str | Path,
    coords: Sequence[tuple[float, float]],
    *,
    src_crs: CRS | None = None,
) -> list[float | None]:
    """Sample elevations for a sequence of (lon, lat) coordinates in one
    raster read pass — much faster than calling :func:`sample_dtm_elevation`
    per point.

    Parameters
    ----------
    raster_path : str | Path
        Path to the GeoTIFF DTM.
    coords : Sequence[tuple[float, float]]
        (lon, lat) pairs in *src_crs* (default WGS-84).
    src_crs : CRS | None
        CRS of the input coordinates.

    Returns
    -------
    list[float | None]
        Elevation per coordinate, None where outside bounds or nodata.
    """
    if not coords:
        return []

    input_crs = src_crs or CRS.from_epsg(4326)

    with rasterio.open(raster_path) as src:
        raster_crs = src.crs

        # Reproject all points at once
        lons = [c[0] for c in coords]
        lats = [c[1] for c in coords]

        if raster_crs and input_crs != raster_crs:
            xs, ys = warp_transform(input_crs, raster_crs, lons, lats)
        else:
            xs, ys = lons, lats

        results: list[float | None] = []
        for q_x, q_y in zip(xs, ys):
            if not (src.bounds.left <= q_x <= src.bounds.right and
                    src.bounds.bottom <= q_y <= src.bounds.top):
                results.append(None)
                continue

            try:
                row, col = rasterio.transform.rowcol(src.transform, q_x, q_y)
            except Exception:
                results.append(None)
                continue

            if row < 0 or row >= src.height or col < 0 or col >= src.width:
                results.append(None)
                continue

            val = float(src.read(1, window=((row, row + 1), (col, col + 1)))[0, 0])

            if src.nodata is not None and np.isclose(val, src.nodata):
                results.append(None)
            elif np.isnan(val) or np.isinf(val):
                results.append(None)
            else:
                results.append(val)

        return results


# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------

def reverse_linestring(line: LineString) -> LineString:
    """Return a new LineString with reversed coordinate order."""
    return LineString(list(line.coords)[::-1])


def _extract_endpoints(line: LineString) -> tuple[tuple[float, float], tuple[float, float]]:
    """Return (start_xy, end_xy) for a LineString."""
    coords = list(line.coords)
    return (coords[0][0], coords[0][1]), (coords[-1][0], coords[-1][1])


def _extract_all_vertices(line: LineString) -> list[tuple[float, float]]:
    """Return all (x, y) vertices of a LineString."""
    return [(c[0], c[1]) for c in line.coords]


# ---------------------------------------------------------------------------
# Main correction pipeline
# ---------------------------------------------------------------------------

def correct_flow_direction(
    drainage_path: str | Path,
    dtm_path: str | Path,
    output_path: str | Path | None = None,
    *,
    source_crs: CRS | None = None,
    max_uphill_tolerance_m: float = 0.0,
) -> gpd.GeoDataFrame:
    """Correct the flow direction of every drainage line so it points
    downhill, using a DTM raster as the elevation reference.

    Algorithm
    ---------
    1. Load the drainage LineString layer and the DTM raster.
    2. For each line, sample the DTM at the start vertex and end vertex.
    3. If end_elev > start_elev + tolerance (i.e. the line is drawn uphill),
       reverse its coordinate sequence so it flows downhill.
    4. Optionally save the corrected layer to disk.

    Parameters
    ----------
    drainage_path : str | Path
        Path to the drainage LineString vector file (GeoJSON, Shapefile, etc.).
    dtm_path : str | Path
        Path to the DTM GeoTIFF raster.
    output_path : str | Path | None
        Where to write the corrected layer. If None, nothing is saved.
    source_crs : CRS | None
        CRS of the drainage layer. If None, reads from the file metadata.
    max_uphill_tolerance_m : float
        Maximum uphill difference (in metres) to tolerate before reversing.
        Default 0.0 means any uphill difference triggers a reversal.

    Returns
    -------
    GeoDataFrame
        Corrected drainage network with an added column:
        - ``"elev_start"``  — DTM elevation at the start vertex
        - ``"elev_end"``    — DTM elevation at the end vertex
        - ``"reversed"``    — True if the line was flipped
        - ``"slope_pct"``   — computed slope as percentage (rise/run × 100)
    """
    log.info("Loading drainage network from %s", drainage_path)
    gdf = gpd.read_file(drainage_path)
    original_crs = gdf.crs
    if source_crs:
        gdf = gdf.set_crs(source_crs, allow_override=True)

    log.info("Loaded %d features", len(gdf))

    # Collect start and end coordinates for batch sampling
    start_coords: list[tuple[float, float]] = []
    end_coords: list[tuple[float, float]] = []
    line_indices: list[int] = []

    for idx, geom in gdf.geometry.items():
        if geom is None or geom.is_empty:
            start_coords.append((np.nan, np.nan))
            end_coords.append((np.nan, np.nan))
            line_indices.append(idx)
            continue

        # Handle MultiLineString by taking the longest part
        line = _longest_line(geom)
        if line is None:
            start_coords.append((np.nan, np.nan))
            end_coords.append((np.nan, np.nan))
            line_indices.append(idx)
            continue

        s, e = _extract_endpoints(line)
        start_coords.append(s)
        end_coords.append(e)
        line_indices.append(idx)

    # Batch-sample DTM elevations
    log.info("Sampling DTM at %d start + %d end vertices ...", len(start_coords), len(end_coords))
    all_coords = start_coords + end_coords
    # Filter out NaN coords for batch query
    valid_mask = [not (np.isnan(c[0]) or np.isnan(c[1])) for c in all_coords]
    valid_coords = [c for c, v in zip(all_coords, valid_mask) if v]

    valid_elevs = sample_dtm_elevations_batch(dtm_path, valid_coords) if valid_coords else []

    # Rebuild full elevation arrays (with None for invalid coords)
    all_elevs: list[float | None] = []
    vi = 0
    for v in valid_mask:
        if v:
            all_elevs.append(valid_elevs[vi])
            vi += 1
        else:
            all_elevs.append(None)

    n = len(start_coords)
    start_elevs = all_elevs[:n]
    end_elevs = all_elevs[n:]

    # Apply reversals
    reversed_count = 0
    elev_start_col = []
    elev_end_col = []
    reversed_col = []
    slope_col = []

    for i, idx in enumerate(line_indices):
        s_elev = start_elevs[i]
        e_elev = end_elevs[i]

        elev_start_col.append(s_elev)
        elev_end_col.append(e_elev)

        geom = gdf.at[idx, "geometry"]
        if geom is None or geom.is_empty or s_elev is None or e_elev is None:
            reversed_col.append(False)
            slope_col.append(None)
            continue

        line = _longest_line(geom)
        if line is None:
            reversed_col.append(False)
            slope_col.append(None)
            continue

        uphill = e_elev - s_elev
        if uphill > max_uphill_tolerance_m:
            # Reverse the geometry
            new_geom = reverse_linestring(line)
            gdf.at[idx, "geometry"] = new_geom
            reversed_col.append(True)
            reversed_count += 1

            # Recompute slope with reversed elevations
            length_m = new_geom.length
            if length_m > 0:
                slope_pct = ((s_elev - e_elev) / length_m) * 100
            else:
                slope_pct = None
            slope_col.append(round(slope_pct, 4) if slope_pct is not None else None)
        else:
            reversed_col.append(False)
            length_m = line.length
            if length_m > 0:
                slope_pct = ((e_elev - s_elev) / length_m) * 100
            else:
                slope_pct = None
            slope_col.append(round(slope_pct, 4) if slope_pct is not None else None)

    gdf["elev_start"] = elev_start_col
    gdf["elev_end"] = elev_end_col
    gdf["reversed"] = reversed_col
    gdf["slope_pct"] = slope_col

    log.info(
        "Corrected %d / %d lines (reversed uphill → downhill)",
        reversed_count,
        len(gdf),
    )

    if output_path:
        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        gdf.to_file(output_path)
        log.info("Saved corrected layer → %s", output_path)

    return gdf


def _longest_line(geom) -> LineString | None:
    """Extract the longest LineString from any geometry type."""
    if isinstance(geom, LineString):
        return geom
    if isinstance(geom, MultiLineString):
        return max(geom.geoms, key=lambda l: l.length)
    if hasattr(geom, "geoms"):
        lines = [g for g in geom.geoms if isinstance(g, LineString)]
        if lines:
            return max(lines, key=lambda l: l.length)
    return None


# ---------------------------------------------------------------------------
# Summary / reporting
# ---------------------------------------------------------------------------

def print_correction_report(gdf: gpd.GeoDataFrame) -> None:
    """Print a human-readable summary of the correction run."""
    total = len(gdf)
    reversed_count = int(gdf["reversed"].sum())
    ok_count = total - reversed_count
    with_slope = gdf["slope_pct"].notna().sum()

    print("\n=== Flow Direction Correction Report ===")
    print(f"  Total lines:              {total}")
    print(f"  Already correct (downhill): {ok_count}")
    print(f"  Reversed (uphill→downhill):  {reversed_count}")
    print(f"  Lines with valid slope:    {with_slope}")

    elev_start = gdf["elev_start"].dropna()
    elev_end = gdf["elev_end"].dropna()
    if len(elev_start) > 0:
        print(f"\n  Start vertex elevation range: {elev_start.min():.2f} – {elev_start.max():.2f} m")
    if len(elev_end) > 0:
        print(f"  End vertex elevation range:   {elev_end.min():.2f} – {elev_end.max():.2f} m")

    slopes = gdf["slope_pct"].dropna()
    if len(slopes) > 0:
        print(f"\n  Slope range:  {slopes.min():.4f}% – {slopes.max():.4f}%")
        print(f"  Mean slope:   {slopes.mean():.4f}%")

    reversed_lines = gdf[gdf["reversed"]]
    if len(reversed_lines) > 0:
        print(f"\n  Reversed line IDs:")
        for idx, row in reversed_lines.head(20).iterrows():
            fid = row.get("id", row.get("ID", idx))
            print(f"    {fid}: {row['elev_start']:.2f}m → {row['elev_end']:.2f}m (slope {row['slope_pct']:.2f}%)")
        if len(reversed_lines) > 20:
            print(f"    ... and {len(reversed_lines) - 20} more")
    print()


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import sys

    if len(sys.argv) < 3:
        print(
            "Usage: python flow_direction_correction.py <drainage.geojson> <dtm.tif> [output.geojson]"
        )
        print()
        print("  drainage.geojson — LineStrings of the drainage network")
        print("  dtm.tif          — DTM GeoTIFF raster (elevation in metres)")
        print("  output.geojson   — Output path (default: corrected_drainage.geojson)")
        sys.exit(1)

    drain_path = sys.argv[1]
    dtm_path = sys.argv[2]
    out_path = sys.argv[3] if len(sys.argv) > 3 else "corrected_drainage.geojson"

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    result = correct_flow_direction(drain_path, dtm_path, out_path)
    print_correction_report(result)

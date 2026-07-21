"""
LidarReader — LAS / LAZ (airborne or terrestrial LiDAR point cloud) files.

Reads point cloud data with laspy (LAZ decompression via the lazrs backend)
and produces two things, mirroring RasterReader so LiDAR datasets plug into
the exact same map-overlay and preview-recolouring pipeline as GeoTIFFs:

1. A Digital Surface Model (highest point per grid cell), warped to
   EPSG:4326 with rasterio the same way RasterReader warps GeoTIFF bands,
   rendered as a single-band (grey+alpha) preview PNG. `/raster-preview.png`
   already recolours any stored grey+alpha preview into the rainbow/
   hillshade "Enhanced" rendering regardless of source format, so nothing
   about that endpoint needed to change.
2. A sparse sample of individual points (as `Feature` rows) carrying
   elevation/intensity/classification, so the point cloud participates in
   the feature table / severity / AI-summary pipeline like every other
   dataset type.

The file is read in chunks (`laspy`'s `chunk_iterator`) rather than loaded
into memory at once — real point clouds routinely carry tens of millions of
points, and this keeps memory flat regardless of file size.

Coordinate reference system: LAS/LAZ embeds its CRS either as a WKT VLR
(LAS 1.4) or GeoTIFF-style GeoKeys (LAS <=1.3); `laspy`'s
`header.parse_crs()` reads both. If a file has neither (raw sensor dumps
sometimes omit it), the dataset loads in local-coordinate mode with a clear
warning — it is NOT marked as failed. A CRS can be assigned later.
"""
from __future__ import annotations

import asyncio
import io
import json
import logging
import math
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
from geoalchemy2.shape import from_shape
from shapely.geometry import Point

from app.db.session import SessionLocal
from app.models import Feature
from app.services.readers.base import ReaderResult
from app.services.storage import upload_stream

log = logging.getLogger("davangere.readers.lidar")

_LIDAR_SUFFIXES = {".las", ".laz"}
_BATCH_SIZE = 500
_MAX_SAMPLE_POINTS = 200       # Feature rows carrying per-point attributes
_MAX_STAT_SAMPLE = 50_000      # points sampled for the percentile stretch
_CHUNK_SIZE = 1_000_000        # points read per laspy chunk
_GRID_DIM = 512                # DSM grid resolution (cells per side)
_MAX_PREVIEW_DIM = 1600        # longest edge of the rendered preview image, px
_DST_CRS = "EPSG:4326"

# ASPRS standard LAS classification codes (the common subset — anything
# outside this set is still counted, just labelled "class_<code>").
_CLASSIFICATION_NAMES: dict[int, str] = {
    0: "created_never_classified",
    1: "unclassified",
    2: "ground",
    3: "low_vegetation",
    4: "medium_vegetation",
    5: "high_vegetation",
    6: "building",
    7: "low_point_noise",
    8: "model_key_reserved",
    9: "water",
    10: "rail",
    11: "road_surface",
    12: "overlap",
}


def _jsonable(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, float) and math.isnan(value):
        return None
    if isinstance(value, (str, int, bool, float)):
        return value
    if hasattr(value, "item"):
        try:
            return value.item()
        except Exception:  # noqa: BLE001
            return str(value)
    return str(value)


@dataclass(slots=True)
class _SamplePoint:
    lat: float
    lon: float
    z: float
    intensity: float | None
    classification: int | None
    return_number: int | None


@dataclass(slots=True)
class _ParsedLidar:
    points: list[_SamplePoint]
    point_count: int
    z_min: float
    z_max: float
    z_mean: float
    classification_counts: dict[str, int]
    crs: str
    crs_status: str
    georeferenced: bool
    filename: str
    preview_png: bytes | None
    preview_bounds: tuple[float, float, float, float] | None
    warnings: list[dict[str, str]] = field(default_factory=list)
    skipped: int = field(default=0)
    bounds_raw: tuple[float, float, float, float, float, float] | None = None
    scales: list[float] = field(default_factory=list)
    offsets: list[float] = field(default_factory=list)
    las_version: str = ""
    point_format: int = 0
    dimensions: list[str] = field(default_factory=list)


def _detect_crs_from_vlrs(header: Any) -> str | None:
    """
    Method 2: Inspect VLR/EVLR records for CRS information.
    
    Looks for:
    - user_id 'LASF_Projection' with standard record IDs
    - record_id 34735: GeoKeyDirectoryTag
    - record_id 34736: GeoDoubleParamsTag
    - record_id 34737: GeoAsciiParamsTag
    """
    try:
        for vlr in header.vlrs:
            user_id = getattr(vlr, 'user_id', '') or ''
            record_id = getattr(vlr, 'record_id', 0)
            
            # Standard LASF_Projection VLRs
            if user_id.strip() == 'LASF_Projection':
                if record_id in (34735, 34736, 34737):
                    # GeoKeys present — CRS exists but we need parse_crs() to decode it
                    # If parse_crs() already failed, the keys are malformed
                    return None
            
            # WKT VLR (LAS 1.4)
            if record_id in (2111, 2112):
                try:
                    wkt_data = bytes(vlr.record_data)
                    if wkt_data:
                        wkt_str = wkt_data.decode('utf-8', errors='ignore').rstrip('\x00')
                        if wkt_str.startswith('GEOGCS') or wkt_str.startswith('PROJCS') or wkt_str.startswith('GEOGCS|'):
                            return f"WKT:{wkt_str[:100]}"
                except Exception:
                    pass
    except Exception as exc:
        log.debug("VLR inspection failed: %s", exc)
    
    return None


def _detect_crs_from_sidecar(file_path: Path) -> str | None:
    """
    Method 6: Check for explicit sidecar metadata files.
    
    Looks for .prj, .wkt, .json, .projjson files matching the base filename.
    """
    base = file_path.with_suffix('')
    sidecar_extensions = ['.prj', '.wkt', '.json', '.projjson']
    
    for ext in sidecar_extensions:
        sidecar = base.with_suffix(ext)
        if sidecar.exists():
            try:
                content = sidecar.read_text(encoding='utf-8', errors='ignore').strip()
                if content:
                    # Try to parse as WKT or JSON
                    if content.startswith('GEOGCS') or content.startswith('PROJCS'):
                        return f"WKT:{content[:100]}"
                    # Could be a JSON with CRS info
                    try:
                        data = json.loads(content)
                        if isinstance(data, dict):
                            crs_info = data.get('crs') or data.get('CRS') or data.get('coordinate_system')
                            if crs_info:
                                return str(crs_info)[:100]
                    except json.JSONDecodeError:
                        pass
            except Exception:
                pass
    
    return None


class LidarReader:
    """Handles airborne/terrestrial LiDAR point cloud inputs (.las / .laz)."""

    def can_handle(self, filename: str) -> bool:
        return Path(filename).suffix.lower() in _LIDAR_SUFFIXES

    async def read(self, file_path: Path, dataset_id: str) -> ReaderResult:
        parsed = await asyncio.to_thread(self._parse_sync, file_path)
        return await self._persist(parsed, dataset_id=dataset_id)

    def _parse_sync(self, file_path: Path) -> _ParsedLidar:
        try:
            import laspy
        except ImportError as exc:
            raise ValueError(
                "laspy is required to read LAS/LAZ files. Install with: pip install laspy[lazrs]"
            ) from exc

        warnings: list[dict[str, str]] = []

        # ---- Pass 1: stream the file once, accumulating everything a
        # single forward pass can produce — a DSM grid (max Z per cell),
        # running elevation stats, a classification histogram, and native-
        # CRS coordinates for a bounded point sample. --------------------
        with laspy.open(file_path) as reader:
            header = reader.header
            point_count = int(header.point_count)
            if point_count == 0:
                raise ValueError("LAS/LAZ file has no points")

            # Basic validation
            file_signature = header.file_signature
            if file_signature != b"LASF":
                raise ValueError("Invalid LAS/LAZ file: bad LASF signature")

            # Extract basic metadata
            las_version = f"{header.version.major}.{header.version.minor}"
            point_format_id = int(header.point_format.id)
            scales = [float(v) for v in header.scales[:3]]
            offsets_list = [float(v) for v in header.offsets[:3]]
            dim_names = sorted(set(header.point_format.dimension_names))

            # CRS detection — Method 1: laspy header.parse_crs()
            crs = None
            crs_status = "unknown"
            try:
                crs = header.parse_crs()
                if crs is not None:
                    crs_status = "embedded"
                    log.info("Embedded CRS detected: %s", self._crs_label(crs))
            except Exception as exc:
                log.warning("Failed to parse CRS from LAS/LAZ header: %s", exc)
                warnings.append({
                    "code": "POINT_CLOUD_CRS_MALFORMED",
                    "message": f"CRS metadata present but malformed: {exc}",
                })

            # CRS detection — Method 2: VLR/EVLR inspection
            if crs is None:
                vlr_crs = _detect_crs_from_vlrs(header)
                if vlr_crs:
                    log.info("CRS found via VLR inspection: %s", vlr_crs)
                    # VLR indicates CRS presence but parse_crs() couldn't decode it
                    warnings.append({
                        "code": "POINT_CLOUD_CRS_MALFORMED",
                        "message": "CRS VLR records present but could not be parsed",
                    })

            # CRS detection — Method 6: Sidecar files
            if crs is None:
                sidecar_crs = _detect_crs_from_sidecar(file_path)
                if sidecar_crs:
                    log.info("CRS found via sidecar: %s", sidecar_crs)

            # Determine CRS label and georeferenced status
            crs_label = self._crs_label(crs)
            georeferenced = crs is not None

            if crs is None:
                warnings.append({
                    "code": "POINT_CLOUD_CRS_UNKNOWN",
                    "message": (
                        "No embedded coordinate reference system was found. "
                        "The point cloud has been loaded using its original local coordinates."
                    ),
                })

            # Read bounds from header
            min_x, min_y, min_z = (float(v) for v in header.mins)
            maxx, maxy, maxz = (float(v) for v in header.maxs)

            if maxx <= min_x or maxy <= min_y:
                raise ValueError("LAS/LAZ file has a degenerate (zero-area) bounding box")

            has_intensity = "intensity" in dim_names
            has_classification = "classification" in dim_names
            has_return_number = "return_number" in dim_names

            grid_transform = None
            grid_max = None

            # Only build DSM grid if we have a valid CRS and can reproject
            if georeferenced:
                import rasterio
                try:
                    rio_crs = rasterio.crs.CRS.from_wkt(crs.to_wkt())
                    grid_transform = rasterio.transform.from_bounds(
                        min_x, min_y, maxx, maxy, _GRID_DIM, _GRID_DIM
                    )
                    grid_max = np.full((_GRID_DIM, _GRID_DIM), -np.inf, dtype=np.float64)
                except Exception as exc:
                    log.warning("Failed to create rasterio CRS: %s", exc)
                    georeferenced = False

            z_sum = 0.0
            z_min = math.inf
            z_max = -math.inf
            classification_counts: dict[int, int] = {}
            stat_sample: list[float] = []
            sample_native_x: list[float] = []
            sample_native_y: list[float] = []
            sample_attrs: list[tuple[float, float | None, int | None, int | None]] = []

            stat_stride = max(1, point_count // _MAX_STAT_SAMPLE)
            sample_stride = max(1, point_count // _MAX_SAMPLE_POINTS)
            seen = 0

            for chunk in reader.chunk_iterator(_CHUNK_SIZE):
                xs = np.asarray(chunk.x, dtype=np.float64)
                ys = np.asarray(chunk.y, dtype=np.float64)
                zs = np.asarray(chunk.z, dtype=np.float64)
                n = xs.shape[0]

                # Update DSM grid if available
                if grid_max is not None and grid_transform is not None:
                    rows, cols = rasterio.transform.rowcol(grid_transform, xs, ys)
                    rows = np.clip(np.asarray(rows), 0, _GRID_DIM - 1)
                    cols = np.clip(np.asarray(cols), 0, _GRID_DIM - 1)
                    flat_idx = rows * _GRID_DIM + cols
                    np.maximum.at(grid_max.reshape(-1), flat_idx, zs)

                z_sum += float(zs.sum())
                z_min = min(z_min, float(zs.min()))
                z_max = max(z_max, float(zs.max()))

                intensity_arr = np.asarray(chunk.intensity) if has_intensity else None
                class_arr = np.asarray(chunk.classification) if has_classification else None
                return_arr = np.asarray(chunk.return_number) if has_return_number else None

                if class_arr is not None:
                    codes, counts = np.unique(class_arr, return_counts=True)
                    for code, count in zip(codes.tolist(), counts.tolist()):
                        classification_counts[int(code)] = classification_counts.get(int(code), 0) + int(count)

                # Global stride offsets so sampling stays evenly spread
                stat_offset = (-seen) % stat_stride
                if stat_offset < n:
                    stat_sample.extend(zs[stat_offset::stat_stride].tolist())

                sample_offset = (-seen) % sample_stride
                for i in range(sample_offset, n, sample_stride):
                    sample_native_x.append(float(xs[i]))
                    sample_native_y.append(float(ys[i]))
                    sample_attrs.append(
                        (
                            float(zs[i]),
                            float(intensity_arr[i]) if intensity_arr is not None else None,
                            int(class_arr[i]) if class_arr is not None else None,
                            int(return_arr[i]) if return_arr is not None else None,
                        )
                    )

                seen += n

        # ---- Pass 2: coordinate transformation and point sampling ----
        skipped = 0
        points: list[_SamplePoint] = []

        if sample_native_x:
            if georeferenced and crs is not None:
                # Transform from source CRS to EPSG:4326 for map display
                import rasterio
                from rasterio.warp import transform as warp_transform
                try:
                    rio_crs = rasterio.crs.CRS.from_wkt(crs.to_wkt())
                    lons, lats = warp_transform(rio_crs, _DST_CRS, sample_native_x, sample_native_y)
                except Exception as exc:
                    log.warning("CRS transformation failed, using raw coordinates: %s", exc)
                    lons = np.array(sample_native_x)
                    lats = np.array(sample_native_y)
                    georeferenced = False
            else:
                # No CRS — preserve raw coordinates as-is for local mode
                lons = np.array(sample_native_x)
                lats = np.array(sample_native_y)

            for lon, lat, (z, intensity, classification, return_number) in zip(lons, lats, sample_attrs):
                if math.isnan(lat) or math.isnan(lon):
                    skipped += 1
                    continue

                points.append(
                    _SamplePoint(
                        lat=float(lat), lon=float(lon), z=z, intensity=intensity,
                        classification=classification, return_number=return_number,
                    )
                )

        # Build DSM preview if we have the grid
        preview_png: bytes | None = None
        preview_bounds: tuple[float, float, float, float] | None = None
        if grid_max is not None and grid_transform is not None and georeferenced:
            try:
                import rasterio
                rio_crs = rasterio.crs.CRS.from_wkt(crs.to_wkt())
                preview_png, preview_bounds = self._build_dsm_preview(
                    grid_max, grid_transform, rio_crs, stat_sample, z_min, z_max
                )
            except Exception:  # noqa: BLE001
                log.exception("Failed to build LiDAR DSM preview; continuing without it")
        elif not georeferenced:
            # For unreferenced data, build a local-coordinate preview
            try:
                preview_png, preview_bounds = self._build_local_preview(
                    sample_native_x, sample_native_y, sample_attrs, z_min, z_max
                )
            except Exception:  # noqa: BLE001
                log.exception("Failed to build local-coordinate preview; continuing without it")

        return _ParsedLidar(
            points=points,
            point_count=point_count,
            z_min=z_min,
            z_max=z_max,
            z_mean=z_sum / point_count,
            classification_counts={
                _CLASSIFICATION_NAMES.get(code, f"class_{code}"): count
                for code, count in classification_counts.items()
            },
            crs=crs_label,
            crs_status=crs_status,
            georeferenced=georeferenced,
            filename=file_path.name,
            preview_png=preview_png,
            preview_bounds=preview_bounds,
            warnings=warnings,
            skipped=skipped,
            bounds_raw=(min_x, min_y, min_z, maxx, maxy, maxz),
            scales=scales,
            offsets=offsets_list,
            las_version=las_version,
            point_format=point_format_id,
            dimensions=dim_names,
        )

    def _build_dsm_preview(
        self,
        grid_max: np.ndarray,
        grid_transform: Any,
        rio_crs: Any,
        stat_sample: list[float],
        z_min: float,
        z_max: float,
    ) -> tuple[bytes, tuple[float, float, float, float]]:
        """Percentile-stretch the DSM grid to a byte-scaled image, write it
        as a single-band GeoTIFF in the source CRS, then reproject with
        WarpedVRT exactly the way RasterReader warps GeoTIFF bands."""
        from rasterio.io import MemoryFile
        from rasterio.vrt import WarpedVRT
        from rasterio.warp import Resampling

        valid = np.isfinite(grid_max)
        p02, p98 = (np.percentile(stat_sample, [2, 98]) if stat_sample else (z_min, z_max))
        rng = (float(p98) - float(p02)) or 1.0

        scaled = np.zeros(grid_max.shape, dtype=np.uint8)
        stretched = np.clip((grid_max - p02) / rng * 255.0, 0, 255)
        scaled[valid] = stretched[valid].astype(np.uint8)

        with MemoryFile() as src_memfile:
            with src_memfile.open(
                driver="GTiff",
                height=grid_max.shape[0],
                width=grid_max.shape[1],
                count=1,
                dtype="uint8",
                crs=rio_crs,
                transform=grid_transform,
                nodata=0,
            ) as dst:
                dst.write(scaled, 1)

            with src_memfile.open() as src:
                with WarpedVRT(src, crs=_DST_CRS, resampling=Resampling.bilinear) as vrt:
                    dst_width, dst_height = vrt.width, vrt.height
                    if max(dst_width, dst_height) > _MAX_PREVIEW_DIM:
                        factor = max(dst_width, dst_height) / _MAX_PREVIEW_DIM
                        dst_width = max(1, round(dst_width / factor))
                        dst_height = max(1, round(dst_height / factor))

                    gray = vrt.read(1, out_shape=(dst_height, dst_width), resampling=Resampling.bilinear)
                    mask = vrt.read_masks(1, out_shape=(dst_height, dst_width))
                    alpha = np.where(mask > 0, 255, 0).astype(np.uint8)
                    bounds = vrt.bounds

        stacked = np.stack([gray.astype(np.uint8), alpha], axis=0)

        with MemoryFile() as out_memfile:
            with out_memfile.open(
                driver="PNG", height=dst_height, width=dst_width, count=2, dtype="uint8",
            ) as out_dst:
                out_dst.write(stacked)
            png_bytes = out_memfile.read()

        return png_bytes, tuple(bounds)

    def _build_local_preview(
        self,
        xs: list[float],
        ys: list[float],
        attrs: list[tuple[float, float | None, int | None, int | None]],
        z_min: float,
        z_max: float,
    ) -> tuple[bytes, tuple[float, float, float, float]]:
        """Build a local-coordinate preview image for unreferenced point clouds.
        
        Uses centered X/Y coordinates and maps Z to intensity for a greyscale preview.
        Returns PNG bytes and bounds in local coordinate space.
        """
        if not xs:
            return b"", (0, 0, 0, 0)

        xs_arr = np.array(xs, dtype=np.float64)
        ys_arr = np.array(ys, dtype=np.float64)
        zs = np.array([a[0] for a in attrs], dtype=np.float64)

        # Center coordinates
        cx = (xs_arr.min() + xs_arr.max()) / 2
        cy = (ys_arr.min() + ys_arr.max()) / 2

        # Local coordinates: display_x = x - cx, display_y = z - z_min
        display_x = xs_arr - cx
        display_z = zs - z_min
        display_y = -(ys_arr - cy)  # Flip Y for display

        # Create a simple scatter-to-grid preview
        grid_dim = min(_GRID_DIM, max(1, int(math.sqrt(len(xs)))))
        if grid_dim < 2:
            grid_dim = 2

        x_min, x_max = float(display_x.min()), float(display_x.max())
        y_min, y_max = float(display_y.min()), float(display_y.max())
        z_range = float(z_max - z_min) or 1.0

        # Normalize to grid
        grid_x = np.clip(((display_x - x_min) / (x_max - x_min) * (grid_dim - 1)).astype(int), 0, grid_dim - 1)
        grid_y = np.clip(((display_y - y_min) / (y_max - y_min) * (grid_dim - 1)).astype(int), 0, grid_dim - 1)

        grid = np.zeros((grid_dim, grid_dim), dtype=np.uint8)
        grid[grid_y, grid_x] = np.clip((display_z / z_range * 255), 0, 255).astype(np.uint8)

        # Scale up for preview
        scale = max(1, _MAX_PREVIEW_DIM // grid_dim)
        height = grid_dim * scale
        width = grid_dim * scale

        from rasterio.io import MemoryFile
        with MemoryFile() as out_memfile:
            with out_memfile.open(
                driver="PNG", height=height, width=width, count=1, dtype="uint8",
            ) as dst:
                # Nearest-neighbor upscaling
                from rasterio.warp import Resampling
                from rasterio.vrt import WarpedVRT
                with MemoryFile() as src_memfile:
                    with src_memfile.open(
                        driver="GTiff", height=grid_dim, width=grid_dim,
                        count=1, dtype="uint8",
                    ) as src:
                        src.write(grid, 1)
                    with src_memfile.open() as src:
                        with WarpedVRT(src, resampling=Resampling.nearest) as vrt:
                            scaled = vrt.read(1, out_shape=(height, width))
                            dst.write(scaled, 1)
            png_bytes = out_memfile.read()

        bounds = (x_min + cx, y_min + cy, x_max + cx, y_max + cy)
        return png_bytes, bounds

    async def _persist(self, parsed: _ParsedLidar, *, dataset_id: str) -> ReaderResult:
        dataset_uuid = uuid.UUID(dataset_id)
        inserted = 0
        skipped = parsed.skipped

        raster_overlay: dict[str, Any] | None = None
        if parsed.preview_png is not None and parsed.preview_bounds is not None:
            image_key = f"datasets/{dataset_id}/raster-preview.png"
            try:
                await upload_stream(
                    io.BytesIO(parsed.preview_png),
                    key=image_key,
                    content_type="image/png",
                )
                raster_overlay = {"image_key": image_key, "bounds": list(parsed.preview_bounds)}
            except Exception:  # noqa: BLE001
                log.exception("Failed to upload LiDAR DSM preview for dataset %s", dataset_id)

        z_range = (parsed.z_max - parsed.z_min) or 1.0

        batch: list[Feature] = []
        async with SessionLocal() as session:
            for i, pt in enumerate(parsed.points):
                attrs = {
                    "lidar_file": parsed.filename,
                    "crs": parsed.crs,
                    "crs_status": parsed.crs_status,
                    "elevation_m": _jsonable(pt.z),
                    "intensity": _jsonable(pt.intensity),
                    "classification": _jsonable(pt.classification),
                    "classification_name": (
                        _CLASSIFICATION_NAMES.get(pt.classification, f"class_{pt.classification}")
                        if pt.classification is not None
                        else None
                    ),
                    "return_number": _jsonable(pt.return_number),
                }

                json.dumps(attrs)  # fail fast on non-serializable content

                # Calculate severity based on Z range
                severity_val = max(0.0, min(1.0, (pt.z - parsed.z_min) / z_range))

                batch.append(
                    Feature(
                        dataset_id=dataset_uuid,
                        label=f"LiDAR point {i + 1}",
                        category="lidar_point",
                        severity=severity_val,
                        attributes=attrs,
                        geom=from_shape(Point(pt.lon, pt.lat), srid=4326),
                    )
                )
                inserted += 1

                if len(batch) >= _BATCH_SIZE:
                    session.add_all(batch)
                    await session.flush()
                    batch.clear()

            if batch:
                session.add_all(batch)
                await session.flush()

            await session.commit()

        log.info(
            "LidarReader ingested dataset_id=%s inserted=%d skipped=%d points=%d crs=%s crs_status=%s georeferenced=%s preview=%s",
            dataset_id,
            inserted,
            skipped,
            parsed.point_count,
            parsed.crs,
            parsed.crs_status,
            parsed.georeferenced,
            bool(raster_overlay),
        )

        # Build warnings list for the result
        warning_msgs = [w["message"] for w in parsed.warnings if w.get("code") == "POINT_CLOUD_CRS_UNKNOWN"]

        return ReaderResult(
            inserted=inserted,
            skipped=skipped,
            source_crs=parsed.crs if parsed.georeferenced else None,
            notes=(
                f"points={parsed.point_count}, "
                f"z_range=[{parsed.z_min:.2f}, {parsed.z_max:.2f}], "
                f"crs_status={parsed.crs_status}"
                + (f", warning={warning_msgs[0]}" if warning_msgs else "")
            ),
            raster_overlay=raster_overlay,
            dataset_metadata={
                "lidar": {
                    "point_count": parsed.point_count,
                    "z_min": parsed.z_min,
                    "z_max": parsed.z_max,
                    "z_mean": parsed.z_mean,
                    "classification_counts": parsed.classification_counts,
                    "source_crs": parsed.crs,
                    "crs_status": parsed.crs_status,
                    "georeferenced": parsed.georeferenced,
                    "las_version": parsed.las_version,
                    "point_format": parsed.point_format,
                    "dimensions": parsed.dimensions,
                    "scales": parsed.scales,
                    "offsets": parsed.offsets,
                    "bounds_raw": list(parsed.bounds_raw) if parsed.bounds_raw else None,
                    "compressed": file_path.suffix.lower() == ".laz" if hasattr(self, '_file_path') else parsed.filename.lower().endswith('.laz'),
                    "warnings": parsed.warnings,
                }
            },
        )

    def _crs_label(self, crs: Any | None) -> str:
        """
        Format a CRS object to a standardized label.
        
        When CRS is None (unknown), use a descriptive marker rather than a CRS string.
        """
        if crs is None:
            return "unknown"
        
        try:
            epsg = crs.to_epsg()
        except Exception:  # noqa: BLE001
            epsg = None
        if epsg:
            return f"EPSG:{epsg}"
        try:
            return crs.to_string()
        except Exception:  # noqa: BLE001
            return str(crs)

"""
RasterReader — GeoTIFF (.tif / .tiff) raster files.

Reads georeferenced raster data using rasterio and produces two things:

1. A full-resolution-independent preview PNG, reprojected to EPSG:4326 and
   uploaded to object storage, so the map can render the raster as an
   actual image overlay (the way QGIS/GIS desktop tools show it) instead
   of a handful of scattered dots.
2. A sparse grid of sample points (as `Feature` rows) carrying per-pixel
   band values as attributes, so the raster still participates in the
   feature table / severity / AI-summary pipeline like every other
   dataset type.

Sample-point coordinates and the preview image are BOTH reprojected to
EPSG:4326 — `rasterio`'s `xy()` returns coordinates in the raster's own
CRS, which for real-world orthomosaics/DEMs is almost always a projected
CRS in metres (e.g. UTM), not degrees. Treating those directly as
lon/lat (as this reader previously did) makes nearly every sample point
fail a `-180..180 / -90..90` sanity check and get silently dropped.
"""
from __future__ import annotations

import asyncio
import io
import json
import logging
import math
import tempfile
import uuid
import zipfile
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

log = logging.getLogger("davangere.readers.raster")

_RASTER_SUFFIXES = {".tif", ".tiff", ".geotiff", ".ecw"}
_ARCHIVE_SUFFIX = ".zip"
_BATCH_SIZE = 500
_MAX_SAMPLE_POINTS = 200  # Max points to extract from raster
_MAX_PREVIEW_DIM = 1600  # Longest edge of the rendered preview image, px
_DST_CRS = "EPSG:4326"


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
    row: int
    col: int
    pixels: dict[str, float | None]


@dataclass(slots=True)
class _ParsedRaster:
    points: list[_SamplePoint]
    band_stats: dict[str, dict[str, float]]
    band_count: int
    width: int
    height: int
    crs: str
    filename: str
    preview_png: bytes | None
    preview_bounds: tuple[float, float, float, float] | None  # (w, s, e, n) in EPSG:4326
    skipped: int = field(default=0)


class RasterReader:
    """Handles GeoTIFF raster inputs."""

    def can_handle(self, filename: str) -> bool:
        return Path(filename).suffix.lower() in _RASTER_SUFFIXES

    async def read(self, file_path: Path, dataset_id: str) -> ReaderResult:
        parsed = await asyncio.to_thread(self._parse_input_sync, file_path)
        return await self._persist(parsed, dataset_id=dataset_id)

    def _parse_input_sync(self, file_path: Path) -> _ParsedRaster:
        if file_path.suffix.lower() != _ARCHIVE_SUFFIX:
            return self._parse_sync(file_path)

        with tempfile.TemporaryDirectory(prefix="raster_zip_") as tmpdir:
            root = Path(tmpdir)
            try:
                with zipfile.ZipFile(file_path) as zf:
                    candidates = [
                        name
                        for name in zf.namelist()
                        if not name.endswith("/")
                        and Path(name).suffix.lower() in _RASTER_SUFFIXES
                    ]
                    if not candidates:
                        raise ValueError(
                            "Raster ZIP does not contain a .tif, .tiff, .geotiff, or .ecw file"
                        )
                    if len(candidates) > 1:
                        raise ValueError(
                            "Raster ZIP contains multiple raster files. Upload each DSM/DTM/ECW "
                            "raster as a separate dataset: " + ", ".join(candidates[:8])
                        )

                    # Extract all safe members so sidecar files such as .aux.xml,
                    # .ovr, and .prj remain available to GDAL.
                    for member in zf.infolist():
                        if member.is_dir():
                            continue
                        member_path = Path(member.filename.replace("\\", "/"))
                        if member_path.is_absolute() or ".." in member_path.parts:
                            raise ValueError(
                                f"Unsafe path found in raster ZIP: {member.filename}"
                            )
                        destination = root.joinpath(*member_path.parts)
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        with zf.open(member) as src, destination.open("wb") as dst:
                            while chunk := src.read(1024 * 1024):
                                dst.write(chunk)
            except zipfile.BadZipFile as exc:
                raise ValueError("Uploaded raster ZIP is invalid or corrupted") from exc

            inner_path = root.joinpath(*Path(candidates[0].replace("\\", "/")).parts)
            parsed = self._parse_sync(inner_path)
            parsed.filename = Path(candidates[0]).name
            return parsed

    def _parse_sync(self, file_path: Path) -> _ParsedRaster:
        try:
            import rasterio
            from rasterio.warp import transform as warp_transform
        except ImportError as exc:
            raise ValueError(
                "rasterio is required to read GeoTIFF files. "
                "Install with: pip install rasterio"
            ) from exc

        skipped = 0

        suffix = file_path.suffix.lower()
        if suffix == ".ecw":
            with rasterio.Env() as env:
                if "ECW" not in env.drivers():
                    raise ValueError(
                        "ECW decoding is not available in this server's GDAL build. "
                        "Convert the ECW to GeoTIFF (.tif) or install a GDAL ECW driver."
                    )

        try:
            src_context = rasterio.open(file_path)
        except Exception as exc:  # noqa: BLE001
            raise ValueError(f"Could not open raster '{file_path.name}': {exc}") from exc

        with src_context as src:
            if src.crs is None:
                raise ValueError(
                    f"Raster '{file_path.name}' has no coordinate reference system. "
                    "Assign the correct CRS before upload so it can be placed on the map."
                )
            transform = src.transform
            crs = str(src.crs)
            width = src.width
            height = src.height
            band_count = src.count
            nodata = src.nodata

            n_points = min(_MAX_SAMPLE_POINTS, width * height)
            n_cols = max(2, int(math.sqrt(n_points * (width / max(height, 1)))))
            n_rows = max(2, int(n_points / max(n_cols, 1)))
            col_step = max(1, width // n_cols)
            row_step = max(1, height // n_rows)

            band_stats: dict[str, dict[str, float]] = {}
            for band_idx in range(1, band_count + 1):
                try:
                    data = src.read(band_idx)
                    if nodata is not None:
                        data = data[data != nodata]
                    if data.size > 0:
                        band_stats[f"band_{band_idx}"] = {
                            "min": float(data.min()),
                            "max": float(data.max()),
                            "mean": float(data.mean()),
                            "std": float(data.std()),
                            # 2nd/98th percentile stretch — used by the preview
                            # renderer to ignore outlier bright/dark pixels that
                            # would otherwise crush the visible colour range
                            # (the same approach Global Mapper uses by default).
                            "p02": float(np.percentile(data, 2)),
                            "p98": float(np.percentile(data, 98)),
                        }
                except Exception as exc:  # noqa: BLE001
                    log.warning("Failed to read band %d: %s", band_idx, exc)

            # Gather sample-point grid positions + native-CRS coordinates
            # + per-band pixel values first, then reproject every
            # coordinate to EPSG:4326 in one batched call.
            grid: list[tuple[int, int, float, float, dict[str, float | None]]] = []
            for row in range(0, height, row_step):
                for col in range(0, width, col_step):
                    if row >= height or col >= width:
                        continue
                    try:
                        native_x, native_y = rasterio.transform.xy(transform, row, col)

                        pixel_values: dict[str, float | None] = {}
                        for band_idx in range(1, band_count + 1):
                            try:
                                val = src.read(band_idx, window=((row, row + 1), (col, col + 1)))
                                pixel_val = float(val[0, 0]) if val.size > 0 else None
                                if nodata is not None and pixel_val == nodata:
                                    pixel_val = None
                                pixel_values[f"band_{band_idx}"] = pixel_val
                            except Exception:  # noqa: BLE001
                                pixel_values[f"band_{band_idx}"] = None

                        grid.append((row, col, native_x, native_y, pixel_values))
                    except Exception:  # noqa: BLE001
                        skipped += 1
                        continue

            points: list[_SamplePoint] = []
            if grid:
                xs = [g[2] for g in grid]
                ys = [g[3] for g in grid]
                lons, lats = warp_transform(src.crs, _DST_CRS, xs, ys)
                for (row, col, _x, _y, pixel_values), lon, lat in zip(grid, lons, lats):
                    if math.isnan(lat) or math.isnan(lon):
                        skipped += 1
                        continue
                    if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
                        skipped += 1
                        continue
                    points.append(
                        _SamplePoint(lat=lat, lon=lon, row=row, col=col, pixels=pixel_values)
                    )

            preview_png: bytes | None = None
            preview_bounds: tuple[float, float, float, float] | None = None
            try:
                preview_png, preview_bounds = self._build_preview(src, band_count, band_stats)
            except Exception:  # noqa: BLE001
                log.exception("Failed to build raster preview image; continuing without it")

        return _ParsedRaster(
            points=points,
            band_stats=band_stats,
            band_count=band_count,
            width=width,
            height=height,
            crs=crs,
            filename=file_path.name,
            preview_png=preview_png,
            preview_bounds=preview_bounds,
            skipped=skipped,
        )

    def _build_preview(
        self,
        src: Any,
        band_count: int,
        band_stats: dict[str, dict[str, float]],
    ) -> tuple[bytes, tuple[float, float, float, float]]:
        """Reproject the raster to EPSG:4326 and render it as a byte-scaled
        PNG (RGB+alpha for >=3 bands, gray+alpha otherwise), downsampled
        so the file stays small enough to ship straight to the browser.

        Uses a `WarpedVRT` and reads it at the final, already-downsampled
        `out_shape` directly — GDAL decimates during the read itself, so a
        multi-hundred-MB/multi-gigapixel source raster never gets
        materialized at full resolution in Python memory just to produce
        a <=1600px preview."""
        from rasterio.io import MemoryFile
        from rasterio.vrt import WarpedVRT
        from rasterio.warp import Resampling

        is_byte = src.dtypes[0] == "uint8"

        with WarpedVRT(src, crs=_DST_CRS, resampling=Resampling.bilinear) as vrt:
            dst_width, dst_height = vrt.width, vrt.height
            if max(dst_width, dst_height) > _MAX_PREVIEW_DIM:
                factor = max(dst_width, dst_height) / _MAX_PREVIEW_DIM
                dst_width = max(1, round(dst_width / factor))
                dst_height = max(1, round(dst_height / factor))

            use_bands = 3 if band_count >= 3 else 1
            rgb = np.zeros((use_bands, dst_height, dst_width), dtype=np.uint8)
            alpha = np.zeros((dst_height, dst_width), dtype=np.uint8)

            for i in range(use_bands):
                band_idx = i + 1
                data = vrt.read(
                    band_idx, out_shape=(dst_height, dst_width), resampling=Resampling.bilinear
                )
                mask = vrt.read_masks(band_idx, out_shape=(dst_height, dst_width))
                valid = mask > 0

                if is_byte:
                    # Already true-color 0-255 imagery (the common case for a
                    # real orthophoto) — render the raw values as-is, matching
                    # QGIS's default "no stretch" display for Byte rasters.
                    # Re-stretching by observed min/max here (as this used to
                    # do unconditionally) shifts contrast/color away from how
                    # the source image actually looks.
                    scaled = data.astype(np.uint8)
                else:
                    # No natural display range for non-Byte data (float DEMs,
                    # uint16 elevation, etc.) — stretch to 0-255 using the
                    # 2nd-98th percentile range so outlier pixels (noise, tall
                    # buildings, voids) don't crush the visible colour range.
                    # This matches Global Mapper's default percentile stretch.
                    stats = band_stats.get(f"band_{band_idx}", {})
                    bmin = stats.get("p02", stats.get("min", 0.0))
                    bmax = stats.get("p98", stats.get("max", 1.0))
                    rng = (bmax - bmin) or 1.0
                    scaled = np.clip((data.astype("float64") - bmin) / rng * 255.0, 0, 255).astype(np.uint8)

                scaled[~valid] = 0
                rgb[i] = scaled
                if i == 0:
                    alpha = np.where(valid, 255, 0).astype(np.uint8)

            bounds = vrt.bounds  # already in EPSG:4326 — (west, south, east, north)

        stacked = np.vstack([rgb, alpha[np.newaxis, :, :]])  # (use_bands+1, h, w)

        with MemoryFile() as memfile:
            with memfile.open(
                driver="PNG",
                height=dst_height,
                width=dst_width,
                count=stacked.shape[0],
                dtype="uint8",
            ) as dst:
                dst.write(stacked)
            png_bytes = memfile.read()

        return png_bytes, tuple(bounds)

    async def _persist(self, parsed: _ParsedRaster, *, dataset_id: str) -> ReaderResult:
        dataset_uuid = uuid.UUID(dataset_id)
        inserted = 0
        skipped = parsed.skipped

        band1_stats = parsed.band_stats.get("band_1", {})
        band_min = band1_stats.get("min", 0.0)
        band_max = band1_stats.get("max", 1.0)

        raster_overlay: dict[str, Any] | None = None
        if parsed.preview_png is not None and parsed.preview_bounds is not None:
            image_key = f"datasets/{dataset_id}/raster-preview.png"
            try:
                await upload_stream(
                    io.BytesIO(parsed.preview_png),
                    key=image_key,
                    content_type="image/png",
                )
                raster_overlay = {
                    "image_key": image_key,
                    "bounds": list(parsed.preview_bounds),  # [west, south, east, north]
                }
            except Exception:  # noqa: BLE001
                log.exception("Failed to upload raster preview for dataset %s", dataset_id)

        batch: list[Feature] = []
        async with SessionLocal() as session:
            for pt in parsed.points:
                attrs = {
                    "raster_file": parsed.filename,
                    "crs": parsed.crs,
                    "pixel_row": pt.row,
                    "pixel_col": pt.col,
                    "band_count": parsed.band_count,
                    "raster_width": parsed.width,
                    "raster_height": parsed.height,
                    **{k: _jsonable(v) for k, v in pt.pixels.items()},
                    **{f"stat_{k}": v for k, v in parsed.band_stats.items()},
                }
                json.dumps(attrs)  # fail fast on non-serializable content

                label = f"Pixel ({pt.row}, {pt.col})"

                severity_val = 0.0
                first_band_val = pt.pixels.get("band_1")
                if first_band_val is not None and band_max > band_min:
                    severity_val = max(0.0, min(1.0, (first_band_val - band_min) / (band_max - band_min)))

                batch.append(
                    Feature(
                        dataset_id=dataset_uuid,
                        label=label,
                        category="raster_pixel",
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
            "RasterReader ingested dataset_id=%s inserted=%d skipped=%d bands=%d crs=%s preview=%s",
            dataset_id,
            inserted,
            skipped,
            parsed.band_count,
            parsed.crs,
            bool(raster_overlay),
        )
        suffix = Path(parsed.filename).suffix.lower()
        source_format = "ecw" if suffix == ".ecw" else "geotiff"
        return ReaderResult(
            inserted=inserted,
            skipped=skipped,
            source_crs=parsed.crs,
            notes=f"bands={parsed.band_count}, size={parsed.width}x{parsed.height}",
            raster_overlay=raster_overlay,
            dataset_metadata={
                "source_format": source_format,
                "raster_source_file": parsed.filename,
            },
        )

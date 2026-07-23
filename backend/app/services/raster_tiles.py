"""On-demand, full-resolution web-map tiles rendered from source GeoTIFFs."""
from __future__ import annotations

import asyncio
import hashlib
import tempfile
from pathlib import Path
from typing import Literal

import numpy as np

from app.services.storage import download_to_file

_WEB_MERCATOR_LIMIT = 20037508.342789244
_TILE_SIZE = 512
_CACHE_DIR = Path(tempfile.gettempdir()) / "davangere-raster-source-cache"
_download_locks: dict[str, asyncio.Lock] = {}


def _tile_bounds(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    tiles = 1 << z
    span = (_WEB_MERCATOR_LIMIT * 2.0) / tiles
    west = -_WEB_MERCATOR_LIMIT + x * span
    east = west + span
    north = _WEB_MERCATOR_LIMIT - y * span
    south = north - span
    return west, south, east, north


async def _cached_source(storage_key: str) -> Path:
    """Download each source once per worker instead of once per map tile."""
    digest = hashlib.sha256(storage_key.encode("utf-8")).hexdigest()
    path = _CACHE_DIR / f"{digest}.tif"
    if path.is_file() and path.stat().st_size > 0:
        return path

    lock = _download_locks.setdefault(digest, asyncio.Lock())
    async with lock:
        if path.is_file() and path.stat().st_size > 0:
            return path
        _CACHE_DIR.mkdir(parents=True, exist_ok=True)
        partial = path.with_suffix(".partial")
        await download_to_file(storage_key, partial)
        partial.replace(path)
    return path


def _display_range(src: object, band_index: int) -> tuple[float, float]:
    """Estimate a stable whole-raster stretch without materialising the TIFF."""
    sample = src.read(
        band_index,
        out_shape=(min(512, src.height), min(512, src.width)),
        masked=True,
    )
    values = sample.compressed() if np.ma.isMaskedArray(sample) else sample.reshape(-1)
    if values.size == 0:
        return 0.0, 1.0
    low, high = np.percentile(values.astype(np.float64), (2, 98))
    return float(low), float(high if high > low else low + 1.0)


def _render_tile_sync(
    source_path: Path,
    z: int,
    x: int,
    y: int,
    mode: Literal["rgb", "grayscale", "enhanced"],
) -> bytes:
    import rasterio
    from rasterio.io import MemoryFile
    from rasterio.transform import from_bounds
    from rasterio.warp import Resampling, reproject

    bounds = _tile_bounds(z, x, y)
    dst_transform = from_bounds(*bounds, _TILE_SIZE, _TILE_SIZE)

    with rasterio.open(source_path) as src:
        if src.crs is None:
            raise ValueError("GeoTIFF has no coordinate reference system")

        use_bands = 3 if src.count >= 3 else 1
        rendered = np.zeros((use_bands, _TILE_SIZE, _TILE_SIZE), dtype=np.float32)
        for output_index in range(use_bands):
            reproject(
                source=rasterio.band(src, output_index + 1),
                destination=rendered[output_index],
                src_transform=src.transform,
                src_crs=src.crs,
                src_nodata=src.nodata,
                dst_transform=dst_transform,
                dst_crs="EPSG:3857",
                dst_nodata=np.nan,
                resampling=Resampling.bilinear,
            )

        # ``dst_nodata=np.nan`` gives us a precise coverage mask without
        # reading the source's potentially multi-gigabyte mask into memory.
        alpha = np.where(np.isfinite(rendered[0]), 255, 0).astype(np.uint8)

        byte_bands = np.zeros_like(rendered, dtype=np.uint8)
        for output_index in range(use_bands):
            values = rendered[output_index]
            if src.dtypes[output_index] == "uint8":
                byte_bands[output_index] = np.nan_to_num(values, nan=0).clip(0, 255).astype(np.uint8)
            else:
                low, high = _display_range(src, output_index + 1)
                scaled = (values - low) * (255.0 / (high - low))
                byte_bands[output_index] = np.nan_to_num(scaled, nan=0).clip(0, 255).astype(np.uint8)

    if use_bands == 1:
        gray = byte_bands[0]
        if mode == "grayscale":
            rgb = np.stack([gray, gray, gray])
        else:
            normalized = gray.astype(np.float32) / 255.0
            stops = np.array([0.0, 0.2, 0.4, 0.6, 0.8, 1.0])
            palette = np.array(
                [[0, 0, 255], [0, 255, 255], [0, 255, 0], [255, 255, 0], [255, 127, 0], [255, 0, 0]]
            )
            rgb = np.stack(
                [np.interp(normalized, stops, palette[:, channel]) for channel in range(3)]
            )

            if mode == "enhanced":
                # Restore the relief/edge shading used by the original
                # elevation preview. The first tiled implementation kept the
                # rainbow palette but accidentally dropped this calculation,
                # making DTM/DSM surfaces look flat.
                elevation = rendered[0]
                valid = np.isfinite(elevation)
                if np.any(valid):
                    fill_value = float(np.nanmedian(elevation))
                    terrain = np.where(valid, elevation, fill_value)
                    pixel_size_m = max((bounds[2] - bounds[0]) / _TILE_SIZE, 0.01)
                    dy, dx = np.gradient(terrain, pixel_size_m, pixel_size_m)
                    z_factor = 2.0
                    slope = np.pi / 2.0 - np.arctan(
                        np.sqrt((dx * z_factor) ** 2 + (dy * z_factor) ** 2)
                    )
                    aspect = np.arctan2(-dy, dx)
                    azimuth = np.deg2rad(315.0)
                    altitude = np.deg2rad(45.0)
                    intensity = (
                        np.sin(altitude) * np.sin(slope)
                        + np.cos(altitude)
                        * np.cos(slope)
                        * np.cos((azimuth - np.pi / 2.0) - aspect)
                    )
                    # Retain enough base colour in shadowed areas while
                    # making ridges, curbs, roofs, and drainage edges visible.
                    shade = 0.38 + 0.82 * np.clip(intensity, 0.0, 1.0)
                    rgb = np.clip(rgb * shade[np.newaxis, :, :], 0, 255)

            rgb = rgb.astype(np.uint8)
    elif mode == "grayscale":
        luminance = (
            0.2126 * byte_bands[0] + 0.7152 * byte_bands[1] + 0.0722 * byte_bands[2]
        ).astype(np.uint8)
        rgb = np.stack([luminance, luminance, luminance])
    else:
        rgb = byte_bands

    rgba = np.vstack([rgb, alpha[np.newaxis, :, :]])
    with MemoryFile() as output:
        with output.open(
            driver="PNG",
            width=_TILE_SIZE,
            height=_TILE_SIZE,
            count=4,
            dtype="uint8",
        ) as dst:
            dst.write(rgba)
        return output.read()


async def render_raster_tile(
    storage_key: str,
    z: int,
    x: int,
    y: int,
    mode: Literal["rgb", "grayscale", "enhanced"],
) -> bytes:
    if z < 0 or z > 24:
        raise ValueError("Unsupported zoom level")
    tile_count = 1 << z
    if not (0 <= x < tile_count and 0 <= y < tile_count):
        raise ValueError("Tile is outside the valid grid")
    source_path = await _cached_source(storage_key)
    return await asyncio.to_thread(_render_tile_sync, source_path, z, x, y, mode)

"""
Regenerate the raster preview PNG for a specific dataset using the
updated percentile-stretch + rainbow-colour logic.

Run from the backend/ directory:
    python regen_preview.py <DATASET_NAME>

Example:
    python regen_preview.py Davangere_DSM
"""
import asyncio
import io
import sys
import numpy as np
import rasterio
from rasterio.vrt import WarpedVRT
from rasterio.warp import Resampling
from rasterio.io import MemoryFile

sys.path.insert(0, ".")
import os
os.environ.setdefault("PYTHONDONTWRITEBYTECODE", "1")


async def main(dataset_name: str) -> None:
    from app.db.session import SessionLocal
    from app.models.dataset import Dataset
    from app.services.storage import get_object_bytes, upload_stream
    from sqlalchemy import select

    async with SessionLocal() as session:
        result = await session.execute(
            select(Dataset).where(Dataset.name == dataset_name)
        )
        dataset = result.scalar_one_or_none()
        if dataset is None:
            print(f"Dataset '{dataset_name}' not found.")
            return

        meta = dataset.dataset_metadata or {}
        storage_key = dataset.storage_key
        if not storage_key:
            print("No storage_key on dataset -- cannot regenerate preview.")
            return

        print(f"Found dataset: {dataset.id}  storage_key={storage_key}")
        print("Downloading source raster...")
        raw = await get_object_bytes(storage_key)

        print("Building new preview with percentile stretch...")
        with MemoryFile(raw) as mf:
            with mf.open() as src:
                _DST_CRS = "EPSG:4326"
                _MAX_DIM = 1600
                band_count = src.count
                nodata = src.nodata
                is_byte = src.dtypes[0] == "uint8"

                # Compute p02/p98 per band
                band_stats: dict = {}
                for bi in range(1, band_count + 1):
                    d = src.read(bi)
                    if nodata is not None:
                        d = d[d != nodata]
                    if d.size > 0:
                        band_stats[f"band_{bi}"] = {
                            "min": float(d.min()),
                            "max": float(d.max()),
                            "p02": float(np.percentile(d, 2)),
                            "p98": float(np.percentile(d, 98)),
                        }
                        print(f"  band_{bi}: min={band_stats[f'band_{bi}']['min']:.2f}  "
                              f"max={band_stats[f'band_{bi}']['max']:.2f}  "
                              f"p02={band_stats[f'band_{bi}']['p02']:.2f}  "
                              f"p98={band_stats[f'band_{bi}']['p98']:.2f}")

                with WarpedVRT(src, crs=_DST_CRS, resampling=Resampling.bilinear) as vrt:
                    dw, dh = vrt.width, vrt.height
                    if max(dw, dh) > _MAX_DIM:
                        factor = max(dw, dh) / _MAX_DIM
                        dw = max(1, round(dw / factor))
                        dh = max(1, round(dh / factor))

                    use_bands = 3 if band_count >= 3 else 1
                    rgb_arr = np.zeros((use_bands, dh, dw), dtype=np.uint8)
                    alpha_arr = np.zeros((dh, dw), dtype=np.uint8)

                    for i in range(use_bands):
                        bi = i + 1
                        data = vrt.read(bi, out_shape=(dh, dw), resampling=Resampling.bilinear)
                        mask = vrt.read_masks(bi, out_shape=(dh, dw))
                        valid = mask > 0
                        if is_byte:
                            scaled = data.astype(np.uint8)
                        else:
                            stats = band_stats.get(f"band_{bi}", {})
                            bmin = stats.get("p02", stats.get("min", 0.0))
                            bmax = stats.get("p98", stats.get("max", 1.0))
                            rng = (bmax - bmin) or 1.0
                            scaled = np.clip(
                                (data.astype("float64") - bmin) / rng * 255.0, 0, 255
                            ).astype(np.uint8)
                        scaled[~valid] = 0
                        rgb_arr[i] = scaled
                        if i == 0:
                            alpha_arr = np.where(valid, 255, 0).astype(np.uint8)

                    bounds = vrt.bounds

                stacked = np.vstack([rgb_arr, alpha_arr[np.newaxis, :, :]])
                with MemoryFile() as out_mf:
                    with out_mf.open(
                        driver="PNG", height=dh, width=dw,
                        count=stacked.shape[0], dtype="uint8",
                    ) as dst:
                        dst.write(stacked)
                    png_bytes = out_mf.read()

        image_key = f"datasets/{dataset.id}/raster-preview.png"
        print(f"Uploading new preview to {image_key} ...")
        await upload_stream(io.BytesIO(png_bytes), key=image_key, content_type="image/png")

        # Update metadata with new band_stats
        new_meta = dict(meta)
        new_meta["raster_overlay"] = {
            "image_key": image_key,
            "bounds": list(bounds),
            "band_stats": band_stats,
        }
        dataset.dataset_metadata = new_meta
        await session.commit()

        print("Done! Preview regenerated successfully.")
        print("Refresh the frontend and switch to Enhanced mode to see the new colours.")


if __name__ == "__main__":
    name = sys.argv[1] if len(sys.argv) > 1 else "Davangere_DSM"
    asyncio.run(main(name))

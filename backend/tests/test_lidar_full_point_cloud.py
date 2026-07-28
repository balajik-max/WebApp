"""Tests for the isolated progressive full-point artifact builder."""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import numpy as np
from pyproj import CRS


class TestLidarFullPointArtifact(unittest.TestCase):
    def _write_las(self, tmpdir: str, *, point_count: int, rgb: bool = True) -> Path:
        import laspy

        path = Path(tmpdir) / "full_sample.las"
        las = laspy.create(point_format=7 if rgb else 6, file_version="1.4")
        las.header.scales = np.array([1e-7, 1e-7, 0.01], dtype=np.float64)
        index = np.arange(point_count)
        side = int(np.ceil(np.sqrt(point_count)))
        las.x = 75.0 + (index % side) * 0.00001
        las.y = 14.0 + (index // side) * 0.00001
        las.z = 570.0 + (index % 70) * 0.15
        las.classification = (index % 7).astype(np.uint8)
        if rgb:
            las.red = ((index % 256) * 257).astype(np.uint16)
            las.green = (((index * 2) % 256) * 257).astype(np.uint16)
            las.blue = (((index * 3) % 256) * 257).astype(np.uint16)
        las.header.add_crs(CRS.from_epsg(4326))
        las.write(path)
        return path

    def test_preserves_every_source_point_across_chunks(self) -> None:
        from app.services.lidar_full_point_cloud import build_lidar_full_point_artifact

        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            source = self._write_las(tmpdir, point_count=50_123, rgb=True)
            built = build_lidar_full_point_artifact(
                source,
                output_dir=root / "out",
                dataset_id="00000000-0000-0000-0000-000000000101",
                storage_key="datasets/test/full_sample.las",
                size_bytes=source.stat().st_size,
                chunk_points=10_000,
            )

            self.assertEqual(built.manifest["point_count_source"], 50_123)
            self.assertEqual(built.manifest["point_count"], 50_123)
            self.assertEqual(built.manifest["dropped_invalid_points"], 0)
            self.assertEqual(built.manifest["record_stride_bytes"], 16)
            self.assertEqual(built.manifest["chunk_count"], 6)
            self.assertEqual(
                sum(int(chunk["point_count"]) for chunk in built.manifest["chunks"]),
                50_123,
            )
            for chunk, path in zip(built.manifest["chunks"], built.chunk_paths):
                self.assertEqual(path.stat().st_size, int(chunk["point_count"]) * 16)

    def test_progressive_first_chunk_spans_the_survey(self) -> None:
        from app.services.lidar_full_point_cloud import build_lidar_full_point_artifact

        dtype = np.dtype(
            [
                ("x", "<f4"), ("y", "<f4"), ("z", "<f4"),
                ("r", "u1"), ("g", "u1"), ("b", "u1"),
                ("classification", "u1"),
            ],
            align=False,
        )
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            source = self._write_las(tmpdir, point_count=60_000, rgb=True)
            built = build_lidar_full_point_artifact(
                source,
                output_dir=root / "out",
                dataset_id="00000000-0000-0000-0000-000000000102",
                storage_key="datasets/test/full_sample.las",
                size_bytes=source.stat().st_size,
                chunk_points=10_000,
            )
            records = np.fromfile(built.chunk_paths[0], dtype=dtype)
            self.assertGreater(float(np.ptp(records["x"])), 50.0)
            self.assertGreater(float(np.ptp(records["y"])), 50.0)
            self.assertGreater(int(np.max(records["r"])), 0)

    def test_classification_fallback_without_rgb(self) -> None:
        from app.services.lidar_full_point_cloud import build_lidar_full_point_artifact

        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            source = self._write_las(tmpdir, point_count=20_000, rgb=False)
            built = build_lidar_full_point_artifact(
                source,
                output_dir=root / "out",
                dataset_id="00000000-0000-0000-0000-000000000103",
                storage_key="datasets/test/full_sample.las",
                size_bytes=source.stat().st_size,
                chunk_points=10_000,
            )
            self.assertFalse(built.manifest["has_rgb"])
            self.assertTrue(built.manifest["has_classification"])
            self.assertEqual(built.manifest["default_color_mode"], "classification")


if __name__ == "__main__":
    unittest.main()

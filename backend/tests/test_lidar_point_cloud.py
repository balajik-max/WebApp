"""Unit tests for the bounded real-point LAS/LAZ artifact."""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import numpy as np
from pyproj import CRS


class TestLidarPointArtifact(unittest.TestCase):
    def _write_las(self, tmpdir: str, *, point_count: int = 1000, rgb: bool = True) -> Path:
        import laspy

        path = Path(tmpdir) / "sample.las"
        point_format = 7 if rgb else 6
        las = laspy.create(point_format=point_format, file_version="1.4")
        # Geographic test coordinates vary by 0.00001 degree. laspy defaults
        # to a 0.01 scale, which would quantize every X/Y value to one number.
        las.header.scales = np.array([1e-7, 1e-7, 0.01], dtype=np.float64)
        side = int(np.ceil(np.sqrt(point_count)))
        indices = np.arange(point_count)
        las.x = 75.0 + (indices % side) * 0.00001
        las.y = 14.0 + (indices // side) * 0.00001
        las.z = 570.0 + (indices % 50) * 0.2
        las.intensity = (indices % 4096).astype(np.uint16)
        las.classification = (indices % 7).astype(np.uint8)
        las.return_number = ((indices % 3) + 1).astype(np.uint8)
        if rgb:
            las.red = ((indices % 256) * 257).astype(np.uint16)
            las.green = (((indices * 2) % 256) * 257).astype(np.uint16)
            las.blue = (((indices * 3) % 256) * 257).astype(np.uint16)
        las.header.add_crs(CRS.from_epsg(4326))
        las.write(path)
        return path

    def test_builds_real_interleaved_points(self) -> None:
        from app.services.lidar_point_cloud import build_lidar_point_artifact

        with tempfile.TemporaryDirectory() as tmpdir:
            path = self._write_las(tmpdir, point_count=1000, rgb=True)
            built = build_lidar_point_artifact(
                path,
                dataset_id="00000000-0000-0000-0000-000000000001",
                storage_key="datasets/test/sample.las",
                size_bytes=path.stat().st_size,
                max_points=200,
            )

        self.assertEqual(built.manifest["version"], 1)
        self.assertLessEqual(built.manifest["point_count"], 200)
        self.assertGreater(built.manifest["point_count"], 0)
        self.assertEqual(built.manifest["record_stride_bytes"], 20)
        self.assertEqual(len(built.binary), built.manifest["point_count"] * 20)
        self.assertTrue(built.manifest["has_rgb"])
        self.assertEqual(built.manifest["default_color_mode"], "rgb")
        self.assertAlmostEqual(built.manifest["origin"]["longitude"], 75.00015, places=3)
        self.assertAlmostEqual(built.manifest["origin"]["latitude"], 14.00015, places=3)

    def test_binary_contains_nonzero_xyz_and_rgb(self) -> None:
        from app.services.lidar_point_cloud import build_lidar_point_artifact

        dtype = np.dtype([
            ("x", "<f4"), ("y", "<f4"), ("z", "<f4"),
            ("r", "u1"), ("g", "u1"), ("b", "u1"),
            ("classification", "u1"), ("intensity", "<u2"),
            ("return_number", "u1"), ("reserved", "u1"),
        ], align=False)

        with tempfile.TemporaryDirectory() as tmpdir:
            path = self._write_las(tmpdir, point_count=500, rgb=True)
            built = build_lidar_point_artifact(
                path,
                dataset_id="00000000-0000-0000-0000-000000000002",
                storage_key="datasets/test/sample.las",
                size_bytes=path.stat().st_size,
                max_points=500,
            )

        records = np.frombuffer(built.binary, dtype=dtype)
        self.assertEqual(records.shape[0], built.manifest["point_count"])
        self.assertGreater(float(np.ptp(records["x"])), 0.0)
        self.assertGreater(float(np.ptp(records["y"])), 0.0)
        self.assertGreater(float(np.ptp(records["z"])), 0.0)
        self.assertGreater(int(np.max(records["r"])), 0)
        self.assertGreater(int(np.max(records["intensity"])), 0)

    def test_falls_back_without_rgb(self) -> None:
        from app.services.lidar_point_cloud import build_lidar_point_artifact

        with tempfile.TemporaryDirectory() as tmpdir:
            path = self._write_las(tmpdir, point_count=300, rgb=False)
            built = build_lidar_point_artifact(
                path,
                dataset_id="00000000-0000-0000-0000-000000000003",
                storage_key="datasets/test/sample.las",
                size_bytes=path.stat().st_size,
                max_points=100,
            )

        self.assertFalse(built.manifest["has_rgb"])
        self.assertTrue(built.manifest["has_classification"])
        self.assertEqual(built.manifest["default_color_mode"], "classification")

    def test_rejects_missing_crs(self) -> None:
        import laspy
        from app.services.lidar_point_cloud import build_lidar_point_artifact

        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "no_crs.las"
            las = laspy.create(point_format=6, file_version="1.4")
            las.x = np.array([1.0, 2.0])
            las.y = np.array([1.0, 2.0])
            las.z = np.array([1.0, 2.0])
            las.write(path)
            with self.assertRaisesRegex(ValueError, "no embedded CRS"):
                build_lidar_point_artifact(
                    path,
                    dataset_id="00000000-0000-0000-0000-000000000004",
                    storage_key="datasets/test/no_crs.las",
                    size_bytes=path.stat().st_size,
                )


if __name__ == "__main__":
    unittest.main()

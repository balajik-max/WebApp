"""Tests for point cloud inspection and LiDAR ingestion with optional CRS."""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import numpy as np


class TestPointCloudInspector(unittest.TestCase):
    """Tests for the point_cloud_inspector service."""

    def _create_las_file(
        self,
        tmpdir: str,
        *,
        point_count: int = 10,
        include_crs: bool = False,
        suffix: str = ".las",
    ) -> Path:
        """Create a valid LAS file using laspy's API."""
        import laspy
        import laspy.vlrs

        file_path = Path(tmpdir) / f"test{suffix}"
        las = laspy.create(point_format=6, file_version="1.4")

        xs = np.array([float(i * 10) for i in range(point_count)], dtype=np.float64)
        ys = np.array([float(i * 20) for i in range(point_count)], dtype=np.float64)
        zs = np.array([float(10 + i) for i in range(point_count)], dtype=np.float64)
        intensities = np.array([np.uint16(i % 256) for i in range(point_count)], dtype=np.uint16)
        classifications = np.array([np.uint8(i % 3) for i in range(point_count)], dtype=np.uint8)

        las.x = xs
        las.y = ys
        las.z = zs
        las.intensity = intensities
        las.classification = classifications

        if include_crs:
            las.vlrs.append(
                laspy.vlrs.VLR(
                    user_id="LASF_Projection",
                    record_id=2112,
                    description="",
                    record_data=b'GEOGCS["WGS 1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["Degree",0.0174532925199433]]',
                )
            )

        las.write(file_path)
        return file_path

    def test_inspector_valid_las_without_crs(self) -> None:
        """Valid LAS without CRS should return valid=True with crs_status='unknown'."""
        from app.services.point_cloud_inspector import inspect_point_cloud

        with tempfile.TemporaryDirectory() as tmpdir:
            file_path = self._create_las_file(tmpdir, include_crs=False)
            result = inspect_point_cloud(file_path)

        self.assertTrue(result.valid)
        self.assertEqual(result.format, "las")
        self.assertEqual(result.crs_status, "unknown")
        self.assertFalse(result.georeferenced)
        self.assertIsNone(result.source_crs)
        self.assertTrue(result.has_warning("POINT_CLOUD_CRS_UNKNOWN"))

    def test_inspector_valid_las_with_crs(self) -> None:
        """Valid LAS with CRS should return valid=True with crs_status='embedded'."""
        from app.services.point_cloud_inspector import inspect_point_cloud

        with tempfile.TemporaryDirectory() as tmpdir:
            file_path = self._create_las_file(tmpdir, include_crs=True)
            result = inspect_point_cloud(file_path)

        self.assertTrue(result.valid)
        self.assertEqual(result.crs_status, "embedded")
        self.assertTrue(result.georeferenced)
        self.assertIsNotNone(result.source_crs)
        self.assertFalse(result.has_warning("POINT_CLOUD_CRS_UNKNOWN"))

    def test_inspector_compressed_detection(self) -> None:
        """Laz file should be detected as compressed."""
        from app.services.point_cloud_inspector import inspect_point_cloud

        with tempfile.TemporaryDirectory() as tmpdir:
            file_path = self._create_las_file(tmpdir, suffix=".laz")
            result = inspect_point_cloud(file_path)

        self.assertTrue(result.compressed)
        self.assertEqual(result.format, "laz")

    def test_inspector_bounds_extraction(self) -> None:
        """Bounds should be correctly extracted from header."""
        from app.services.point_cloud_inspector import inspect_point_cloud

        with tempfile.TemporaryDirectory() as tmpdir:
            file_path = self._create_las_file(tmpdir, point_count=10)
            result = inspect_point_cloud(file_path)

        self.assertTrue(result.valid)
        self.assertEqual(result.bounds.min_x, 0.0)
        self.assertEqual(result.bounds.max_x, 90.0)
        self.assertEqual(result.bounds.min_y, 0.0)
        self.assertEqual(result.bounds.max_y, 180.0)

    def test_inspector_scales_and_offsets(self) -> None:
        """Scales and offsets should be correctly extracted."""
        from app.services.point_cloud_inspector import inspect_point_cloud

        with tempfile.TemporaryDirectory() as tmpdir:
            file_path = self._create_las_file(tmpdir)
            result = inspect_point_cloud(file_path)

        self.assertEqual(result.scales, [0.01, 0.01, 0.01])
        self.assertEqual(result.offsets, [0.0, 0.0, 0.0])

    def test_inspector_las_version(self) -> None:
        """LAS version should be correctly extracted."""
        from app.services.point_cloud_inspector import inspect_point_cloud

        with tempfile.TemporaryDirectory() as tmpdir:
            file_path = self._create_las_file(tmpdir)
            result = inspect_point_cloud(file_path)

        self.assertEqual(result.las_version, "1.4")

    def test_inspector_point_count(self) -> None:
        """Point count should be correctly extracted."""
        from app.services.point_cloud_inspector import inspect_point_cloud

        with tempfile.TemporaryDirectory() as tmpdir:
            file_path = self._create_las_file(tmpdir, point_count=42)
            result = inspect_point_cloud(file_path)

        self.assertEqual(result.point_count, 42)

    def test_inspector_dimensions(self) -> None:
        """Dimensions list should be non-empty for a valid file."""
        from app.services.point_cloud_inspector import inspect_point_cloud

        with tempfile.TemporaryDirectory() as tmpdir:
            file_path = self._create_las_file(tmpdir)
            result = inspect_point_cloud(file_path)

        self.assertIsInstance(result.dimensions, list)
        self.assertTrue(len(result.dimensions) > 0)

    def test_inspector_nonexistent_file(self) -> None:
        """Nonexistent file should return valid=False."""
        from app.services.point_cloud_inspector import inspect_point_cloud

        result = inspect_point_cloud(Path("/nonexistent/file.las"))
        self.assertFalse(result.valid)
        self.assertTrue(result.has_warning("POINT_CLOUD_PROCESSING_FAILED"))


class TestFormatCrs(unittest.TestCase):
    """Tests for the _format_crs helper function."""

    def test_format_crs_with_epsg(self) -> None:
        """_format_crs should return EPSG string when available."""
        from app.services.point_cloud_inspector import _format_crs

        mock_crs = type("MockCRS", (), {"to_epsg": lambda self: 4326})()
        self.assertEqual(_format_crs(mock_crs), "EPSG:4326")

    def test_format_crs_without_epsg(self) -> None:
        """_format_crs should fall back to to_string()."""
        from app.services.point_cloud_inspector import _format_crs

        mock_crs = type("MockCRS", (), {
            "to_epsg": lambda self: None,
            "to_string": lambda self: "CUSTOM CRS",
        })()
        self.assertEqual(_format_crs(mock_crs), "CUSTOM CRS")

    def test_format_crs_exception_fallback(self) -> None:
        """_format_crs should handle exceptions gracefully."""
        from app.services.point_cloud_inspector import _format_crs

        class BadCRS:
            def to_epsg(self):
                raise Exception("error")
            def to_string(self):
                raise Exception("error")
            def __str__(self):
                return "BadCRS"

        result = _format_crs(BadCRS())
        self.assertIsInstance(result, str)


class TestPointCloudWarning(unittest.TestCase):
    """Tests for PointCloudWarning and PointCloudInspection models."""

    def test_has_warning(self) -> None:
        """has_warning should check for specific warning codes."""
        from app.services.point_cloud_inspector import PointCloudInspection, PointCloudWarning, PointCloudBounds

        inspection = PointCloudInspection(
            valid=True,
            format="las",
            las_version="1.4",
            point_format=6,
            point_count=100,
            scales=[0.01, 0.01, 0.01],
            offsets=[0.0, 0.0, 0.0],
            bounds=PointCloudBounds(min_x=0, max_x=1, min_y=0, max_y=1, min_z=0, max_z=1),
            dimensions=["X", "Y", "Z"],
            compressed=False,
            source_crs=None,
            crs_status="unknown",
            georeferenced=False,
            warnings=[
                PointCloudWarning(code="POINT_CLOUD_CRS_UNKNOWN", message="CRS unknown"),
            ],
        )

        self.assertTrue(inspection.has_warning("POINT_CLOUD_CRS_UNKNOWN"))
        self.assertFalse(inspection.has_warning("POINT_CLOUD_INVALID_SIGNATURE"))

    def test_no_warnings(self) -> None:
        """has_warning should return False when warnings list is empty."""
        from app.services.point_cloud_inspector import PointCloudInspection, PointCloudBounds

        inspection = PointCloudInspection(
            valid=True,
            format="las",
            las_version="1.4",
            point_format=6,
            point_count=100,
            scales=[0.01, 0.01, 0.01],
            offsets=[0.0, 0.0, 0.0],
            bounds=PointCloudBounds(min_x=0, max_x=1, min_y=0, max_y=1, min_z=0, max_z=1),
            dimensions=["X", "Y", "Z"],
            compressed=False,
            source_crs="EPSG:4326",
            crs_status="embedded",
            georeferenced=True,
        )

        self.assertFalse(inspection.has_warning("POINT_CLOUD_CRS_UNKNOWN"))


class TestLidarHelperFunctions(unittest.TestCase):
    """Tests for standalone helper functions that don't require app config."""

    def test_detect_crs_from_sidecar_nonexistent(self) -> None:
        """Sidecar detection should return None for nonexistent files."""
        from app.services.point_cloud_inspector import _detect_crs_from_sidecar

        result = _detect_crs_from_sidecar(Path("/nonexistent/file.las"))
        self.assertIsNone(result)

    def test_detect_crs_from_sidecar_with_prj(self) -> None:
        """Sidecar detection should find .prj files."""
        from app.services.point_cloud_inspector import _detect_crs_from_sidecar

        with tempfile.TemporaryDirectory() as tmpdir:
            prj_path = Path(tmpdir) / "test.prj"
            prj_path.write_text('GEOGCS["WGS 1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137,298.257223563]]]')
            result = _detect_crs_from_sidecar(Path(tmpdir) / "test.las")
            self.assertIsNotNone(result)
            self.assertTrue(result.startswith("WKT:"))


if __name__ == "__main__":
    unittest.main()

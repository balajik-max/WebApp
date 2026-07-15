from __future__ import annotations

import tempfile
import unittest
import zipfile
from pathlib import Path

from app.services.readers.obj_reader import ObjReader


METADATA = b"""<?xml version="1.0" encoding="utf-8"?>
<ModelMetadata version="1">
  <SRS>EPSG:32643</SRS>
  <SRSOrigin>599205.57887566229,1600596.0628325907,694.14084952809162</SRSOrigin>
</ModelMetadata>
"""


class ObjReaderTests(unittest.TestCase):
    def test_georeferenced_multi_model_zip_is_streamed_and_transformed(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            bundle = Path(tmpdir) / "model.zip"
            with zipfile.ZipFile(bundle, "w") as archive:
                archive.writestr("survey/metadata.xml", METADATA)
                archive.writestr("survey/Block0/a.obj", "mtllib a.mtl\nv -2 -3 -4\nv 2 3 4\nf 1 2 1\n")
                archive.writestr("survey/Block1/b.obj", "v 5 6 7\nf 1 1 1\n")
                archive.writestr("survey/Block0/a.mtl", "newmtl roof\n")
                archive.writestr("survey/Block0/texture.jpg", b"not-decoded-by-reader")

            reader = ObjReader()
            parsed = reader._parse_sync(bundle)

        self.assertEqual(parsed.vertex_count, 3)
        self.assertEqual(parsed.face_count, 2)
        self.assertEqual(len(parsed.vertices), 3)
        self.assertEqual(parsed.texture_count, 1)
        self.assertEqual(parsed.material_libraries["survey/Block0/a.obj"], ["a.mtl"])
        self.assertEqual(
            ObjReader._resolve_asset_reference("survey/Block0/a.obj", "a.mtl"),
            "survey/Block0/a.mtl",
        )
        self.assertEqual(parsed.georef.source_crs if parsed.georef else None, "EPSG:32643")
        self.assertEqual(parsed.georef.origin if parsed.georef else None, (599205.5788756623, 1600596.0628325907, 694.1408495280916))

        transform, method, source_crs = reader._coordinate_transform(parsed, 0.0, 0.0)
        lon, lat, elevation = transform(0.0, 0.0, 0.0)
        self.assertEqual(method, "metadata.xml")
        self.assertEqual(source_crs, "EPSG:32643")
        self.assertTrue(75.0 < lon < 78.0)
        self.assertTrue(13.0 < lat < 16.0)
        self.assertAlmostEqual(elevation, 694.1408495280916)

    def test_vertex_reservoir_stays_bounded(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            obj = Path(tmpdir) / "large.obj"
            obj.write_text("".join(f"v {i} {i + 1} {i + 2}\n" for i in range(750)), encoding="utf-8")
            parsed = ObjReader()._parse_sync(obj)

        self.assertEqual(parsed.vertex_count, 750)
        self.assertEqual(len(parsed.vertices), 500)
        self.assertEqual(parsed.bbox["min_x"], 0.0)
        self.assertEqual(parsed.bbox["max_x"], 749.0)

    def test_conflicting_metadata_is_rejected(self) -> None:
        other_metadata = METADATA.replace(b"EPSG:32643", b"EPSG:4326")
        with tempfile.TemporaryDirectory() as tmpdir:
            bundle = Path(tmpdir) / "model.zip"
            with zipfile.ZipFile(bundle, "w") as archive:
                archive.writestr("metadata.xml", METADATA)
                archive.writestr("block/metadata.xml", other_metadata)
                archive.writestr("block/model.obj", "v 0 0 0\n")

            with self.assertRaisesRegex(ValueError, "conflicting CRS/origin"):
                ObjReader()._parse_sync(bundle)

    def test_unsafe_archive_asset_paths_are_rejected(self) -> None:
        self.assertIsNone(ObjReader._safe_asset_path("../../outside.jpg"))
        self.assertIsNone(ObjReader._resolve_asset_reference("model/block.obj", "../../outside.mtl"))


if __name__ == "__main__":
    unittest.main()

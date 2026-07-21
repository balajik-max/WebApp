"""Ingestion reader strategies (Strategy Pattern)."""
from app.services.readers.base import DatasetReader, ReaderResult  # noqa: F401
from app.services.readers.gis_reader import GISReader  # noqa: F401
from app.services.readers.image_reader import ImageReader  # noqa: F401
from app.services.readers.lidar_reader import LidarReader  # noqa: F401
from app.services.readers.obj_reader import ObjReader  # noqa: F401
from app.services.readers.raster_reader import RasterReader  # noqa: F401
from app.services.readers.table_reader import TableReader  # noqa: F401
from app.services.readers.registry import get_reader_for  # noqa: F401

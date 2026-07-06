"""Ingestion reader strategies (Strategy Pattern)."""
from app.services.readers.base import DatasetReader, ReaderResult  # noqa: F401
from app.services.readers.gis_reader import GISReader  # noqa: F401
from app.services.readers.table_reader import TableReader  # noqa: F401
from app.services.readers.registry import get_reader_for  # noqa: F401

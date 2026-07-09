"""
Dispatcher — picks the first reader whose `can_handle()` returns True.

Extending the pipeline with a new file type is a two-step affair:
  1. Implement a class satisfying the `DatasetReader` protocol.
  2. Append its instance to `_STRATEGIES`.
"""
from __future__ import annotations

from app.services.readers.base import DatasetReader
from app.services.readers.gis_reader import GISReader
from app.services.readers.obj_reader import ObjReader
from app.services.readers.raster_reader import RasterReader
from app.services.readers.table_reader import TableReader

# Order matters — earlier readers win.  Native GIS formats are checked
# before tabular fallbacks so a `.geojson` served as text/plain still
# hits the GISReader.
_STRATEGIES: tuple[DatasetReader, ...] = (
    GISReader(),
    RasterReader(),
    ObjReader(),
    TableReader(),
)


def get_reader_for(filename: str) -> DatasetReader | None:
    for strategy in _STRATEGIES:
        if strategy.can_handle(filename):
            return strategy
    return None

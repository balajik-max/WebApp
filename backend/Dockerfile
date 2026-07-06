# ------------------------------------------------------------------
# Davangere backend — FastAPI (async) + SQLAlchemy 2 + PostGIS client
# ------------------------------------------------------------------
FROM python:3.11-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# System-level GIS + build deps.  libgdal-dev is required for GDAL/OGR
# bindings used by feature ingestion pipelines (shapefile / geojson / kml).
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        curl \
        gcc \
        g++ \
        libgdal-dev \
        gdal-bin \
        libpq-dev \
        libgeos-dev \
        libproj-dev \
        proj-bin \
        proj-data \
        libspatialindex-dev \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Expose GDAL paths to Python bindings.
ENV CPLUS_INCLUDE_PATH=/usr/include/gdal \
    C_INCLUDE_PATH=/usr/include/gdal

WORKDIR /app

COPY requirements.txt ./
RUN pip install --upgrade pip \
 && pip install -r requirements.txt

COPY . /app
RUN chmod +x /app/entrypoint.sh

EXPOSE 8001

# Default entrypoint runs migrations + seed, then hands off to CMD.
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8001", "--proxy-headers"]

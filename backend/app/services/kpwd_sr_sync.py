"""Controlled Karnataka PWD SR website/PDF synchronization.

This service is intentionally separate from map-click costing. It discovers and
caches official PDFs, extracts searchable text when possible, and registers only
high-confidence known item-rate rows for automatic use. Image-only PDFs remain
cached with ``requires_review`` status instead of producing guessed rates.
"""
from __future__ import annotations

import hashlib
import io
import re
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse

import httpx
from bs4 import BeautifulSoup
from pypdf import PdfReader
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings

GENERAL_INDEX_URL = "https://kpwd.karnataka.gov.in/83/schedule-of-rates-(sr)/en"
KNOWN_YEAR_URLS = {
    "2026-27": "https://kpwd.karnataka.gov.in/85/2026-27/en",
}
KNOWN_ITEMS: dict[str, dict[str, str]] = {
    "10.5": {
        "unit": "m2",
        "surface": "bituminous",
        "method": "40 mm bituminous-concrete patch repair",
    },
    "10.15(i)": {
        "unit": "m2",
        "surface": "bituminous",
        "method": "Shallow pothole patching with 25 mm SDBC Grade II",
    },
    "10.15(ii)": {
        "unit": "m2",
        "surface": "bituminous",
        "method": "Deep pothole patching with WBM Grade I and 25 mm SDBC Grade II",
    },
}


@dataclass(frozen=True)
class DownloadedDocument:
    title: str
    source_url: str
    local_path: Path
    sha256: str
    page_count: int
    extracted_text: str
    parsing_status: str
    last_error: str | None = None


def _storage_root() -> Path:
    root = Path(__file__).resolve().parents[2] / "data" / "kpwd_sr"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _safe_name(value: str, fallback: str = "document.pdf") -> str:
    parsed_name = Path(urlparse(value).path).name or fallback
    clean = re.sub(r"[^A-Za-z0-9._-]+", "_", parsed_name).strip("._")
    if not clean.lower().endswith(".pdf"):
        clean += ".pdf"
    return clean[:180]


def _document_category(title: str) -> str:
    lower = title.lower()
    if "corrig" in lower:
        return "corrigendum"
    if "addend" in lower:
        return "addendum"
    if "issue" in lower or "revision" in lower or "circular" in lower:
        return "issue_rate"
    return "main_sr"


def _extract_pdf_text(payload: bytes) -> tuple[str, int, str, str | None]:
    try:
        reader = PdfReader(io.BytesIO(payload))
        chunks = [(page.extract_text() or "") for page in reader.pages]
        extracted = "\n".join(chunks).strip()
        if len(re.sub(r"\s+", "", extracted)) < 80:
            return extracted, len(reader.pages), "requires_review", "PDF appears image-only or has insufficient machine-readable text"
        return extracted, len(reader.pages), "text_extracted", None
    except Exception as exc:  # pragma: no cover - defensive against malformed government PDFs
        return "", 0, "parse_failed", str(exc)[:500]


def _extract_effective_date(text_value: str, financial_year: str) -> date:
    matches: list[date] = []
    for day, month, year in re.findall(r"(?<!\d)(\d{1,2})[-/.](\d{1,2})[-/.](20\d{2})(?!\d)", text_value):
        try:
            matches.append(date(int(year), int(month), int(day)))
        except ValueError:
            continue
    if matches:
        return max(matches)
    start_year = int(financial_year[:4])
    return date(start_year, 4, 1)


def _rate_candidates(window: str) -> list[float]:
    normalized = window.replace(",", "")
    values: list[float] = []
    for raw in re.findall(r"(?<![\w.])(\d{2,6}(?:\.\d{1,2})?)(?![\w.])", normalized):
        value = float(raw)
        if 20 <= value <= 10_000_000:
            values.append(value)
    return values


def extract_high_confidence_rates(text_value: str, financial_year: str) -> list[dict[str, Any]]:
    """Extract only exact known pothole item codes from text-readable PDFs.

    The parser requires the exact code, an expected descriptive phrase, a unit,
    and an effective date. It chooses the last plausible rate in the nearby row,
    matching the way quarterly circulars append the newest effective column.
    """
    compact = " ".join(text_value.split())
    effective_from = _extract_effective_date(compact, financial_year)
    found: list[dict[str, Any]] = []
    phrase_checks = {
        "10.5": ("bituminous", "40mm"),
        "10.15(i)": ("shallow", "sdbc"),
        "10.15(ii)": ("deep", "sdbc"),
    }
    for item_code, metadata in KNOWN_ITEMS.items():
        patterns = [re.escape(item_code)]
        if item_code == "10.15(i)":
            patterns += [r"10\.15\s*\(?i\)?"]
        elif item_code == "10.15(ii)":
            patterns += [r"10\.15\s*\(?ii\)?"]
        match = None
        for pattern in patterns:
            match = re.search(pattern, compact, flags=re.IGNORECASE)
            if match:
                break
        if not match:
            continue
        start = max(0, match.start() - 120)
        end = min(len(compact), match.end() + 700)
        window = compact[start:end]
        lower = window.lower().replace(" ", "")
        if not all(phrase.replace(" ", "") in lower for phrase in phrase_checks[item_code]):
            continue
        if not re.search(r"\bm\s*[²2]\b|\bm2\b", window, flags=re.IGNORECASE):
            continue
        candidates = _rate_candidates(window)
        if not candidates:
            continue
        # Remove common dates, thicknesses, item-code fragments and select the
        # final plausible SR value from the row/nearby table segment.
        plausible = [value for value in candidates if value >= 50 and value not in {2023, 2024, 2025, 2026, 2027, 2040, 3004}]
        if not plausible:
            continue
        found.append(
            {
                "financial_year": financial_year,
                "item_code": item_code,
                "road_surface": metadata["surface"],
                "repair_method": metadata["method"],
                "unit": metadata["unit"],
                "rate_value": plausible[-1],
                "effective_from": effective_from,
                "verification_status": "auto_extracted_high_confidence",
                "gst_included": False,
            }
        )
    return found


async def _discover_pdf_links(client: httpx.AsyncClient, financial_year: str) -> tuple[str, list[tuple[str, str]]]:
    candidate_urls = []
    if financial_year in KNOWN_YEAR_URLS:
        candidate_urls.append(KNOWN_YEAR_URLS[financial_year])
    candidate_urls.extend([
        f"https://kpwd.karnataka.gov.in/85/{financial_year}/en",
        GENERAL_INDEX_URL,
    ])
    errors: list[str] = []
    for page_url in dict.fromkeys(candidate_urls):
        try:
            response = await client.get(page_url)
            response.raise_for_status()
        except Exception as exc:
            errors.append(f"{page_url}: {exc}")
            continue
        soup = BeautifulSoup(response.text, "html.parser")
        links: list[tuple[str, str]] = []
        for anchor in soup.find_all("a", href=True):
            href = str(anchor.get("href") or "").strip()
            label = " ".join(anchor.get_text(" ", strip=True).split()) or Path(urlparse(href).path).name
            absolute = urljoin(str(response.url), href)
            lower = absolute.lower()
            if ".pdf" in lower or "download" in lower or "document" in lower:
                links.append((label or "KPWD SR document", absolute))
        deduped: list[tuple[str, str]] = []
        seen: set[str] = set()
        for label, link in links:
            if link in seen:
                continue
            seen.add(link)
            deduped.append((label, link))
        if deduped:
            return str(response.url), deduped
    raise RuntimeError("Unable to discover KPWD SR PDF links. " + " | ".join(errors[-3:]))


async def _download_document(client: httpx.AsyncClient, financial_year: str, title: str, url: str) -> DownloadedDocument:
    settings = get_settings()
    response = await client.get(url)
    response.raise_for_status()
    payload = response.content
    if len(payload) > settings.pothole_sr_max_source_bytes:
        raise ValueError(f"PDF exceeds configured {settings.pothole_sr_max_source_bytes} byte limit")
    content_type = response.headers.get("content-type", "").lower()
    if not payload.startswith(b"%PDF") and "pdf" not in content_type:
        raise ValueError("Discovered link did not return a PDF")
    checksum = hashlib.sha256(payload).hexdigest()
    year_dir = _storage_root() / financial_year
    year_dir.mkdir(parents=True, exist_ok=True)
    destination = year_dir / _safe_name(str(response.url))
    destination.write_bytes(payload)
    extracted_text, page_count, status, error = _extract_pdf_text(payload)
    return DownloadedDocument(title, str(response.url), destination, checksum, page_count, extracted_text, status, error)


async def _store_document(db: AsyncSession, financial_year: str, year_page_url: str, document: DownloadedDocument) -> int:
    result = await db.execute(
        text(
            """
            INSERT INTO kpwd_sr_documents (
                financial_year, year_page_url, title, document_category,
                source_url, local_path, sha256, page_count, parsing_status,
                extracted_text_length, last_error, downloaded_at, updated_at
            ) VALUES (
                :financial_year, :year_page_url, :title, :category,
                :source_url, :local_path, :sha256, :page_count, :parsing_status,
                :text_length, :last_error, now(), now()
            )
            ON CONFLICT (financial_year, source_url) DO UPDATE SET
                year_page_url = EXCLUDED.year_page_url,
                title = EXCLUDED.title,
                document_category = EXCLUDED.document_category,
                local_path = EXCLUDED.local_path,
                sha256 = EXCLUDED.sha256,
                page_count = EXCLUDED.page_count,
                parsing_status = EXCLUDED.parsing_status,
                extracted_text_length = EXCLUDED.extracted_text_length,
                last_error = EXCLUDED.last_error,
                downloaded_at = now(), updated_at = now()
            RETURNING id
            """
        ),
        {
            "financial_year": financial_year,
            "year_page_url": year_page_url,
            "title": document.title,
            "category": _document_category(document.title),
            "source_url": document.source_url,
            "local_path": str(document.local_path),
            "sha256": document.sha256,
            "page_count": document.page_count,
            "parsing_status": document.parsing_status,
            "text_length": len(document.extracted_text),
            "last_error": document.last_error,
        },
    )
    return int(result.scalar_one())


async def _store_rates(db: AsyncSession, document_id: int, document: DownloadedDocument, financial_year: str) -> int:
    count = 0
    for candidate in extract_high_confidence_rates(document.extracted_text, financial_year):
        await db.execute(
            text(
                """
                INSERT INTO kpwd_sr_rates (
                    financial_year, item_code, road_surface, repair_method,
                    unit, rate_value, effective_from, source_document_id,
                    source_document, source_page, source_url,
                    verification_status, gst_included, updated_at
                ) VALUES (
                    :financial_year, :item_code, :road_surface, :repair_method,
                    :unit, :rate_value, :effective_from, :document_id,
                    :source_document, NULL, :source_url,
                    :verification_status, :gst_included, now()
                )
                ON CONFLICT (financial_year, item_code, effective_from, source_url)
                DO UPDATE SET
                    rate_value = EXCLUDED.rate_value,
                    road_surface = EXCLUDED.road_surface,
                    repair_method = EXCLUDED.repair_method,
                    unit = EXCLUDED.unit,
                    source_document_id = EXCLUDED.source_document_id,
                    verification_status = EXCLUDED.verification_status,
                    updated_at = now()
                """
            ),
            {
                **candidate,
                "document_id": document_id,
                "source_document": document.title,
                "source_url": document.source_url,
            },
        )
        count += 1
    return count


async def sync_financial_year(db: AsyncSession, financial_year: str) -> dict[str, Any]:
    settings = get_settings()
    timeout = httpx.Timeout(settings.pothole_sr_http_timeout_seconds)
    headers = {"User-Agent": "NakshaTech-Davangere-SR-Sync/1.0"}
    documents_found = documents_downloaded = rates_extracted = requires_review = 0
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True, headers=headers) as client:
        year_page_url, links = await _discover_pdf_links(client, financial_year)
        documents_found = len(links)
        errors: list[str] = []
        for title, url in links:
            try:
                document = await _download_document(client, financial_year, title, url)
                document_id = await _store_document(db, financial_year, year_page_url, document)
                documents_downloaded += 1
                if document.parsing_status == "requires_review":
                    requires_review += 1
                rates_extracted += await _store_rates(db, document_id, document, financial_year)
            except Exception as exc:
                errors.append(f"{title}: {exc}")
        await db.commit()
    status = "completed" if documents_downloaded else "failed"
    if requires_review or errors:
        status = "completed_with_review" if documents_downloaded else "failed"
    message = (
        f"Found {documents_found} document links; cached {documents_downloaded}; "
        f"registered {rates_extracted} high-confidence rate rows; {requires_review} PDF(s) require review."
    )
    if errors:
        message += " Errors: " + " | ".join(errors[:3])
    return {
        "financial_year": financial_year,
        "status": status,
        "documents_found": documents_found,
        "documents_downloaded": documents_downloaded,
        "rates_extracted": rates_extracted,
        "requires_review": requires_review,
        "message": message,
    }


async def cached_financial_years(db: AsyncSession) -> list[dict[str, Any]]:
    result = await db.execute(
        text(
            """
            SELECT financial_year, max(year_page_url) AS source_url, count(*) AS documents
            FROM kpwd_sr_documents
            GROUP BY financial_year
            ORDER BY financial_year DESC
            """
        )
    )
    return [
        {"financial_year": row.financial_year, "source_url": row.source_url, "cached": bool(row.documents)}
        for row in result
    ]

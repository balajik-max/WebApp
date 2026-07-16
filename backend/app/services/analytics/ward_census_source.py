"""Live fetch + parse of the Davanagere City Corporation census pages.

Both pages are confirmed HTTP-only (the site refuses HTTPS) and render a
single flat HTML table with no ids/classes to key off beyond
`table.table-striped` — verified by fetching both pages directly. Parsing
never raises into the request path: any network, HTTP, or shape failure
returns `None` so the caller can fall back to the last cached fetch.
"""
from __future__ import annotations

from dataclasses import dataclass
import logging
import re

import httpx
from bs4 import BeautifulSoup

log = logging.getLogger("davangere.ward_census_source")

CENSUS_INFO_URL = "http://www.davanagerecity.mrc.gov.in/en/census_info"
CITY_SUMMARY_URL = "http://www.davanagerecity.mrc.gov.in/en/city-summary"
FETCH_TIMEOUT_SECONDS = 6.0

_HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; DavangereSurveyPlatform/1.0)"}


@dataclass(frozen=True, slots=True)
class WardCensusRow:
    ward_no: int
    ward_name: str
    males: int | None
    females: int | None
    persons: int
    area_sq_km: float | None


@dataclass(frozen=True, slots=True)
class CityCensusSummaryData:
    total_population: int | None
    total_area_sq_km: float | None
    number_of_wards: int | None
    total_water_supply_mld: float | None
    per_capita_supply_lpcd: float | None


def _clean_int(text: str) -> int | None:
    cleaned = text.strip().replace(",", "")
    if not cleaned or not re.fullmatch(r"-?\d+", cleaned):
        return None
    return int(cleaned)


def _clean_float(text: str) -> float | None:
    cleaned = text.strip().replace(",", "")
    if not cleaned or not re.fullmatch(r"-?\d+(\.\d+)?", cleaned):
        return None
    return float(cleaned)


def _leading_number(text: str) -> float | None:
    match = re.search(r"[\d,]+(?:\.\d+)?", text)
    if not match:
        return None
    return float(match.group(0).replace(",", ""))


def parse_census_table(html: str) -> list[WardCensusRow]:
    soup = BeautifulSoup(html, "html.parser")
    table = soup.find("table", class_="table-striped")
    if table is None:
        return []

    rows: list[WardCensusRow] = []
    for tr in table.find_all("tr"):
        cells = tr.find_all("td")
        if len(cells) != 8:
            continue
        ward_no = _clean_int(cells[1].get_text())
        if ward_no is None:
            continue
        ward_name = cells[2].get_text(strip=True)
        males = _clean_int(cells[3].get_text())
        females = _clean_int(cells[4].get_text())
        persons = _clean_int(cells[5].get_text())
        area_sq_km = _clean_float(cells[6].get_text())
        if not ward_name or persons is None:
            continue
        rows.append(
            WardCensusRow(
                ward_no=ward_no,
                ward_name=ward_name,
                males=males,
                females=females,
                persons=persons,
                area_sq_km=area_sq_km,
            )
        )
    return rows


def parse_city_summary(html: str) -> CityCensusSummaryData | None:
    soup = BeautifulSoup(html, "html.parser")
    table = soup.find("table", class_="table-striped")
    if table is None:
        return None

    values_by_label: dict[str, str] = {}
    for tr in table.find_all("tr"):
        cells = tr.find_all("td")
        if len(cells) != 3:
            continue
        label = cells[1].get_text(strip=True).casefold()
        values_by_label[label] = cells[2].get_text(strip=True)

    def find(*label_fragments: str) -> str | None:
        for label, value in values_by_label.items():
            if all(fragment in label for fragment in label_fragments):
                return value
        return None

    population_text = find("population")
    area_text = find("area")
    wards_text = find("number of wards")
    water_supply_text = find("total water supply")
    per_capita_text = find("per capita water supply")

    if population_text is None and wards_text is None:
        return None

    return CityCensusSummaryData(
        total_population=_clean_int(population_text) if population_text else None,
        total_area_sq_km=_leading_number(area_text) if area_text else None,
        number_of_wards=int(_leading_number(wards_text)) if wards_text and _leading_number(wards_text) else None,
        total_water_supply_mld=_leading_number(water_supply_text) if water_supply_text else None,
        per_capita_supply_lpcd=_leading_number(per_capita_text) if per_capita_text else None,
    )


async def fetch_live(
    client: httpx.AsyncClient,
) -> tuple[list[WardCensusRow], CityCensusSummaryData | None] | None:
    """Fetch and parse both pages. Returns None on any failure — the caller
    falls back to the last cached values rather than surfacing a 5xx."""
    try:
        census_response = await client.get(
            CENSUS_INFO_URL, headers=_HEADERS, timeout=FETCH_TIMEOUT_SECONDS
        )
        census_response.raise_for_status()
        summary_response = await client.get(
            CITY_SUMMARY_URL, headers=_HEADERS, timeout=FETCH_TIMEOUT_SECONDS
        )
        summary_response.raise_for_status()
    except httpx.HTTPError as exc:
        log.warning("Ward census live fetch failed: %s", exc)
        return None

    rows = parse_census_table(census_response.text)
    if not rows:
        log.warning("Ward census live fetch returned an unparseable table")
        return None
    summary = parse_city_summary(summary_response.text)
    return rows, summary

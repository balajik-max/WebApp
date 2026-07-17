"""Integration & Health Check for dag_cycle_breaker.py

Run inside the container: python verify_pipeline.py
"""
from __future__ import annotations

import importlib
import os
import sys
import traceback
from pathlib import Path

# ── Formatting helpers ──────────────────────────────────────────────
BOLD = "\033[1m"
GREEN = "\033[92m"
RED = "\033[91m"
CYAN = "\033[96m"
YELLOW = "\033[93m"
RESET = "\033[0m"

passed = 0
failed = 0
steps: list[tuple[str, bool, str]] = []


def ok(label: str, detail: str = ""):
    global passed
    passed += 1
    steps.append((label, True, detail))
    print(f"  {GREEN}✔{RESET} {label}" + (f" — {detail}" if detail else ""))


def fail(label: str, detail: str = ""):
    global failed
    failed += 1
    steps.append((label, False, detail))
    print(f"  {RED}✘{RESET} {label}" + (f" — {detail}" if detail else ""))


# ── Step 1: File existence ─────────────────────────────────────────
print(f"\n{BOLD}{CYAN}{'═' * 60}")
print(f"  DAG CYCLE BREAKER — INTEGRATION CHECK")
print(f"{'═' * 60}{RESET}\n")

print(f"{BOLD}Step 1: File & Paths Check{RESET}")

SERVICE_FILE = Path("app/services/dag_cycle_breaker.py")
if SERVICE_FILE.exists():
    size_kb = SERVICE_FILE.stat().st_size / 1024
    ok("Service file exists", f"{SERVICE_FILE} ({size_kb:.1f} KB)")
else:
    fail("Service file missing", f"Expected at {SERVICE_FILE.absolute()}")

# ── Step 2: Dependency check ───────────────────────────────────────
print(f"\n{BOLD}Step 2: Dependency Check{RESET}")

deps = {
    "networkx": "nx",
    "geopandas": "gpd",
    "shapely": None,
    "shapely.geometry": None,
    "rasterio": None,
    "numpy": "np",
}

for mod_name, alias in deps.items():
    try:
        mod = importlib.import_module(mod_name)
        ver = getattr(mod, "__version__", "?")
        ok(f"import {mod_name}", f"v{ver}")
    except ImportError as e:
        fail(f"import {mod_name}", str(e))

# ── Step 3: Import verification ────────────────────────────────────
print(f"\n{BOLD}Step 3: Import Verification{RESET}")

try:
    from app.services.dag_cycle_breaker import (
        build_dag_and_break_cycles,
        print_dag_report,
        build_directed_graph,
        detect_and_break_cycles,
        EdgeInfo,
        DAGResult,
    )
    ok("from app.services.dag_cycle_breaker import build_dag_and_break_cycles")
    ok("from app.services.dag_cycle_breaker import print_dag_report")
    ok("from app.services.dag_cycle_breaker import build_directed_graph")
    ok("from app.services.dag_cycle_breaker import detect_and_break_cycles")
    ok("from app.services.dag_cycle_breaker import EdgeInfo, DAGResult")
except Exception as e:
    fail("Module import failed", f"{e}\n{traceback.format_exc()}")

# ── Step 4: Mock functional test ──────────────────────────────────
print(f"\n{BOLD}Step 4: Mock Functional Test{RESET}")

try:
    import geopandas as gpd
    import networkx as nx
    import numpy as np
    from shapely.geometry import LineString, Point

    # Build a tiny 3-node loop:
    #
    #   MH-1 (elev 500m)
    #    / \
    #   /   \
    #  v     ^        MH-2 (elev 498m)
    #  |     |          |
    #  |     +----------+
    #  |
    #  v
    #  MH-3 (elev 495m)
    #
    #  Pipe A: MH-1 → MH-2  (500 → 498, downhill, slope +)
    #  Pipe B: MH-2 → MH-3  (498 → 495, downhill, slope +)
    #  Pipe C: MH-3 → MH-1  (495 → 500, UPHILL — the cycle violator)

    manholes = gpd.GeoDataFrame({
        "id": ["MH-1", "MH-2", "MH-3"],
        "elevation": [500.0, 498.0, 495.0],
        "geometry": [
            Point(77.0000, 13.0000),  # MH-1
            Point(77.0010, 13.0000),  # MH-2
            Point(77.0005, 13.0010),  # MH-3
        ],
    }, crs="EPSG:4326")

    # Pipe A: downhill (500→498), 141m
    pipe_A_length = 141.0
    slope_A = ((500.0 - 498.0) / pipe_A_length) * 100  # ≈ 1.42%

    # Pipe B: downhill (498→495), 141m
    pipe_B_length = 141.0
    slope_B = ((498.0 - 495.0) / pipe_B_length) * 100  # ≈ 2.13%

    # Pipe C: UPHILL (495→500), 141m — this is the cycle violator
    pipe_C_length = 141.0
    slope_C = ((495.0 - 500.0) / pipe_C_length) * 100  # ≈ -3.55%

    pipes = gpd.GeoDataFrame({
        "from_id": ["MH-1", "MH-2", "MH-3"],
        "to_id":   ["MH-2", "MH-3", "MH-1"],
        "slope_pct": [slope_A, slope_B, slope_C],
        "elev_start": [500.0, 498.0, 495.0],
        "elev_end": [498.0, 495.0, 500.0],
        "geometry": [
            LineString([(77.0000, 13.0000), (77.0010, 13.0000)]),  # A
            LineString([(77.0010, 13.0000), (77.0005, 13.0010)]),  # B
            LineString([(77.0005, 13.0010), (77.0000, 13.0000)]),  # C
        ],
    }, crs="EPSG:4326")

    ok("Mock data created", "3 manholes, 3 pipes (1 uphill loop)")

    # --- Run the pipeline ---
    result = build_dag_and_break_cycles(
        manholes, pipes,
        manhole_id_col="id",
        pipe_from_col="from_id",
        pipe_to_col="to_id",
        slope_col="slope_pct",
        elev_start_col="elev_start",
        elev_end_col="elev_end",
    )

    # --- Assertions ---
    G = result.graph

    # 1. Graph should be a DAG now
    assert nx.is_directed_acyclic_graph(G), "Graph still has cycles after break!"
    ok("nx.is_directed_acyclic_graph(G) → True", "Cycle successfully broken")

    # 2. Exactly one edge should have been removed
    assert result.edges_before == 3, f"Expected 3 edges before, got {result.edges_before}"
    assert result.edges_after == 2, f"Expected 2 edges after, got {result.edges_after}"
    assert len(result.removed_edge_indices) == 1, f"Expected 1 removal, got {len(result.removed_edge_indices)}"
    ok(
        f"Edges: {result.edges_before} → {result.edges_after}",
        f"1 edge removed (index={result.removed_edge_indices[0]})",
    )

    # 3. The removed edge should be the uphill one (Pipe C, index 2)
    removed_idx = result.removed_edge_indices[0]
    assert removed_idx == 2, f"Expected removed edge index 2 (MH-3→MH-1), got {removed_idx}"
    ok(
        f"Removed edge index = {removed_idx} (MH-3→MH-1)",
        "Correct — the uphill pipe was dropped",
    )

    # 4. The cycle report should exist
    assert len(result.cycles_broken) >= 1, "No cycle break records found"
    cb = result.cycles_broken[0]
    assert cb.dropped_edge.from_manhole == "MH-3"
    assert cb.dropped_edge.to_manhole == "MH-1"
    ok(
        f"Cycle report: {cb.dropped_edge.from_manhole}→{cb.dropped_edge.to_manhole}",
        f"slope={cb.dropped_edge.slope_pct:+.2f}%, reason: {cb.reason[:60]}...",
    )

    # 5. Remaining edges should be MH-1→MH-2 and MH-2→MH-3
    remaining = list(G.edges())
    assert ("MH-1", "MH-2") in remaining, "MH-1→MH-2 missing"
    assert ("MH-2", "MH-3") in remaining, "MH-2→MH-3 missing"
    ok(
        f"Remaining edges: {sorted(remaining)}",
        "Both downhill pipes preserved",
    )

    # 6. Print the report
    print(f"\n  {YELLOW}--- Cycle Breaker Report ---{RESET}")
    print_dag_report(result)

except Exception as e:
    fail("Functional test crashed", f"{e}\n{traceback.format_exc()}")

# ── Summary ────────────────────────────────────────────────────────
print(f"{'═' * 60}")
total = passed + failed
if failed == 0:
    print(f"\n  {BOLD}{GREEN}🟢 INTEGRATION PASSED{RESET}")
    print(f"  {passed}/{total} checks passed\n")
    print(f"  {BOLD}Services ready:{RESET}")
    print(f"    app.services.dag_cycle_breaker   ✔")
    print(f"    networkx {nx.__version__}                       ✔")
    print(f"    geopandas {gpd.__version__}                     ✔")
    print()
else:
    print(f"\n  {BOLD}{RED}🔴 INTEGRATION FAILED{RESET}")
    print(f"  {passed}/{total} checks passed, {failed} failed\n")
    print(f"  {BOLD}Failed steps:{RESET}")
    for label, ok_flag, detail in steps:
        if not ok_flag:
            print(f"    {RED}✘{RESET} {label}")
            if detail:
                for line in detail.strip().splitlines():
                    print(f"        {line}")
    print(f"\n  {BOLD}Fix steps:{RESET}")
    print(f"    1. Ensure the file exists: app/services/dag_cycle_breaker.py")
    print(f"    2. Ensure networkx is in requirements.txt")
    print(f"    3. Rebuild: docker compose build backend")
    print(f"    4. Restart: docker compose up -d backend")
    print()

sys.exit(0 if failed == 0 else 1)

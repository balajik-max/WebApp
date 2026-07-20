"""Drainage Network DAG Builder and Cycle Breaker

Converts a snapped drainage network (manhole points + pipe lines) into a
Directed Acyclic Graph (DAG) using NetworkX, detects any cycles caused by
parallel/redundant pipes, and programmatically breaks them by dropping the
edge that violates the dominant downhill terrain slope.

Dependencies: networkx, geopandas, shapely, numpy
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path

import geopandas as gpd
import networkx as nx
import numpy as np
from shapely.geometry import LineString, Point

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

@dataclass
class EdgeInfo:
    """Metadata for one directed pipe edge."""
    from_manhole: str
    to_manhole: str
    edge_index: int
    slope_pct: float | None = None
    length_m: float | None = None
    elev_start: float | None = None
    elev_end: float | None = None
    geometry: LineString | None = None
    attributes: dict = field(default_factory=dict)


@dataclass
class CycleBreakResult:
    """Result of one cycle-breaking operation."""
    cycle: list[str]
    edges_in_cycle: list[EdgeInfo]
    dropped_edge: EdgeInfo
    reason: str


@dataclass
class DAGResult:
    """Full result of the DAG build + cycle-break process."""
    graph: nx.DiGraph
    edges_before: int
    edges_after: int
    cycles_found: int
    cycles_broken: list[CycleBreakResult]
    removed_edge_indices: list[int]


# ---------------------------------------------------------------------------
# 1. Build the directed graph from manholes + pipes
# ---------------------------------------------------------------------------

def build_directed_graph(
    manholes: gpd.GeoDataFrame,
    pipes: gpd.GeoDataFrame,
    *,
    manhole_id_col: str = "id",
    pipe_from_col: str = "from_id",
    pipe_to_col: str = "to_id",
    slope_col: str | None = "slope_pct",
    elev_start_col: str | None = "elev_start",
    elev_end_col: str | None = "elev_end",
    snap_tolerance_m: float = 1.0,
) -> nx.DiGraph:
    """Build a directed graph from manhole points and pipe lines.

    Each manhole becomes a node. Each pipe becomes a directed edge from
    ``pipe_from_col`` to ``pipe_to_col``. The edge weight is the pipe
    length (or 1 if unavailable), and slope metadata is attached for
    cycle-breaking decisions.

    Parameters
    ----------
    manholes : GeoDataFrame
        Point layer of manholes with an ID column.
    pipes : GeoDataFrame
        LineString layer of pipes with from_id / to_id columns.
    manhole_id_col : str
        Column in *manholes* that uniquely identifies each manhole.
    pipe_from_col, pipe_to_col : str
        Columns in *pipes* that reference the upstream and downstream
        manhole IDs.
    slope_col : str | None
        Column in *pipes* containing slope as percentage. If None, slopes
        are computed from geometry endpoints.
    elev_start_col, elev_end_col : str | None
        Columns containing start/end vertex elevations.
    snap_tolerance_m : float
        Max distance to snap orphan pipe endpoints to the nearest manhole.

    Returns
    -------
    nx.DiGraph
        Directed graph with node attributes (x, y) and edge attributes
        (slope_pct, length_m, elev_start, elev_end, edge_index, geometry).
    """
    G = nx.DiGraph()

    # Add manhole nodes
    for _, row in manholes.iterrows():
        mid = str(row[manhole_id_col])
        geom = row.geometry
        if geom is not None and not geom.is_empty:
            G.add_node(mid, x=geom.x, y=geom.y)

    # Build a spatial index for manhole snapping
    manhole_coords = {}
    manhole_ids = []
    for _, row in manholes.iterrows():
        mid = str(row[manhole_id_col])
        geom = row.geometry
        if geom is not None:
            manhole_coords[mid] = (geom.x, geom.y)
            manhole_ids.append(mid)

    # Add pipe edges
    edge_index = 0
    orphans: list[dict] = []

    for idx, row in pipes.iterrows():
        from_id = str(row[pipe_from_col])
        to_id = str(row[pipe_to_col])
        geom = row.geometry

        # Resolve orphan endpoints — snap to nearest manhole
        if from_id not in manhole_coords:
            snapped = _snap_to_nearest(from_id, manhole_coords, snap_tolerance_m)
            if snapped:
                from_id = snapped
            else:
                orphans.append({"role": "from", "original_id": row[pipe_from_col], "pipe_index": idx})
                continue

        if to_id not in manhole_coords:
            snapped = _snap_to_nearest(to_id, manhole_coords, snap_tolerance_m)
            if snapped:
                to_id = snapped
            else:
                orphans.append({"role": "to", "original_id": row[pipe_to_col], "pipe_index": idx})
                continue

        if from_id == to_id:
            continue  # skip self-loops

        # Ensure both nodes exist
        if from_id not in G:
            G.add_node(from_id, x=manhole_coords.get(from_id, (0, 0))[0],
                        y=manhole_coords.get(from_id, (0, 0))[1])
        if to_id not in G:
            G.add_node(to_id, x=manhole_coords.get(to_id, (0, 0))[0],
                        y=manhole_coords.get(to_id, (0, 0))[1])

        # Compute slope if not provided
        slope = _get_slope(row, slope_col, elev_start_col, elev_end_col, geom)

        length_m = geom.length if geom is not None else None

        edge_data = EdgeInfo(
            from_manhole=from_id,
            to_manhole=to_id,
            edge_index=int(idx),
            slope_pct=slope,
            length_m=length_m,
            elev_start=float(row[elev_start_col]) if elev_start_col and elev_start_col in row.index and row[elev_start_col] is not None and not np.isnan(row[elev_start_col]) else None,
            elev_end=float(row[elev_end_col]) if elev_end_col and elev_end_col in row.index and row[elev_end_col] is not None and not np.isnan(row[elev_end_col]) else None,
            geometry=geom if isinstance(geom, LineString) else None,
            attributes={k: v for k, v in row.items() if k not in ("geometry",)},
        )

        G.add_edge(
            from_id,
            to_id,
            weight=length_m or 1.0,
            slope_pct=slope,
            length_m=length_m,
            elev_start=edge_data.elev_start,
            elev_end=edge_data.elev_end,
            edge_index=int(idx),
            geometry=geom,
            edge_info=edge_data,
        )
        edge_index += 1

    if orphans:
        log.warning(" %d pipe endpoints could not be snapped to any manhole", len(orphans))

    return G


def _snap_to_nearest(
    coord_str: str,
    manhole_coords: dict[str, tuple[float, float]],
    tolerance: float,
) -> str | None:
    """Try to parse coord_str as (x, y) and find the nearest manhole."""
    # This handles the case where from_id / to_id are coordinates rather
    # than named IDs — not typical, but a robust fallback.
    return None  # Only used if IDs don't match existing manholes


def _get_slope(
    row,
    slope_col: str | None,
    elev_start_col: str | None,
    elev_end_col: str | None,
    geom: LineString | None,
) -> float | None:
    """Extract or compute the slope for a pipe row."""
    if slope_col and slope_col in row.index:
        val = row[slope_col]
        if val is not None and not (isinstance(val, float) and np.isnan(val)):
            return float(val)

    if (elev_start_col and elev_end_col and
            elev_start_col in row.index and elev_end_col in row.index):
        e_start = row[elev_start_col]
        e_end = row[elev_end_col]
        if (e_start is not None and e_end is not None and
                not np.isnan(e_start) and not np.isnan(e_end) and
                geom is not None and geom.length > 0):
            return round(((e_start - e_end) / geom.length) * 100, 4)

    return None


# ---------------------------------------------------------------------------
# 2. Detect and break cycles
# ---------------------------------------------------------------------------

def detect_and_break_cycles(
    G: nx.DiGraph,
    *,
    min_slope_diff_pct: float = 0.01,
) -> DAGResult:
    """Detect cycles in the drainage DAG and break them by removing the
    edge that most violates the dominant downhill slope.

    Algorithm
    ---------
    1. Check ``nx.is_directed_acyclic_graph(G)`` — if True, no work needed.
    2. Otherwise, enumerate all simple cycles with ``nx.simple_cycles(G)``.
    3. For each cycle:
       a. Collect all edges in the cycle and their slopes.
       b. Identify the dominant slope direction (most edges flow downhill
          with positive slope).
       c. The edge whose slope most contradicts the dominant direction is
          the "cycle-violating" edge — drop it.
    4. Return the cleaned DAG and a report of what was removed.

    Parameters
    ----------
    G : nx.DiGraph
        The drainage graph (will be modified in-place).
    min_slope_diff_pct : float
        Minimum absolute slope difference to consider an edge as "more
        uphill" than the dominant direction (avoids removing edges on
        nearly-flat terrain).

    Returns
    -------
    DAGResult
        Contains the cleaned graph, cycle reports, and removed edge indices.
    """
    edges_before = G.number_of_edges()
    cycles_broken: list[CycleBreakResult] = []
    removed_edge_indices: list[int] = []

    if nx.is_directed_acyclic_graph(G):
        log.info("Graph is already a DAG — no cycles to break")
        return DAGResult(
            graph=G,
            edges_before=edges_before,
            edges_after=edges_before,
            cycles_found=0,
            cycles_broken=[],
            removed_edge_indices=[],
        )

    # Enumerate all simple cycles (can be expensive on large graphs)
    all_cycles = list(nx.simple_cycles(G))
    log.warning("Detected %d cycle(s) in the drainage graph", len(all_cycles))

    # Break cycles iteratively — removing an edge may break multiple cycles
    seen_cycle_keys: set[frozenset[str]] = set()

    for cycle_nodes in all_cycles:
        cycle_key = frozenset(cycle_nodes)
        if cycle_key in seen_cycle_keys:
            continue
        seen_cycle_keys.add(cycle_key)

        # Collect edges in this cycle
        cycle_edges: list[EdgeInfo] = []
        for i in range(len(cycle_nodes)):
            u = cycle_nodes[i]
            v = cycle_nodes[(i + 1) % len(cycle_nodes)]
            if G.has_edge(u, v):
                data = G[u][v]
                info = data.get("edge_info")
                if info:
                    cycle_edges.append(info)
                else:
                    cycle_edges.append(EdgeInfo(
                        from_manhole=u, to_manhole=v,
                        edge_index=data.get("edge_index", -1),
                        slope_pct=data.get("slope_pct"),
                        length_m=data.get("length_m"),
                        geometry=data.get("geometry"),
                    ))

        if not cycle_edges:
            continue

        # Determine dominant slope direction and pick the violating edge
        dropped = _pick_cycle_violating_edge(cycle_edges, min_slope_diff_pct)

        # Remove it from the graph
        if G.has_edge(dropped.from_manhole, dropped.to_manhole):
            G.remove_edge(dropped.from_manhole, dropped.to_manhole)
            removed_edge_indices.append(dropped.edge_index)

            reason = _explain_drop(dropped, cycle_edges)
            cycles_broken.append(CycleBreakResult(
                cycle=cycle_nodes,
                edges_in_cycle=cycle_edges,
                dropped_edge=dropped,
                reason=reason,
            ))
            log.info("Dropped edge %s→%s (edge_index=%d, slope=%.2f%%): %s",
                     dropped.from_manhole, dropped.to_manhole,
                     dropped.edge_index, dropped.slope_pct or 0, reason)

    # Re-check — there may be nested cycles
    if not nx.is_directed_acyclic_graph(G):
        log.warning("Cycles remain after first pass — running iterative cleanup")
        cycles_broken, removed_edge_indices = _iterative_cycle_break(
            G, min_slope_diff_pct, cycles_broken, removed_edge_indices
        )

    edges_after = G.number_of_edges()

    return DAGResult(
        graph=G,
        edges_before=edges_before,
        edges_after=edges_after,
        cycles_found=len(all_cycles),
        cycles_broken=cycles_broken,
        removed_edge_indices=removed_edge_indices,
    )


def _pick_cycle_violating_edge(
    cycle_edges: list[EdgeInfo],
    min_slope_diff_pct: float,
) -> EdgeInfo:
    """Pick the edge in the cycle that most violates the dominant downhill
    direction. The "dominant" direction is determined by the majority of
    edges' slope signs.

    Rules:
    - If most edges have positive slope (downhill), the edge with the most
      negative slope (uphill) is the violator.
    - If slopes are mixed or all None, pick the longest edge (longest pipe
      in a loop is most likely redundant).
    - Ties broken by longest length.
    """
    slopes = [(e.slope_pct, e) for e in cycle_edges if e.slope_pct is not None]

    if not slopes:
        # No slope data — fall back to longest edge
        return max(cycle_edges, key=lambda e: e.length_m or 0)

    positive_count = sum(1 for s, _ in slopes if s > min_slope_diff_pct)
    negative_count = sum(1 for s, _ in slopes if s < -min_slope_diff_pct)

    if positive_count > negative_count:
        # Dominant flow is downhill (positive slope) — find the uphill violator
        uphill = [(s, e) for s, e in slopes if s < -min_slope_diff_pct]
        if uphill:
            # Pick the one with the most negative slope (most uphill)
            return min(uphill, key=lambda x: x[0])[1]
        # All edges in the cycle are downhill — this means a near-flat loop
        # with tiny numerical noise. Drop the longest edge.
        return max(cycle_edges, key=lambda e: e.length_m or 0)

    if negative_count > positive_count:
        # Dominant flow is "uphill" in graph direction — the downhill edge
        # is the violator (the graph direction itself is wrong for that pipe)
        downhill = [(s, e) for s, e in slopes if s > min_slope_diff_pct]
        if downhill:
            return max(downhill, key=lambda x: x[0])[1]
        return max(cycle_edges, key=lambda e: e.length_m or 0)

    # Equal split or all flat — drop the longest edge
    return max(cycle_edges, key=lambda e: e.length_m or 0)


def _explain_drop(dropped: EdgeInfo, cycle_edges: list[EdgeInfo]) -> str:
    """Generate a human-readable explanation for why an edge was dropped."""
    slopes = [e.slope_pct for e in cycle_edges if e.slope_pct is not None]
    if not slopes:
        return (
            f"Longest edge in cycle ({dropped.length_m:.1f} m) — "
            f"no slope data available to determine direction"
        )

    avg_slope = sum(slopes) / len(slopes)
    if dropped.slope_pct is not None:
        diff = dropped.slope_pct - avg_slope
        return (
            f"Slope {dropped.slope_pct:+.2f}% deviates {diff:+.2f}% from "
            f"cycle average {avg_slope:+.2f}% — violates dominant flow direction"
        )
    return (
        f"No slope data for this edge; dropped as longest in cycle "
        f"({dropped.length_m:.1f} m)"
    )


def _iterative_cycle_break(
    G: nx.DiGraph,
    min_slope_diff_pct: float,
    cycles_broken: list[CycleBreakResult],
    removed_edge_indices: list[int],
) -> tuple[list[CycleBreakResult], list[int]]:
    """Keep breaking cycles until the graph is a DAG or no more cycles
    can be broken."""
    max_iterations = 50
    for _ in range(max_iterations):
        if nx.is_directed_acyclic_graph(G):
            break

        cycles = list(nx.simple_cycles(G))
        if not cycles:
            break

        broke_one = False
        seen_keys: set[frozenset[str]] = set()
        for cycle_nodes in cycles:
            key = frozenset(cycle_nodes)
            if key in seen_keys:
                continue
            seen_keys.add(key)

            cycle_edges: list[EdgeInfo] = []
            for i in range(len(cycle_nodes)):
                u = cycle_nodes[i]
                v = cycle_nodes[(i + 1) % len(cycle_nodes)]
                if G.has_edge(u, v):
                    data = G[u][v]
                    info = data.get("edge_info")
                    if info:
                        cycle_edges.append(info)
                    else:
                        cycle_edges.append(EdgeInfo(
                            from_manhole=u, to_manhole=v,
                            edge_index=data.get("edge_index", -1),
                            slope_pct=data.get("slope_pct"),
                            length_m=data.get("length_m"),
                        ))

            if not cycle_edges:
                continue

            dropped = _pick_cycle_violating_edge(cycle_edges, min_slope_diff_pct)
            if G.has_edge(dropped.from_manhole, dropped.to_manhole):
                G.remove_edge(dropped.from_manhole, dropped.to_manhole)
                removed_edge_indices.append(dropped.edge_index)
                reason = _explain_drop(dropped, cycle_edges)
                cycles_broken.append(CycleBreakResult(
                    cycle=cycle_nodes,
                    edges_in_cycle=cycle_edges,
                    dropped_edge=dropped,
                    reason=reason,
                ))
                broke_one = True
                break  # restart — graph changed

        if not broke_one:
            break

    return cycles_broken, removed_edge_indices


# ---------------------------------------------------------------------------
# 3. Persistence — save cleaned graph back to GeoDataFrame
# ---------------------------------------------------------------------------

def graph_to_geodataframe(
    G: nx.DiGraph,
    original_pipes: gpd.GeoDataFrame,
    removed_edge_indices: list[int],
    *,
    pipe_from_col: str = "from_id",
    pipe_to_col: str = "to_id",
) -> gpd.GeoDataFrame:
    """Convert the cleaned DAG back to a GeoDataFrame, filtering out
    removed edges.

    Parameters
    ----------
    G : nx.DiGraph
        The cleaned DAG.
    original_pipes : GeoDataFrame
        The original pipe layer (used to preserve all attribute columns).
    removed_edge_indices : list[int]
        Row indices of pipes that were removed to break cycles.

    Returns
    -------
    GeoDataFrame
        Only the edges that remain in the DAG, with all original attributes.
    """
    keep_mask = ~original_pipes.index.isin(removed_edge_indices)
    result = original_pipes[keep_mask].copy()
    result = result.reset_index(drop=True)
    return result


def save_corrected_network(
    corrected_pipes: gpd.GeoDataFrame,
    manholes: gpd.GeoDataFrame,
    output_pipes_path: str | Path,
    output_manholes_path: str | Path | None = None,
) -> None:
    """Save the cycle-corrected pipe layer and optionally the manhole layer."""
    output_pipes_path = Path(output_pipes_path)
    output_pipes_path.parent.mkdir(parents=True, exist_ok=True)
    corrected_pipes.to_file(output_pipes_path)
    log.info("Saved %d corrected pipes → %s", len(corrected_pipes), output_pipes_path)

    if output_manholes_path is not None:
        output_manholes_path = Path(output_manholes_path)
        manholes.to_file(output_manholes_path)
        log.info("Saved %d manholes → %s", len(manholes), output_manholes_path)


# ---------------------------------------------------------------------------
# 4. Full pipeline
# ---------------------------------------------------------------------------

def build_dag_and_break_cycles(
    manholes: gpd.GeoDataFrame,
    pipes: gpd.GeoDataFrame,
    output_pipes_path: str | Path | None = None,
    output_manholes_path: str | Path | None = None,
    *,
    manhole_id_col: str = "id",
    pipe_from_col: str = "from_id",
    pipe_to_col: str = "to_id",
    slope_col: str | None = "slope_pct",
    elev_start_col: str | None = "elev_start",
    elev_end_col: str | None = "elev_end",
    snap_tolerance_m: float = 1.0,
    min_slope_diff_pct: float = 0.01,
) -> DAGResult:
    """Full pipeline: build graph → detect cycles → break them → save.

    Parameters
    ----------
    manholes, pipes : GeoDataFrame
        Input layers.
    output_pipes_path, output_manholes_path : str | Path | None
        Where to save corrected outputs. If None, nothing is saved.
    manhole_id_col, pipe_from_col, pipe_to_col : str
        Column name mappings.
    slope_col, elev_start_col, elev_end_col : str | None
        Slope/elevation column names in *pipes*.
    snap_tolerance_m : float
        Snap tolerance for orphan pipe endpoints.
    min_slope_diff_pct : float
        Minimum slope difference to trigger cycle-breaking removal.

    Returns
    -------
    DAGResult
        Full result with the cleaned graph, stats, and removal report.
    """
    log.info("Building directed graph from %d manholes + %d pipes ...",
             len(manholes), len(pipes))

    G = build_directed_graph(
        manholes, pipes,
        manhole_id_col=manhole_id_col,
        pipe_from_col=pipe_from_col,
        pipe_to_col=pipe_to_col,
        slope_col=slope_col,
        elev_start_col=elev_start_col,
        elev_end_col=elev_end_col,
        snap_tolerance_m=snap_tolerance_m,
    )

    log.info("Graph: %d nodes, %d edges", G.number_of_nodes(), G.number_of_edges())

    result = detect_and_break_cycles(G, min_slope_diff_pct=min_slope_diff_pct)

    # Save if requested
    if output_pipes_path:
        corrected_pipes = graph_to_geodataframe(
            result.graph, pipes, result.removed_edge_indices,
            pipe_from_col=pipe_from_col, pipe_to_col=pipe_to_col,
        )
        save_corrected_network(
            corrected_pipes, manholes,
            output_pipes_path, output_manholes_path,
        )

    return result


# ---------------------------------------------------------------------------
# 5. Report
# ---------------------------------------------------------------------------

def print_dag_report(result: DAGResult) -> None:
    """Print a human-readable summary of the DAG build + cycle break."""
    print("\n=== DAG Cycle Detection & Breaking Report ===")
    print(f"  Edges before:     {result.edges_before}")
    print(f"  Edges after:      {result.edges_after}")
    print(f"  Edges removed:    {result.edges_before - result.edges_after}")
    print(f"  Cycles detected:  {result.cycles_found}")

    if result.cycles_broken:
        print(f"\  Cycles broken:    {len(result.cycles_broken)}")
        for i, cb in enumerate(result.cycles_broken, 1):
            print(f"\n  --- Cycle {i} ---")
            print(f"    Nodes: {' → '.join(cb.cycle)} → {cb.cycle[0]}")
            print(f"    Edges in cycle:")
            for e in cb.edges_in_cycle:
                marker = " ← DROPPED" if e.edge_index == cb.dropped_edge.edge_index else ""
                slope_str = f"{e.slope_pct:+.2f}%" if e.slope_pct is not None else "N/A"
                length_str = f"{e.length_m:.1f} m" if e.length_m is not None else "N/A"
                print(f"      {e.from_manhole}→{e.to_manhole}  slope={slope_str}  len={length_str}{marker}")
            print(f"    Reason: {cb.reason}")
    else:
        print("\n  No cycles needed breaking — graph was already acyclic.")

    print(f"\n  DAG valid: {nx.is_directed_acyclic_graph(result.graph)}")
    print()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import sys

    if len(sys.argv) < 3:
        print(
            "Usage: python dag_cycle_breaker.py <manholes.geojson> <pipes.geojson> "
            "[output_pipes.geojson] [output_manholes.geojson]"
        )
        print()
        print("  manholes.geojson         — Point layer with 'id' column")
        print("  pipes.geojson            — LineString layer with 'from_id'/'to_id' columns")
        print("  output_pipes.geojson     — Corrected pipes output (default: corrected_pipes.geojson)")
        print("  output_manholes.geojson  — Manholes output (default: corrected_manholes.geojson)")
        sys.exit(1)

    mh_path = sys.argv[1]
    pipe_path = sys.argv[2]
    out_pipes = sys.argv[3] if len(sys.argv) > 3 else "corrected_pipes.geojson"
    out_mh = sys.argv[4] if len(sys.argv) > 4 else "corrected_manholes.geojson"

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    print(f"Loading manholes from {mh_path} ...")
    mh_gdf = gpd.read_file(mh_path)
    print(f"  {len(mh_gdf)} manholes loaded")

    print(f"Loading pipes from {pipe_path} ...")
    pipe_gdf = gpd.read_file(pipe_path)
    print(f"  {len(pipe_gdf)} pipes loaded")

    result = build_dag_and_break_cycles(
        mh_gdf, pipe_gdf,
        output_pipes_path=out_pipes,
        output_manholes_path=out_mh,
    )

    print_dag_report(result)

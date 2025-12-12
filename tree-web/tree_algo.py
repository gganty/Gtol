# Environment setup
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple, Iterable, Set, Callable
import re
import sys
import os
import pandas as pd


def _log(*args: object) -> None:
    print(*args, file=sys.stderr)


# Configuration constants

#  NEWICK: str = "/Users/gushchin_a/Downloads/UShER SARS-CoV-2 latest.nwk"
NEWICK: str = "/Users/gushchin_a/Downloads/Chond 10Cal 10k TreeSet.tre"
params = dict[str, float](
    x_scale=140.0,
    min_level_gap=56.0,
    leaf_step=400.0,
    parent_stub=20.0,
    tip_pad=40.0,
)

# Geometry & appearance
X_SCALE_PX: float = 140.0  # px per branch-length unit
MIN_STEM_GAP_PX: float = 56.0  # min horizontal gap between adjacent vertical stems
PARENT_STUB_PX: float = 20.0  # elbow stub length before vertical
WEIGHTED_STUB_PX: float = 40.0  # minimal horizontal stub to weighted segment (set to 0 to preserve the ratio)
LEAF_Y_STEP_PX: float = 400.0  # vertical spacing between consecutive leaves
TIP_PAD_PX: float = 40.0  # extra space right of farthest leaf for markers

# Per-kind point sizes (in pixels for direct strategy)
SIZE_LEAF_MARKER: float = 20.0
SIZE_INTERNAL: float = 6.0
SIZE_BEND: float = 3.0
SIZE_LEAF_REAL: float = 8.0

# Global size scaling factor (applied before Cosmograph)
NODE_SIZE_SCALE: float = 2.0

# Colors
COLOR_LEAF: str = "#f5d76e"  # yellow
COLOR_INTERNAL: str = "#8ab4f8"  # light blue
COLOR_BEND: str = "#9aa0a6"  # gray
COLOR_LINK: str = "#97A1A9"  # gray
LINK_WIDTH_PX: float = 0.7

# Limits
MAX_NODES: int = 100_000_000_000

# Newick parsing — code

@dataclass
class TNode:
    """A tree node parsed from Newick.

    Attributes:
        id: Stable synthetic identifier.
        name: Label (for leaves typically), may be empty.
        parent: Parent node id or None for root.
        blen: Branch length from parent to this node (non-negative real expected).
        children: Child node ids in insertion order.
    """
    id: str
    name: str = ""
    parent: Optional[str] = None
    blen: float = 0.0
    children: List[str] = field(default_factory=list)

_TOKEN_RE = re.compile(r"\s*([(),;])\s*|\s*([^(),:;]+)\s*|(\s*:\s*[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)")  # help me


def _tokenize(newick: str) -> Iterable[str]:
    """Yield tokens from Newick: parens, commas, semicolon, names, and ':len'."""
    i = 0
    s = newick.strip()
    while i < len(s):
        m = _TOKEN_RE.match(s, i)
        if not m:
            if s[i].isspace():
                i += 1
                continue
            raise ValueError(f"[Newick] Unexpected token near: {s[i:i+20]!r}")
        tok = m.group(1) or m.group(2) or m.group(3)
        if tok is not None:
            yield tok.strip()
        i = m.end()


def parse_newick(newick: str, progress_callback: Optional[Callable[[float], None]] = None, limit: Optional[int] = None) -> Dict[str, TNode]:
    """Parse Newick text into a node-id -> TNode map.

    Rules:
    - Internal groups create anonymous nodes; leaves are named tokens.
    - ':len' attaches to the last emitted node or the just-closed group.
    - Multiple top-level groups are unified under synthetic 'root0'.
    
    Args:
        newick: Newick format string to parse
        progress_callback: Optional callback(progress: float) where progress is 0.0-1.0
        limit: Optional maximum number of nodes to parse. If reached, parsing stops and partial tree is returned.
    """
    nodes: Dict[str, TNode] = {}
    stack: List[Optional[str]] = []
    last: Optional[str] = None
    nid = 0

    def new_id() -> str:
        nonlocal nid
        nid += 1
        return f"n{nid}"

    current_parent: Optional[str] = None
    pending_name: Optional[str] = None
    pending_len: Optional[float] = None
    
    # Estimate progress based on position in string
    newick_len = len(newick)
    tokens_processed = 0
    last_progress_report = 0
    
    for tok in _tokenize(newick):
        if limit is not None and len(nodes) >= limit:
            _log(f"[Parse] Hit limit of {limit} nodes. Stopping.")
            break

        tokens_processed += 1
        # Report progress every ~1% or every 1000 tokens
        if progress_callback and (tokens_processed % 1000 == 0 or tokens_processed % max(1, newick_len // 100) == 0):
            # Estimate progress based on tokens (rough approximation)
            estimated_progress = min(1.0, tokens_processed / max(1, newick_len / 10))  # Rough estimate
            if estimated_progress - last_progress_report >= 0.01:  # Report at least 1% increments
                progress_callback(estimated_progress)
                last_progress_report = estimated_progress
        if tok == "(":
            u = new_id()
            nodes[u] = TNode(id=u)
            if current_parent is not None:
                nodes[current_parent].children.append(u)
                nodes[u].parent = current_parent
            stack.append(current_parent)
            current_parent = u
            last = None
        elif tok == ",":
            last = None
            pending_name = None
            pending_len = None
        elif tok == ")":
            if pending_name is not None:
                nodes[current_parent].name = pending_name
                pending_name = None
            if pending_len is not None:
                nodes[current_parent].blen = float(pending_len)
                pending_len = None
            current_parent = stack.pop()
            last = None
        elif tok == ";":
            break
        elif tok.startswith(":"):
            L = float(tok[1:].strip())
            if last is None:
                pending_len = L
            else:
                nodes[last].blen = L
        else:
            u = new_id()
            nodes[u] = TNode(id=u, name=tok, parent=current_parent)
            if current_parent is not None:
                nodes[current_parent].children.append(u)
            last = u
            pending_name = None
            pending_len = None

    roots = [k for k, v in nodes.items() if v.parent is None]
    if not roots:
        raise ValueError("[Parse] No root detected.")
    if len(roots) == 1:
        root_id = roots[0]
    else:
        root_id = "root0"
        nodes[root_id] = TNode(id=root_id, name="root", parent=None, blen=0.0, children=roots)
        for r in roots:
            nodes[r].parent = root_id

    if progress_callback:
        progress_callback(1.0)  # Report completion
    
    _log(f"[Parse] nodes={len(nodes):,} leaves={sum(1 for v in nodes.values() if not v.children):,} root={root_id}")
    return nodes


# Tree utilities — code


def _collect_leaves(nodes: Dict[str, TNode], u: str) -> List[str]:
    """Return a list of leaf node ids under `u` (inclusive if `u` is a leaf)."""
    if not nodes[u].children:
        return [u]
    acc: List[str] = []
    for c in nodes[u].children:
        acc.extend(_collect_leaves(nodes, c))
    return acc


def _find_root(nodes: Dict[str, TNode]) -> str:
    """Return the single root id (node with `parent is None`)."""
    for k, v in nodes.items():
        if v.parent is None:
            return k
    raise ValueError("No root")


def _sort_children_for_no_crossing(nodes: Dict[str, TNode]) -> None:
    """Sort children of each internal node by the minimal leaf name to reduce crossings."""
    def min_leaf_name(u: str) -> str:
        names = [nodes[x].name or x for x in _collect_leaves(nodes, u)]
        return min(names)
    for u, v in nodes.items():
        if v.children:
            v.children.sort(key=min_leaf_name)


def compute_cumdist(nodes: Dict[str, TNode], root: Optional[str] = None) -> Dict[str, float]:
    """Compute cumulative branch length distance from `root` to each node."""
    if root is None:
        root = _find_root(nodes)
    dist: Dict[str, float] = {root: 0.0}
    stack: List[str] = [root]
    while stack:
        u = stack.pop()
        for c in nodes[u].children:
            dist[c] = dist[u] + max(0.0, float(nodes[c].blen))
            stack.append(c)
    return dist


def assign_y_equal_leaf_spacing(nodes: Dict[str, TNode], leaf_step: float) -> Dict[str, float]:
    """Assign Y such that leaves are equally spaced by `leaf_step`, parents at child mean."""
    root = _find_root(nodes)
    _sort_children_for_no_crossing(nodes)
    leaves = _collect_leaves(nodes, root)
    y: Dict[str, float] = {lf: i * leaf_step for i, lf in enumerate(leaves)}

    # Postorder to compute parent means
    order: List[str] = []
    stack: List[str] = [root]
    visited: Set[str] = set[str]()
    while stack:
        u = stack.pop()
        order.append(u)
        for c in nodes[u].children:
            if c not in visited:
                stack.append(c)
        visited.add(u)
    order.reverse()

    for u in order:
        if nodes[u].children:
            y[u] = sum(y[c] for c in nodes[u].children) / len(nodes[u].children)
        elif u not in y:
            y[u] = 0.0
    return y

# Layout — code
from typing import Any, Set


def build_display_graph(
    nodes: Dict[str, TNode],
    *,
    leaf_step: float = LEAF_Y_STEP_PX,
    parent_stub: float = PARENT_STUB_PX,
    tip_pad: float = TIP_PAD_PX,
    x_scale: float = X_SCALE_PX,
    min_level_gap: float = MIN_STEM_GAP_PX,
    progress_callback: Optional[Callable[[float], None]] = None,
) -> Tuple[pd.DataFrame, pd.DataFrame]:
    """Create node/link DataFrames for Cosmograph.

    Stages: compute cumulative X (scaled), spread stems to avoid overlap, build orthogonal
    edges with bend caching, and add right-aligned leaf markers.
    
    Args:
        progress_callback: Optional callback(progress: float) where progress is 0.0-1.0
    """
    def logv(*a: object) -> None:
        _log("[Layout]", *a)
    
    def report(p: float):
        if progress_callback:
            progress_callback(p)

    report(0.0)  # Start: 0% (maps to 25% overall)
    root = _find_root(nodes)
    dist = compute_cumdist(nodes, root)
    report(0.08)  # Cumulative distances computed (~30% overall)
    y = assign_y_equal_leaf_spacing(nodes, leaf_step)
    report(0.15)  # Y coordinates assigned (~35% overall)

    # 1) scale X by branch length
    dist_px: Dict[str, float] = {u: float(dist[u]) * float(x_scale) for u in nodes}

    # 2) compute stems and spread horizontally so verticals don't overlap
    raw_stems = sorted({dist_px[u] + parent_stub for u in nodes})
    spread_stems: List[float] = []
    last: Optional[float] = None
    for sx in raw_stems:
        spread = sx if last is None else max(sx, last + float(min_level_gap))
        spread_stems.append(spread)
        last = spread

    def q(v: float) -> float:
        return float(f"{v:.6f}")

    stem_map: Dict[float, float] = {q(o): s for o, s in zip(raw_stems, spread_stems)}

    def stem_x(u: str) -> float:
        return stem_map[q(dist_px[u] + parent_stub)]

    leaves = [k for k, v in nodes.items() if not v.children]

    pts: List[Dict[str, Any]] = []
    links: List[Dict[str, Any]] = []
    node_id_actual: Dict[str, int] = {}
    next_id = 0
    point_cache: Dict[Tuple[str, float, float], int] = {}
    link_cache: Set[Tuple[int, int]] = set[Tuple[int, int]]()

    def add_point(kind: str, x: float, yv: float, *, label: str = "", color: Optional[str] = None,
                  size: Optional[float] = None, cache_bend: bool = True) -> int:
        nonlocal next_id
        xq, yq = q(x), q(yv)
        if cache_bend and kind == "bend":
            key = (kind, xq, yq)
            if key in point_cache:
                return point_cache[key]
        pid = next_id
        next_id += 1

        if size is None:
            if kind == "leaf":
                size = SIZE_LEAF_REAL
            elif kind == "leaf_marker":
                size = SIZE_LEAF_MARKER
            elif kind == "internal":
                size = SIZE_INTERNAL
            elif kind == "bend":
                size = SIZE_BEND
            else:
                size = 4.0

        if color is None:
            if kind == "leaf" or kind == "leaf_marker":
                color = COLOR_LEAF
            elif kind == "internal":
                color = COLOR_INTERNAL
            elif kind == "bend":
                color = COLOR_BEND
            else:
                color = COLOR_BEND

        pts.append({
            "id": int(pid),
            "x": xq,
            "y": yq,
            "size": size,
            "color": color,
            "label": label,
            "kind": kind,
        })
        if cache_bend and kind == "bend":
            point_cache[(kind, xq, yq)] = pid
        return pid

    def add_link(s: int, t: int, *, color: Optional[str] = None) -> None:
        key = (int(s), int(t))
        if key in link_cache:
            return
        link_cache.add(key)
        links.append({"source": int(s), "target": int(t), "color": color or COLOR_LINK})

    # 3) create real tree nodes at initial X; move children afterward
    report(0.20)  # Starting node creation (~40% overall)
    total_nodes = len(nodes)
    nodes_created = 0
    for u, v in nodes.items():
        kind = "leaf" if not v.children else "internal"
        label = v.name if v.name else (u if kind == "leaf" else "")
        ex = q(stem_x(u))  # elbow x
        node_x_display = q(ex - float(PARENT_STUB_PX))
        pid = add_point(kind, node_x_display, y[u], label=label, cache_bend=False)
        node_id_actual[u] = pid
        nodes_created += 1
        if progress_callback and nodes_created % max(1, total_nodes // 20) == 0:
            report(0.20 + 0.25 * (nodes_created / total_nodes))  # 20-45% of layout stage
    id_to_idx = {row["id"]: i for i, row in enumerate(pts)}
    report(0.45)  # Nodes created (~54% overall)

    # 4) orthogonal edges; move children to final weighted X
    EPS = 1e-6
    report(0.45)  # Starting link creation (~54% overall)
    total_links_estimate = max(1, sum(len(v.children) for v in nodes.values()))
    links_created = 0
    for u, v in nodes.items():
        ex = q(stem_x(u))
        y_parent = y[u]
        for c in v.children:
            y_child = y[c]
            true_len_px = max(0.0, float(nodes[c].blen)) * float(x_scale)
            child_pid = node_id_actual[c]
            pts[id_to_idx[child_pid]]["x"] = q(ex + float(WEIGHTED_STUB_PX) + true_len_px)

            elbow_top = add_point("bend", ex, y_parent, cache_bend=True)
            add_link(node_id_actual[u], elbow_top)
            if abs(y_parent - y_child) > EPS:
                elbow_bot = add_point("bend", ex, y_child, cache_bend=True)
                add_link(elbow_top, elbow_bot)
                add_link(elbow_bot, child_pid)
            else:
                add_link(elbow_top, child_pid)
            links_created += 1
            if progress_callback and links_created % max(1, total_links_estimate // 20) == 0:
                report(0.45 + 0.40 * (links_created / total_links_estimate))  # 45-85% of layout stage
    report(0.85)  # Links created (~82% overall)

    # 5) aligned right guideline X and leaf markers
    report(0.85)  # Starting leaf markers (~82% overall)
    max_leaf_x = max(pts[id_to_idx[node_id_actual[lf]]]["x"] for lf in leaves) if leaves else 0.0
    x_tipline = max_leaf_x + tip_pad
    total_leaves = max(1, len(leaves))
    markers_added = 0
    for lf in leaves:
        leaf_row = pts[id_to_idx[node_id_actual[lf]]]
        pid = add_point(
            "leaf_marker", x_tipline, leaf_row["y"], label=leaf_row["label"], color=COLOR_LEAF,
            size=SIZE_LEAF_MARKER, cache_bend=False,
        )
        add_link(pid, leaf_row["id"])
        markers_added += 1
        if progress_callback and markers_added % max(1, total_leaves // 20) == 0:
            report(0.85 + 0.10 * (markers_added / total_leaves))  # 85-95% of layout stage

    report(0.95)  # Leaf markers added (~89% overall)
    nodes_df = pd.DataFrame(pts)
    links_df = pd.DataFrame(links)
    report(1.0)  # Complete (~90% overall)
    logv(f"nodes_df={nodes_df.shape} links_df={links_df.shape} (markers @ x={x_tipline:.1f})")
    return nodes_df, links_df

def read_newick_input(path_or_text: str) -> str:
    """Read from local file if path exists; otherwise treat input as literal Newick."""
    if os.path.exists(path_or_text):
        with open(path_or_text, "r", encoding="utf-8", errors="ignore") as f:
            s = f.read()
        _log(f"[Input] Read file '{path_or_text}' len={len(s):,}")
        return s.strip()
    _log(f"[Input] Treating argument as literal Newick (len={len(path_or_text):,})")
    return path_or_text.strip()

# Rendering — code

def render(nodes_df: pd.DataFrame, links_df: pd.DataFrame, progress_callback: Optional[Callable[[float], None]] = None):
    """Render DataFrames with optional progress reporting.
    
    Args:
        progress_callback: Optional callback(progress: float) where progress is 0.0-1.0
    """
    def report(p: float):
        if progress_callback:
            progress_callback(p)
    
    report(0.0)
    for c in ["id", "x", "y", "size", "color", "label"]:
        assert c in nodes_df.columns, f"nodes missing {c}"
    for c in ["source", "target", "color"]:
        assert c in links_df.columns, f"links missing {c}"

    report(0.1)
    nodes_df = nodes_df.copy()
    links_df = links_df.copy()
    report(0.2)
    nodes_df["id"] = nodes_df["id"].astype(int)
    nodes_df["x"] = nodes_df["x"].astype(float)
    nodes_df["y"] = nodes_df["y"].astype(float)
    nodes_df["size"] = (nodes_df["size"].astype(float) * NODE_SIZE_SCALE)
    links_df["source"] = links_df["source"].astype(int)
    links_df["target"] = links_df["target"].astype(int)
    report(0.5)

    # Compact view scaling
    scale_factor: float = 0.3
    nodes_df_scaled = nodes_df.copy()
    nodes_df_scaled["x"] = nodes_df_scaled["x"] * scale_factor
    nodes_df_scaled["y"] = nodes_df_scaled["y"] * scale_factor
    report(0.7)

    def size_by_kind(kind: str) -> float:
        if kind == "leaf_marker":
            return 24.0
        if kind == "leaf":
            return 18.0
        if kind == "internal":
            return 10.0
        if kind == "bend":
            return 3.0
        return 8.0

    nodes_df_scaled = nodes_df_scaled.copy()
    nodes_df_scaled["pixel_size"] = nodes_df_scaled["kind"].apply(size_by_kind).astype(float)
    report(1.0)

    # w = Cosmograph(
    #     points=nodes_df_scaled,
    #     links=links_df,
    #     point_id_by="id",
    #     point_x_by="x",
    #     point_y_by="y",
    #     point_color_by="color",
    #     point_size_by="pixel_size",
    #     point_label_by="label",
    #     link_source_by="source",
    #     link_target_by="target",
    #     link_color_by="color",
    #     link_width_by=None,
    #     link_width=float(link_px) * 2,
    #     disable_simulation=True,
    #     fit_view_on_init=True,
    #     fit_view_padding=0.06,
    #     enable_drag=False,
    #     show_hovered_point_label=True,
    #     show_dynamic_labels=True,
    #     show_legends=False,
    #     scale_points_on_zoom=True,
    # )
    return (nodes_df_scaled, links_df, )

def build_graph(progress_callback: Optional[Callable[[str, float], None]] = None):
    """Build graph with optional progress reporting.
    
    Args:
        progress_callback: Optional callback function(stage: str, progress: float) -> None
            Called to report progress updates. stage is a descriptive string,
            progress is a float from 0.0 to 100.0.
    """
    def report(stage: str, progress: float):
        if progress_callback:
            progress_callback(stage, progress)
    
    report("reading", 0.0)
    newick = read_newick_input(NEWICK)
    report("reading", 5.0)
    
    parts = [p.strip() for p in newick.split(";") if p.strip()]
    if not parts:
        raise ValueError("No Newick tree found.")
    tree_s = parts[0] + ";"
    _log(f"[Run] Using first tree substring len={len(tree_s)}")

    _log("[Run] Parsing Newick...")
    nodes = parse_newick(tree_s, progress_callback=lambda p: report("parsing", 5.0 + p * 0.20), limit=MAX_NODES)
    report("parsing", 25.0)
    
    nodes_df, links_df = build_display_graph(
        nodes,
        leaf_step=params["leaf_step"],
        parent_stub=params["parent_stub"],
        tip_pad=params["tip_pad"],
        x_scale=params["x_scale"],
        min_level_gap=params["min_level_gap"],
        progress_callback=lambda p: report("layout", 25.0 + p * 0.65),
    )
    report("layout", 90.0)
    
    _log("[Run] Rendering widget...")
    result = render(nodes_df, links_df, progress_callback=lambda p: report("rendering", 90.0 + p * 0.05))
    report("rendering", 95.0)
    return result

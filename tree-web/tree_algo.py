from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple, Iterable, Set, Callable, Any
import re
import sys
import os
import pandas as pd

# --- Configuration constants ---
# Default visualization parameters.
DEFAULT_PARAMS = dict(
    x_scale=140.0,      # px per branch-length unit
    min_level_gap=56.0, # min horizontal gap between adjacent vertical stems
    leaf_step=400.0,    # vertical spacing between consecutive leaves
    parent_stub=20.0,   # elbow stub length before vertical
    tip_pad=40.0,       # extra space right of farthest leaf for markers
    weighted_stub=40.0  # minimal horizontal stub to weighted segment
)

# Geometry & appearance constants
SIZE_LEAF_MARKER: float = 20.0
SIZE_INTERNAL: float = 6.0
SIZE_BEND: float = 3.0
SIZE_LEAF_REAL: float = 8.0
NODE_SIZE_SCALE: float = 2.0 # Global size scaling

# Colors
COLOR_LEAF: str = "#f5d76e"  # yellow
COLOR_INTERNAL: str = "#8ab4f8"  # light blue
COLOR_BEND: str = "#9aa0a6"  # gray
COLOR_LINK: str = "#97A1A9"  # gray

# Limits
MAX_NODES: int = 100_000_000_000 # Safety limit

def _log(*args: object) -> None:
    print(*args, file=sys.stderr)

# --- Newick Parsing Logic ---

@dataclass
class TNode:
    """
    A tree node parsed from Newick.
    Structure used to build the graph in memory before layout calculation.
    """
    id: str
    name: str = ""
    parent: Optional[str] = None
    blen: float = 0.0
    children: List[str] = field(default_factory=list)

# Regex explanation: Captures delimiters (),; OR names OR branch lengths :0.05
_TOKEN_RE = re.compile(r"\s*([(),;])\s*|\s*([^(),:;]+)\s*|(\s*:\s*[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)")

def _tokenize(newick: str) -> Iterable[str]:
    """Yield tokens from Newick string."""
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
    """
    Parse Newick text into a dictionary of nodes (Adjacency List).
    Time Complexity: O(N) where N is characters in string.
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
    
    newick_len = len(newick)
    tokens_processed = 0
    last_progress_report = 0
    
    for tok in _tokenize(newick):
        if limit is not None and len(nodes) >= limit:
            _log(f"[Parse] Hit limit of {limit} nodes. Stopping.")
            break

        tokens_processed += 1
        # Optimization: Report progress sparingly to avoid I/O slowdown
        if progress_callback and (tokens_processed % 1000 == 0):
            estimated_progress = min(1.0, tokens_processed / max(1, newick_len / 10))
            if estimated_progress - last_progress_report >= 0.01:
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
                nodes[current_parent].name = pending_name.strip("'\"")
                pending_name = None
            if pending_len is not None:
                nodes[current_parent].blen = float(pending_len)
                pending_len = None
            
            # Save the node we just closed so we can label it if needed
            closed_node = current_parent
            current_parent = stack.pop()
            last = closed_node 
            
        elif tok == ";":
            break
        elif tok.startswith(":"):
            try:
                L = float(tok[1:].strip())
            except ValueError:
                L = 0.0
            if last is None:
                pending_len = L
            else:
                nodes[last].blen = L
        else:
            # Token is a Name (Leaf name or Internal Label)
            clean_name = tok.strip("'\"")
            
            if last is not None:
                # If we just closed a node (or defined a leaf), this token labels it
                nodes[last].name = clean_name
            else:
                # Create new leaf node
                u = new_id()
                nodes[u] = TNode(id=u, name=clean_name, parent=current_parent)
                if current_parent is not None:
                    nodes[current_parent].children.append(u)
                last = u
            
            pending_name = None
            pending_len = None

    roots = [k for k, v in nodes.items() if v.parent is None]
    if not roots:
        # Fallback for empty or broken tree
        raise ValueError("[Parse] No root detected.")
    
    # Unification: create a synthetic root if multiple roots exist
    if len(roots) == 1:
        root_id = roots[0]
    else:
        root_id = "root0"
        nodes[root_id] = TNode(id=root_id, name="root", parent=None, blen=0.0, children=roots)
        for r in roots:
            nodes[r].parent = root_id

    if progress_callback:
        progress_callback(1.0)
    
    _log(f"[Parse] nodes={len(nodes):,} root={root_id}")
    return nodes


# --- Tree Traversal & Layout Utilities ---

def _collect_leaves(nodes: Dict[str, TNode], u: str) -> List[str]:
    if not nodes[u].children:
        return [u]
    
    acc: List[str] = []
    stack = [u]
    
    while stack:
        curr = stack.pop()
        node = nodes[curr]
        if not node.children:
            acc.append(curr)
        else:
            for i in range(len(node.children) - 1, -1, -1):
                stack.append(node.children[i])
    return acc

def _find_root(nodes: Dict[str, TNode]) -> str:
    for k, v in nodes.items():
        if v.parent is None:
            return k
    raise ValueError("No root")

def _sort_children_for_no_crossing(nodes: Dict[str, TNode]) -> None:
    """Heuristic: sort children by minimal leaf name to reduce visual edge crossings."""
    def min_leaf_name(u: str) -> str:
        # Warning: This can be slow on massive trees.
        names = [nodes[x].name or x for x in _collect_leaves(nodes, u)]
        return min(names) if names else ""
    
    for u, v in nodes.items():
        if v.children:
            v.children.sort(key=min_leaf_name)

def compute_cumdist(nodes: Dict[str, TNode], root: Optional[str] = None) -> Dict[str, float]:
    """BFS to compute cumulative branch length (X coordinate base)."""
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
    """
    Layout Strategy:
    1. Leaves get equally spaced Y coordinates (0, 10, 20...).
    2. Internal nodes are placed at the mean Y of their children.
    """
    root = _find_root(nodes)
    _sort_children_for_no_crossing(nodes)
    leaves = _collect_leaves(nodes, root)
    y: Dict[str, float] = {lf: i * leaf_step for i, lf in enumerate(leaves)}

    # Post-order traversal to calculate parents from children
    order: List[str] = []
    stack: List[str] = [root]
    visited: Set[str] = set()
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


# --- Main Layout Function ---

def build_display_graph(
    nodes: Dict[str, TNode],
    *,
    leaf_step: float,
    parent_stub: float,
    tip_pad: float,
    x_scale: float,
    min_level_gap: float,
    progress_callback: Optional[Callable[[float], None]] = None,
) -> Tuple[pd.DataFrame, pd.DataFrame]:
    """
    Converts logical Tree Nodes -> Visual Points (DataFrames).
    Generates 'bends' (elbow connectors) for orthogonal layout.
    """
    def report(p: float):
        if progress_callback:
            progress_callback(p)

    report(0.0)
    root = _find_root(nodes)
    
    # 1. Calculate logical coordinates
    dist = compute_cumdist(nodes, root)
    report(0.08)
    y = assign_y_equal_leaf_spacing(nodes, leaf_step)
    report(0.15)

    # 2. X-Scaling and Stem separation
    dist_px: Dict[str, float] = {u: float(dist[u]) * float(x_scale) for u in nodes}
    
    # Avoid overlapping vertical lines by spreading them
    raw_stems = sorted({dist_px[u] + parent_stub for u in nodes})
    spread_stems: List[float] = []
    last: Optional[float] = None
    for sx in raw_stems:
        spread = sx if last is None else max(sx, last + float(min_level_gap))
        spread_stems.append(spread)
        last = spread

    # Rounding helper for consistent float strings (optional but good for compression)
    def q(v: float) -> float:
        return float(f"{v:.6f}")

    stem_map: Dict[float, float] = {q(o): s for o, s in zip(raw_stems, spread_stems)}

    def stem_x(u: str) -> float:
        # Returns the X coordinate where the vertical line for node U drops down
        return stem_map[q(dist_px[u] + parent_stub)]

    leaves = [k for k, v in nodes.items() if not v.children]

    pts: List[Dict[str, Any]] = []
    links: List[Dict[str, Any]] = []
    node_id_actual: Dict[str, int] = {}
    next_id = 0
    
    # Caching to reuse bend points if they overlap (optimization)
    point_cache: Dict[Tuple[str, float, float], int] = {}
    link_cache: Set[Tuple[int, int]] = set()

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

        # Defaults if not provided
        if size is None:
            size = SIZE_LEAF_REAL if kind == "leaf" else (SIZE_INTERNAL if kind == "internal" else SIZE_BEND)
        if color is None:
            color = COLOR_LEAF if "leaf" in kind else (COLOR_INTERNAL if kind == "internal" else COLOR_BEND)

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

    def add_link(s: int, t: int) -> None:
        key = (int(s), int(t))
        if key in link_cache:
            return
        link_cache.add(key)
        links.append({"source": int(s), "target": int(t), "color": COLOR_LINK})

    # 3. Create visual nodes
    report(0.20)
    total_nodes = len(nodes)
    nodes_created = 0
    
    for u, v in nodes.items():
        kind = "leaf" if not v.children else "internal"
        label = v.name if v.name else (u if kind == "leaf" else "")
        ex = q(stem_x(u))
        node_x_display = q(ex - float(parent_stub))
        
        pid = add_point(kind, node_x_display, y[u], label=label, cache_bend=False)
        node_id_actual[u] = pid
        
        nodes_created += 1
        if progress_callback and nodes_created % max(1, total_nodes // 20) == 0:
            report(0.20 + 0.25 * (nodes_created / total_nodes))

    id_to_idx = {row["id"]: i for i, row in enumerate(pts)}
    report(0.45)

    # 4. Create orthogonal edges (The "Manhattan" lines)
    EPS = 1e-6
    links_created = 0
    total_links_estimate = max(1, sum(len(v.children) for v in nodes.values()))
    
    for u, v in nodes.items():
        ex = q(stem_x(u))
        y_parent = y[u]
        
        for c in v.children:
            y_child = y[c]
            true_len_px = max(0.0, float(nodes[c].blen)) * float(x_scale)
            child_pid = node_id_actual[c]
            
            # Adjust child X to match the branch length
            # Note: We are modifying the point created earlier
            pts[id_to_idx[child_pid]]["x"] = q(ex + float(DEFAULT_PARAMS['weighted_stub']) + true_len_px)

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
                report(0.45 + 0.40 * (links_created / total_links_estimate))

    report(0.85)

    # 5. Add aligned leaf markers (Visual guide on the right)
    max_leaf_x = max(pts[id_to_idx[node_id_actual[lf]]]["x"] for lf in leaves) if leaves else 0.0
    x_tipline = max_leaf_x + tip_pad
    
    for lf in leaves:
        leaf_row = pts[id_to_idx[node_id_actual[lf]]]
        pid = add_point(
            "leaf_marker", x_tipline, leaf_row["y"], 
            label=leaf_row["label"], color=COLOR_LEAF,
            size=SIZE_LEAF_MARKER, cache_bend=False
        )
        add_link(pid, leaf_row["id"])

    report(0.95)
    
    nodes_df = pd.DataFrame(pts)
    links_df = pd.DataFrame(links)
    
    report(1.0)
    return nodes_df, links_df

def read_newick_input(path_or_text: str) -> str:
    """Helper: Reads file if path exists, else returns string as is."""
    if os.path.exists(path_or_text):
        with open(path_or_text, "r", encoding="utf-8", errors="ignore") as f:
            return f.read().strip()
    return path_or_text.strip()

# --- Entry Point ---

def build_graph(source: str, progress_callback: Optional[Callable[[str, float], None]] = None):
    """
    Main entry point.
    Args:
        source: File path OR raw Newick string.
        progress_callback: Function(stage_name, percent).
    """
    def report(stage: str, progress: float):
        if progress_callback:
            progress_callback(stage, progress)
    
    report("reading", 0.0)
    raw_text = read_newick_input(source)
    
    parts = [p.strip() for p in raw_text.split(";") if p.strip()]
    if not parts:
        raise ValueError("No Newick tree found.")
    tree_s = parts[0] + ";"
    
    report("parsing", 10.0)
    nodes = parse_newick(tree_s, progress_callback=lambda p: report("parsing", 10.0 + p * 0.15), limit=MAX_NODES)
    
    report("layout", 25.0)
    nodes_df, links_df = build_display_graph(
        nodes,
        leaf_step=DEFAULT_PARAMS["leaf_step"],
        parent_stub=DEFAULT_PARAMS["parent_stub"],
        tip_pad=DEFAULT_PARAMS["tip_pad"],
        x_scale=DEFAULT_PARAMS["x_scale"],
        min_level_gap=DEFAULT_PARAMS["min_level_gap"],
        progress_callback=lambda p: report("layout", 25.0 + p * 0.75),
    )
    

    
    return nodes_df, links_df
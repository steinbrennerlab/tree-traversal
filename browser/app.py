"""Phylogenetic tree browser — FastAPI backend."""

import json
import os
import re
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Query, Request
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles

# ---------------------------------------------------------------------------
# Application state (populated by load_data)
# ---------------------------------------------------------------------------
state = {
    "loaded": False,
    "has_fasta": False,
    "input_dir": None,
    "gene": None,
    "tree_data": None,
    "tree_json": None,
    "protein_seqs": None,
    "protein_seqs_ungapped": None,
    "species_to_tips": {},
    "tip_to_species": {},
    "num_seqs": 0,
    "num_species": 0,
    "nwk_name": None,
    "aa_name": None,
}

# ---------------------------------------------------------------------------
# Newick parser (pure Python, no dependencies)
# ---------------------------------------------------------------------------
_node_counter = 0


def _parse_newick(s):
    """Parse a Newick string into a nested dict tree."""
    global _node_counter
    s = s.strip().rstrip(";")
    node, _ = _parse_node(s, 0)
    return node


def _parse_node(s, pos):
    global _node_counter
    children = []
    if pos < len(s) and s[pos] == "(":
        pos += 1  # skip '('
        while True:
            child, pos = _parse_node(s, pos)
            children.append(child)
            if pos < len(s) and s[pos] == ",":
                pos += 1
            else:
                break
        if pos < len(s) and s[pos] == ")":
            pos += 1

    # Read label and branch length
    label = ""
    while pos < len(s) and s[pos] not in (",", ")", ":", ";"):
        label += s[pos]
        pos += 1

    branch_length = 0.0
    if pos < len(s) and s[pos] == ":":
        pos += 1
        bl_str = ""
        while pos < len(s) and s[pos] not in (",", ")", ";"):
            bl_str += s[pos]
            pos += 1
        try:
            branch_length = float(bl_str)
        except ValueError:
            branch_length = 0.0

    nid = _node_counter
    _node_counter += 1

    # For internal nodes, label is often bootstrap support
    support = None
    name = ""
    if children:
        try:
            support = float(label)
        except ValueError:
            name = label
    else:
        name = label

    return {
        "id": nid,
        "name": name,
        "branch_length": branch_length,
        "support": support,
        "children": children,
    }, pos


# ---------------------------------------------------------------------------
# FASTA parser
# ---------------------------------------------------------------------------
def parse_fasta(path):
    """Return dict of {header: sequence}."""
    seqs = {}
    current = None
    with open(path) as f:
        for line in f:
            line = line.rstrip("\n")
            if line.startswith(">"):
                current = line[1:].split()[0]
                seqs[current] = []
            elif current is not None:
                seqs[current].append(line)
    return {k: "".join(v) for k, v in seqs.items()}


# ---------------------------------------------------------------------------
# Species mapping from orthofinder-input
# ---------------------------------------------------------------------------
def build_species_map(tree_data, ortho_dir):
    """Build tip→species and species→[tips] from orthofinder-input FASTA headers."""
    species_to_tips = {}
    tip_to_species = {}

    # Collect all tree tip names for cross-referencing
    tree_tips = set()

    def collect_tips(node):
        if not node["children"]:
            tree_tips.add(node["name"])
        for c in node["children"]:
            collect_tips(c)

    collect_tips(tree_data)

    for fpath in sorted(ortho_dir.iterdir()):
        if not (fpath.suffix in (".fa", ".fasta")):
            continue
        fname = fpath.stem  # e.g. "new_genomes.Aameric_YS121.v1.cds"

        # Extract species name from filename
        if fname.startswith("new_genomes."):
            # e.g. new_genomes.Aameric_YS121.v1.cds → Aameric_YS121
            parts = fname.replace("new_genomes.", "").split(".")
            # Species is first part before .v1 or .hap1
            species = parts[0]
        else:
            # Reference genomes: clean mapping from filename to readable species
            REF_SPECIES = {
                "Pvul218cds": "Pvul",
                "TAIR10cds": "TAIR",
                "Vung469cds": "Vung",
                "Zmarina_668_v3.1.cds_primaryTranscriptOnly": "Zmarina",
            }
            species = REF_SPECIES.get(fname, fname)

        # Read FASTA headers from this species file
        headers = set()
        with open(fpath) as f:
            for line in f:
                if line.startswith(">"):
                    headers.add(line[1:].strip().split()[0])

        # Cross-reference with tree tips
        matching_tips = sorted(headers & tree_tips)
        if matching_tips:
            species_to_tips[species] = matching_tips
            for tip in matching_tips:
                tip_to_species[tip] = species

    return species_to_tips, tip_to_species


# ---------------------------------------------------------------------------
# Annotate tree nodes with species info
# ---------------------------------------------------------------------------
def annotate_species(node, tip_to_species):
    """Add 'species' field to tips and 'descendant_species' set to all nodes."""
    if not node["children"]:
        sp = tip_to_species.get(node["name"], "unknown")
        node["species"] = sp
        return {sp}
    else:
        desc_species = set()
        for child in node["children"]:
            desc_species |= annotate_species(child, tip_to_species)
        node["descendant_species"] = sorted(desc_species)
        return desc_species


# ---------------------------------------------------------------------------
# Find nodes containing at least one tip from each selected species
# ---------------------------------------------------------------------------
def find_nodes_with_species(node, required_species, excluded_species=None):
    """Return list of node IDs whose descendants include ≥1 tip from ALL required species
    and NO tips from any excluded species."""
    excluded_species = excluded_species or set()
    result = []

    def get_desc_species(n):
        if not n["children"]:
            return {n.get("species", "unknown")}
        return set(n.get("descendant_species", []))

    def walk(n):
        ds = get_desc_species(n)
        if required_species.issubset(ds) and not ds.intersection(excluded_species):
            result.append(n["id"])
        for c in n.get("children", []):
            walk(c)

    walk(node)
    return result


# ---------------------------------------------------------------------------
# PROSITE pattern → regex conversion
# ---------------------------------------------------------------------------
def prosite_to_regex(pattern):
    """Convert PROSITE-style pattern to Python regex.

    Rules: x = any AA, [ABC] = one of, {ABC} = not one of,
    - separates elements, (n) = repeat n times, (n,m) = repeat n-m times,
    < = N-terminal, > = C-terminal.
    """
    pattern = pattern.strip(".").strip()
    parts = pattern.split("-")
    regex_parts = []
    for part in parts:
        if part == "x" or part == "X":
            regex_parts.append(".")
        elif part.startswith("{") and part.endswith("}"):
            regex_parts.append(f"[^{part[1:-1]}]")
        elif part.startswith("[") and part.endswith("]"):
            regex_parts.append(part)
        elif part == "<":
            regex_parts.append("^")
        elif part == ">":
            regex_parts.append("$")
        else:
            # Check for repeat notation like x(2) or x(2,4)
            m = re.match(r"^(.+)\((\d+)(?:,(\d+))?\)$", part)
            if m:
                base = m.group(1)
                # Recurse for the base
                base_regex = prosite_to_regex(base)
                if m.group(3):
                    regex_parts.append(f"(?:{base_regex}){{{m.group(2)},{m.group(3)}}}")
                else:
                    regex_parts.append(f"(?:{base_regex}){{{m.group(2)}}}")
            else:
                # Literal amino acid(s)
                regex_parts.append(re.escape(part))
    return "".join(regex_parts)


# ---------------------------------------------------------------------------
# Serialise tree to JSON-friendly format
# ---------------------------------------------------------------------------
def tree_to_json(node):
    """Convert tree node to JSON-serializable dict (keep it slim)."""
    result = {
        "id": node["id"],
        "bl": node["branch_length"],
    }
    if node.get("name"):
        result["name"] = node["name"]
    if node.get("support") is not None:
        result["sup"] = node["support"]
    if node.get("species"):
        result["sp"] = node["species"]
    if node["children"]:
        result["ch"] = [tree_to_json(c) for c in node["children"]]
    return result


# ---------------------------------------------------------------------------
# Load data from an input directory
# ---------------------------------------------------------------------------
def load_data(input_dir_str, nwk_file=None, aa_file=None):
    """Load tree + alignment + species from input_dir.

    If nwk_file/aa_file are given (filenames relative to input_dir), use them
    directly.  Otherwise auto-detect by glob pattern.

    Returns (success: bool, error_message: str | None).
    """
    global _node_counter

    # Resolve relative paths against the project root (parent of browser/)
    PROJECT_ROOT = Path(__file__).resolve().parent.parent
    input_path = Path(input_dir_str)
    if not input_path.is_absolute():
        input_path = PROJECT_ROOT / input_path
    input_dir = input_path.resolve()
    if not input_dir.is_dir():
        return False, f"Directory not found: {input_dir}"

    # --- Resolve tree file ---
    if nwk_file:
        nwk_path = input_dir / nwk_file
        if not nwk_path.is_file():
            return False, f"Tree file not found: {nwk_path}"
    else:
        nwk_files = list(input_dir.glob("*.nwk"))
        if len(nwk_files) == 0:
            return False, f"No .nwk file found in {input_dir}"
        if len(nwk_files) > 1:
            return False, f"Multiple .nwk files found in {input_dir}: {[f.name for f in nwk_files]}"
        nwk_path = nwk_files[0]

    # --- Resolve alignment file ---
    if aa_file is not None:
        # Explicit: empty string means skip alignment
        aa_path = (input_dir / aa_file) if aa_file else None
        if aa_path and not aa_path.is_file():
            return False, f"Alignment file not found: {aa_path}"
    else:
        aa_files = list(input_dir.glob("*.aa.fa"))
        if len(aa_files) > 1:
            return False, f"Multiple *.aa.fa files found in {input_dir}: {[f.name for f in aa_files]}"
        aa_path = aa_files[0] if aa_files else None

    nwk_file = nwk_path  # rename for rest of function
    aa_file = aa_path

    # Derive gene name from .nwk filename (strip extension)
    gene = nwk_file.stem

    # Reset parser state
    _node_counter = 0

    # Parse tree
    print(f"Loading tree from {nwk_file.name}...")
    with open(nwk_file) as f:
        nwk_string = f.read().strip()
    tree_data = _parse_newick(nwk_string)

    # Parse alignment (if present)
    if aa_file:
        print(f"Loading protein sequences from {aa_file.name}...")
        protein_seqs = parse_fasta(str(aa_file))
        protein_seqs_ungapped = {k: v.replace("-", "") for k, v in protein_seqs.items()}
    else:
        print("No *.aa.fa found, skipping alignment.")
        protein_seqs, protein_seqs_ungapped = None, None

    # Species mapping (optional — skip if orthofinder-input/ missing)
    ortho_dir = input_dir / "orthofinder-input"
    if ortho_dir.is_dir():
        print("Building species map...")
        species_to_tips, tip_to_species = build_species_map(tree_data, ortho_dir)
        print("Annotating tree with species...")
        annotate_species(tree_data, tip_to_species)
    else:
        print("No orthofinder-input/ found, skipping species mapping.")
        species_to_tips, tip_to_species = {}, {}

    tree_json = tree_to_json(tree_data)

    # Update global state
    has_fasta = protein_seqs is not None
    state.update({
        "loaded": True,
        "has_fasta": has_fasta,
        "input_dir": str(input_dir),
        "gene": gene,
        "tree_data": tree_data,
        "tree_json": tree_json,
        "protein_seqs": protein_seqs,
        "protein_seqs_ungapped": protein_seqs_ungapped,
        "species_to_tips": species_to_tips,
        "tip_to_species": tip_to_species,
        "num_seqs": len(protein_seqs) if has_fasta else 0,
        "num_species": len(species_to_tips),
        "nwk_name": nwk_file.name,
        "aa_name": aa_file.name if aa_file else None,
    })

    print(f"Loaded: {state['num_seqs']} sequences, {state['num_species']} species")
    return True, None


# ---------------------------------------------------------------------------
# Tree traversal helpers
# ---------------------------------------------------------------------------
def find_node_by_id(node, target_id):
    """Find a node in the tree by its ID."""
    if node["id"] == target_id:
        return node
    for c in node.get("children", []):
        result = find_node_by_id(c, target_id)
        if result:
            return result
    return None


def reroot_tree(tree_data, target_id):
    """Re-root the tree at the node with the given ID.

    Returns the new root node, or None if target_id not found.
    """
    global _node_counter

    if tree_data["id"] == target_id:
        return tree_data  # already the root — no-op

    # Build parent map and find path from root to target
    parent_map = {}  # child_id → parent_node

    def build_parent_map(node):
        for c in node["children"]:
            parent_map[c["id"]] = node
            build_parent_map(c)

    build_parent_map(tree_data)

    # Find target node
    target = find_node_by_id(tree_data, target_id)
    if target is None:
        return None

    # Build path from target back to root
    path = [target]
    cur = target
    while cur["id"] in parent_map:
        cur = parent_map[cur["id"]]
        path.append(cur)
    # path is [target, ..., root]

    # Save original branch lengths before modifying
    orig_bls = [node["branch_length"] for node in path]

    # Reverse parent-child relationships along the path
    for i in range(len(path) - 1):
        child = path[i]
        parent = path[i + 1]
        # Remove child from parent's children
        parent["children"] = [c for c in parent["children"] if c["id"] != child["id"]]
        # Add parent as child of child
        child["children"].append(parent)

    # Fix branch lengths: original edge path[i+1]→path[i] had length orig_bls[i]
    # In the reversed tree, path[i]→path[i+1] keeps that same length
    for i in range(len(path) - 1):
        path[i + 1]["branch_length"] = orig_bls[i]
    target["branch_length"] = 0.0

    # Collapse degree-2 old root if needed (now at end of path)
    old_root = path[-1]
    if len(old_root["children"]) == 1:
        only_child = old_root["children"][0]
        only_child["branch_length"] += old_root["branch_length"]
        # If old_root had support, transfer to child if child has none
        if old_root.get("support") is not None and only_child.get("support") is None:
            only_child["support"] = old_root["support"]
        # Replace old_root with only_child in its parent
        # The parent of old_root in the new tree is path[-2]
        if len(path) >= 2:
            new_parent = path[-2]
            new_parent["children"] = [
                only_child if c["id"] == old_root["id"] else c
                for c in new_parent["children"]
            ]

    # Re-assign IDs to the whole tree
    _node_counter = 0

    def reassign_ids(node):
        global _node_counter
        node["id"] = _node_counter
        _node_counter += 1
        for c in node["children"]:
            reassign_ids(c)

    reassign_ids(target)

    return target


def collect_descendant_tips(node):
    """Collect all descendant tip names from a node."""
    if not node["children"]:
        return [node["name"]]
    tips = []
    for c in node["children"]:
        tips.extend(collect_descendant_tips(c))
    return tips


def node_to_newick(node):
    """Convert a tree node dict back to a Newick string."""
    children = node.get("children", [])
    if children:
        child_strs = ",".join(node_to_newick(c) for c in children)
        s = f"({child_strs})"
        if node.get("support") is not None:
            s += str(node["support"])
        elif node.get("name"):
            s += node["name"]
    else:
        s = node.get("name", "")
    bl = node.get("branch_length")
    if bl is not None and bl != 0:
        s += f":{bl}"
    return s


def ref_pos_to_columns(ref_seq_gapped, ref_start, ref_end):
    """Map 1-indexed reference residue positions to alignment column indices."""
    col_start = None
    col_end = None
    residue_pos = 0
    for col_idx, char in enumerate(ref_seq_gapped):
        if char != "-":
            residue_pos += 1
            if residue_pos == ref_start and col_start is None:
                col_start = col_idx
            if residue_pos == ref_end:
                col_end = col_idx + 1
                break
    return col_start, col_end


# ---------------------------------------------------------------------------
# Helper: require data loaded
# ---------------------------------------------------------------------------
def require_loaded():
    """Return a JSONResponse error if data not loaded, else None."""
    if not state["loaded"]:
        return JSONResponse(
            status_code=400,
            content={"error": "No data loaded. Use the setup dialog to load an input folder."},
        )
    return None


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------
app = FastAPI(title="PhyloScope")

STATIC_DIR = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
async def index():
    return FileResponse(str(STATIC_DIR / "index.html"))


@app.get("/api/browse")
async def api_browse(path: Optional[str] = Query(None)):
    """List subdirectories and check for valid input files."""
    PROJECT_ROOT = Path(__file__).resolve().parent.parent
    if path:
        browse_path = Path(path).resolve()
    else:
        browse_path = PROJECT_ROOT

    if not browse_path.is_dir():
        return JSONResponse(status_code=400, content={"error": f"Not a directory: {browse_path}"})

    try:
        dirs = sorted(
            entry.name for entry in browse_path.iterdir()
            if entry.is_dir() and not entry.name.startswith(".")
        )
    except PermissionError:
        return JSONResponse(status_code=403, content={"error": f"Permission denied: {browse_path}"})

    has_nwk = any(browse_path.glob("*.nwk"))
    has_aa_fa = any(browse_path.glob("*.aa.fa"))

    parent = str(browse_path.parent) if browse_path.parent != browse_path else None

    return {
        "current": str(browse_path),
        "parent": parent,
        "dirs": dirs,
        "has_nwk": has_nwk,
        "has_aa_fa": has_aa_fa,
    }


@app.get("/api/status")
async def api_status():
    if state["loaded"]:
        return {
            "loaded": True,
            "has_fasta": state["has_fasta"],
            "gene": state["gene"],
            "input_dir": state["input_dir"],
            "num_seqs": state["num_seqs"],
            "num_species": state["num_species"],
            "nwk_name": state["nwk_name"],
            "aa_name": state["aa_name"],
        }
    return {"loaded": False}


@app.get("/api/browse-files")
async def api_browse_files(path: str = Query(..., description="Directory to scan")):
    """Scan a directory and return detected input files."""
    PROJECT_ROOT = Path(__file__).resolve().parent.parent
    p = Path(path)
    if not p.is_absolute():
        p = PROJECT_ROOT / p
    p = p.resolve()
    if not p.is_dir():
        return JSONResponse(status_code=400, content={"error": f"Not a directory: {p}"})

    nwk_files = sorted(f.name for f in p.glob("*.nwk"))
    aa_files = sorted(f.name for f in p.glob("*.aa.fa"))
    has_ortho = (p / "orthofinder-input").is_dir()

    return {"nwk_files": nwk_files, "aa_files": aa_files, "has_ortho": has_ortho}


@app.post("/api/load")
async def api_load(request: Request):
    body = await request.json()
    input_dir = body.get("input_dir", "").strip()
    if not input_dir:
        return JSONResponse(status_code=400, content={"error": "input_dir is required"})

    nwk_file = body.get("nwk_file")  # filename or None
    aa_file = body.get("aa_file")    # filename, "" to skip, or None

    success, error = load_data(input_dir, nwk_file=nwk_file, aa_file=aa_file)
    if not success:
        return JSONResponse(status_code=400, content={"error": error})

    return {
        "loaded": True,
        "has_fasta": state["has_fasta"],
        "gene": state["gene"],
        "input_dir": state["input_dir"],
        "num_seqs": state["num_seqs"],
        "num_species": state["num_species"],
    }


@app.post("/api/reset")
async def api_reset():
    """Reset state so user can load a new dataset."""
    state.update({
        "loaded": False,
        "has_fasta": False,
        "input_dir": None,
        "gene": None,
        "tree_data": None,
        "tree_json": None,
        "protein_seqs": None,
        "protein_seqs_ungapped": None,
        "species_to_tips": {},
        "tip_to_species": {},
        "num_seqs": 0,
        "num_species": 0,
        "nwk_name": None,
        "aa_name": None,
    })
    return {"ok": True}


@app.post("/api/reroot")
async def api_reroot(request: Request):
    """Re-root the tree at the specified node."""
    err = require_loaded()
    if err:
        return err
    body = await request.json()
    node_id = body.get("node_id")
    if node_id is None:
        return JSONResponse(status_code=400, content={"error": "node_id is required"})

    new_root = reroot_tree(state["tree_data"], int(node_id))
    if new_root is None:
        return JSONResponse(status_code=404, content={"error": "Node not found"})

    # Re-annotate species if mapping exists
    if state["tip_to_species"]:
        annotate_species(new_root, state["tip_to_species"])

    state["tree_data"] = new_root
    state["tree_json"] = tree_to_json(new_root)

    return {"tree": state["tree_json"]}


@app.get("/api/tree")
async def get_tree():
    err = require_loaded()
    if err:
        return err
    return state["tree_json"]


@app.get("/api/species")
async def get_species():
    err = require_loaded()
    if err:
        return err
    return {
        "species": sorted(state["species_to_tips"].keys()),
        "species_to_tips": state["species_to_tips"],
    }


@app.get("/api/motif")
async def search_motif(
    pattern: str = Query(..., description="Regex or PROSITE pattern"),
    type: str = Query("regex", description="'regex' or 'prosite'"),
):
    err = require_loaded()
    if err:
        return err

    if not state["has_fasta"]:
        return {"matched_tips": [], "error": "No alignment loaded"}

    if type == "prosite":
        try:
            regex_str = prosite_to_regex(pattern)
        except Exception as e:
            return {"error": f"Invalid PROSITE pattern: {e}", "matched_tips": []}
    else:
        regex_str = pattern

    try:
        compiled = re.compile(regex_str, re.IGNORECASE)
    except re.error as e:
        return {"error": f"Invalid regex: {e}", "matched_tips": []}

    matched = [
        tip
        for tip, seq in state["protein_seqs_ungapped"].items()
        if compiled.search(seq)
    ]
    return {"matched_tips": sorted(matched), "pattern_used": regex_str}


@app.get("/api/nodes-by-species")
async def nodes_by_species(
    species: list[str] = Query(..., description="Species to require"),
    exclude: list[str] = Query([], description="Species to exclude"),
):
    err = require_loaded()
    if err:
        return err
    required = set(species)
    excluded = set(exclude)
    node_ids = find_nodes_with_species(state["tree_data"], required, excluded)
    return {"highlighted_nodes": node_ids}


@app.get("/api/node-tips")
async def node_tips(node_id: int = Query(..., description="Node ID")):
    err = require_loaded()
    if err:
        return err
    node = find_node_by_id(state["tree_data"], node_id)
    if not node:
        return {"error": "Node not found", "tips": []}
    tips = collect_descendant_tips(node)
    return {"tips": tips}


@app.get("/api/export-newick")
async def export_newick(node_id: int = Query(..., description="Node ID")):
    """Return the subtree rooted at node_id as a Newick string."""
    err = require_loaded()
    if err:
        return err
    node = find_node_by_id(state["tree_data"], node_id)
    if not node:
        return JSONResponse(status_code=404, content={"error": "Node not found"})
    nwk = node_to_newick(node) + ";"
    return PlainTextResponse(content=nwk, media_type="text/plain")


@app.get("/api/pairwise")
async def api_pairwise(
    tip1: str = Query(..., description="First tip name"),
    tip2: str = Query(..., description="Second tip name"),
):
    """Compute pairwise sequence identity between two tips."""
    err = require_loaded()
    if err:
        return err
    if not state["has_fasta"]:
        return JSONResponse(status_code=400, content={"error": "No alignment loaded"})

    seqs = state["protein_seqs"]
    if tip1 not in seqs:
        return {"error": f"Tip '{tip1}' not found in alignment"}
    if tip2 not in seqs:
        return {"error": f"Tip '{tip2}' not found in alignment"}

    seq1 = seqs[tip1]
    seq2 = seqs[tip2]
    if len(seq1) != len(seq2):
        return {"error": "Sequences have different lengths in alignment"}

    identical = 0
    aligned = 0
    for a, b in zip(seq1, seq2):
        if a == "-" or b == "-":
            continue
        aligned += 1
        if a == b:
            identical += 1

    identity = identical / aligned if aligned > 0 else 0.0
    return {
        "identity": identity,
        "identical_positions": identical,
        "aligned_length": aligned,
    }


@app.get("/api/tip-lengths")
async def tip_lengths():
    """Return ungapped sequence lengths for all tips."""
    err = require_loaded()
    if err:
        return err
    if not state["has_fasta"]:
        return {}
    return {k: len(v) for k, v in state["protein_seqs_ungapped"].items()}


@app.get("/api/tip-seq")
async def tip_seq(name: str = Query(..., description="Tip name")):
    """Return the ungapped sequence for a single tip."""
    err = require_loaded()
    if err:
        return err
    if not state["has_fasta"]:
        return JSONResponse(status_code=404, content={"error": "No alignment loaded"})
    seq = state["protein_seqs_ungapped"].get(name)
    if seq is None:
        return JSONResponse(status_code=404, content={"error": f"Tip '{name}' not found"})
    return {"name": name, "seq": seq}


@app.get("/api/tip-names")
async def tip_names():
    """Return all tip names for autocomplete."""
    err = require_loaded()
    if err:
        return err
    if not state["has_fasta"]:
        return {"tips": []}
    return {"tips": sorted(state["protein_seqs"].keys())}


@app.get("/api/export")
async def export_alignment(
    node_id: int = Query(..., description="Node ID"),
    extra_tips: list[str] = Query([], description="Additional tip names"),
    col_start: Optional[int] = Query(None, description="Start alignment column (1-indexed)"),
    col_end: Optional[int] = Query(None, description="End alignment column (1-indexed)"),
    ref_seq: Optional[str] = Query(None, description="Reference sequence name"),
    ref_start: Optional[int] = Query(None, description="Start residue position in reference"),
    ref_end: Optional[int] = Query(None, description="End residue position in reference"),
):
    err = require_loaded()
    if err:
        return err
    if not state["has_fasta"]:
        return Response("No alignment loaded", status_code=400)

    node = find_node_by_id(state["tree_data"], node_id)
    if not node:
        return Response("Node not found", status_code=404)

    tips = collect_descendant_tips(node)
    tip_set = set(tips)
    all_tips = list(tips)
    for t in extra_tips:
        if t not in tip_set:
            all_tips.append(t)
            tip_set.add(t)

    # Determine column slice
    slice_start = None
    slice_end = None

    protein_seqs = state["protein_seqs"]

    if ref_seq and ref_start is not None and ref_end is not None:
        if ref_seq not in protein_seqs:
            return Response(f"Reference sequence '{ref_seq}' not found", status_code=400)
        slice_start, slice_end = ref_pos_to_columns(protein_seqs[ref_seq], ref_start, ref_end)
        if slice_start is None or slice_end is None:
            return Response("Reference positions out of range", status_code=400)
    elif col_start is not None and col_end is not None:
        slice_start = col_start - 1
        slice_end = col_end

    # Build FASTA
    lines = []
    for tip in all_tips:
        if tip not in protein_seqs:
            continue
        seq = protein_seqs[tip]
        if slice_start is not None and slice_end is not None:
            seq = seq[slice_start:slice_end]
        lines.append(f">{tip}")
        for i in range(0, len(seq), 80):
            lines.append(seq[i:i + 80])

    fasta_content = "\n".join(lines) + "\n"
    return Response(
        content=fasta_content,
        media_type="text/plain",
        headers={"Content-Disposition": f"attachment; filename=export_node{node_id}.fasta"},
    )


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

"""Phylogenetic tree browser — FastAPI backend."""

import json
import os
import re
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Query, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

# ---------------------------------------------------------------------------
# Application state (populated by load_data)
# ---------------------------------------------------------------------------
state = {
    "loaded": False,
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
def load_data(input_dir_str):
    """Auto-detect files in input_dir, parse tree + alignment + species.

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

    # Auto-detect .nwk file
    nwk_files = list(input_dir.glob("*.nwk"))
    if len(nwk_files) == 0:
        return False, f"No .nwk file found in {input_dir}"
    if len(nwk_files) > 1:
        return False, f"Multiple .nwk files found in {input_dir}: {[f.name for f in nwk_files]}"
    nwk_file = nwk_files[0]

    # Auto-detect *.aa.fa file
    aa_files = list(input_dir.glob("*.aa.fa"))
    if len(aa_files) == 0:
        return False, f"No *.aa.fa file found in {input_dir}"
    if len(aa_files) > 1:
        return False, f"Multiple *.aa.fa files found in {input_dir}: {[f.name for f in aa_files]}"
    aa_file = aa_files[0]

    # Derive gene name from .nwk filename (strip extension)
    gene = nwk_file.stem

    # Reset parser state
    _node_counter = 0

    # Parse tree
    print(f"Loading tree from {nwk_file.name}...")
    with open(nwk_file) as f:
        nwk_string = f.read().strip()
    tree_data = _parse_newick(nwk_string)

    # Parse alignment
    print(f"Loading protein sequences from {aa_file.name}...")
    protein_seqs = parse_fasta(str(aa_file))
    protein_seqs_ungapped = {k: v.replace("-", "") for k, v in protein_seqs.items()}

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
    state.update({
        "loaded": True,
        "input_dir": str(input_dir),
        "gene": gene,
        "tree_data": tree_data,
        "tree_json": tree_json,
        "protein_seqs": protein_seqs,
        "protein_seqs_ungapped": protein_seqs_ungapped,
        "species_to_tips": species_to_tips,
        "tip_to_species": tip_to_species,
        "num_seqs": len(protein_seqs),
        "num_species": len(species_to_tips),
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


def collect_descendant_tips(node):
    """Collect all descendant tip names from a node."""
    if not node["children"]:
        return [node["name"]]
    tips = []
    for c in node["children"]:
        tips.extend(collect_descendant_tips(c))
    return tips


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
            "gene": state["gene"],
            "input_dir": state["input_dir"],
            "num_seqs": state["num_seqs"],
            "num_species": state["num_species"],
        }
    return {"loaded": False}


@app.post("/api/load")
async def api_load(request: Request):
    body = await request.json()
    input_dir = body.get("input_dir", "").strip()
    if not input_dir:
        return JSONResponse(status_code=400, content={"error": "input_dir is required"})

    success, error = load_data(input_dir)
    if not success:
        return JSONResponse(status_code=400, content={"error": error})

    return {
        "loaded": True,
        "gene": state["gene"],
        "input_dir": state["input_dir"],
        "num_seqs": state["num_seqs"],
        "num_species": state["num_species"],
    }


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


@app.get("/api/tip-lengths")
async def tip_lengths():
    """Return ungapped sequence lengths for all tips."""
    err = require_loaded()
    if err:
        return err
    return {k: len(v) for k, v in state["protein_seqs_ungapped"].items()}


@app.get("/api/tip-seq")
async def tip_seq(name: str = Query(..., description="Tip name")):
    """Return the ungapped sequence for a single tip."""
    err = require_loaded()
    if err:
        return err
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

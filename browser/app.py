"""Phylogenetic tree browser — FastAPI backend."""

import json
import os
import re
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Query
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
INPUT_DIR = Path(__file__).resolve().parent.parent / "input"
NWK_FILE = INPUT_DIR / "Phvul.007G077500.1.nwk"
AA_FILE = INPUT_DIR / "Phvul.007G077500.1.csv.aa.fa"
ORTHO_DIR = INPUT_DIR / "orthofinder-input"

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
def build_species_map():
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

    for fpath in sorted(ORTHO_DIR.iterdir()):
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
# Startup: load data
# ---------------------------------------------------------------------------
print("Loading tree...")
with open(NWK_FILE) as f:
    nwk_string = f.read().strip()
tree_data = _parse_newick(nwk_string)

print("Loading protein sequences...")
protein_seqs = parse_fasta(str(AA_FILE))
# Store ungapped versions for motif search
protein_seqs_ungapped = {k: v.replace("-", "") for k, v in protein_seqs.items()}

print("Building species map...")
species_to_tips, tip_to_species = build_species_map()

print("Annotating tree with species...")
annotate_species(tree_data, tip_to_species)

print(f"Loaded: {len(protein_seqs)} sequences, {len(species_to_tips)} species")

# ---------------------------------------------------------------------------
# Serialise tree to JSON-friendly format (strip descendant_species sets from output)
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


tree_json = tree_to_json(tree_data)

# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------
app = FastAPI(title="Tree Browser")

STATIC_DIR = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
async def index():
    return FileResponse(str(STATIC_DIR / "index.html"))


@app.get("/api/tree")
async def get_tree():
    return tree_json


@app.get("/api/species")
async def get_species():
    return {
        "species": sorted(species_to_tips.keys()),
        "species_to_tips": species_to_tips,
    }


@app.get("/api/motif")
async def search_motif(
    pattern: str = Query(..., description="Regex or PROSITE pattern"),
    type: str = Query("regex", description="'regex' or 'prosite'"),
):
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
        for tip, seq in protein_seqs_ungapped.items()
        if compiled.search(seq)
    ]
    return {"matched_tips": sorted(matched), "pattern_used": regex_str}


@app.get("/api/nodes-by-species")
async def nodes_by_species(
    species: list[str] = Query(..., description="Species to require"),
    exclude: list[str] = Query([], description="Species to exclude"),
):
    required = set(species)
    excluded = set(exclude)
    node_ids = find_nodes_with_species(tree_data, required, excluded)
    return {"highlighted_nodes": node_ids}


# ---------------------------------------------------------------------------
# Tree traversal helpers for export
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
    """Map 1-indexed reference residue positions to alignment column indices.

    Returns (col_start, col_end) as 0-indexed Python slice bounds.
    """
    col_start = None
    col_end = None
    residue_pos = 0
    for col_idx, char in enumerate(ref_seq_gapped):
        if char != "-":
            residue_pos += 1
            if residue_pos == ref_start and col_start is None:
                col_start = col_idx
            if residue_pos == ref_end:
                col_end = col_idx + 1  # exclusive end for slicing
                break
    return col_start, col_end


@app.get("/api/node-tips")
async def node_tips(node_id: int = Query(..., description="Node ID")):
    node = find_node_by_id(tree_data, node_id)
    if not node:
        return {"error": "Node not found", "tips": []}
    tips = collect_descendant_tips(node)
    return {"tips": tips}


@app.get("/api/tip-names")
async def tip_names():
    """Return all tip names for autocomplete."""
    return {"tips": sorted(protein_seqs.keys())}


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
    node = find_node_by_id(tree_data, node_id)
    if not node:
        return Response("Node not found", status_code=404)

    tips = collect_descendant_tips(node)
    # Keep tree traversal order; append extra tips at the end
    tip_set = set(tips)
    all_tips = list(tips)
    for t in extra_tips:
        if t not in tip_set:
            all_tips.append(t)
            tip_set.add(t)

    # Determine column slice
    slice_start = None
    slice_end = None

    if ref_seq and ref_start is not None and ref_end is not None:
        if ref_seq not in protein_seqs:
            return Response(f"Reference sequence '{ref_seq}' not found", status_code=400)
        slice_start, slice_end = ref_pos_to_columns(protein_seqs[ref_seq], ref_start, ref_end)
        if slice_start is None or slice_end is None:
            return Response("Reference positions out of range", status_code=400)
    elif col_start is not None and col_end is not None:
        slice_start = col_start - 1  # convert 1-indexed to 0-indexed
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
        # Wrap at 80 chars
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

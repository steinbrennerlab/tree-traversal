<p align="left">
  <img src="logo.png" alt="PhyloScope" width="200">
</p>

# PhyloScope

A lightweight, local-first phylogenetic tree viewer with built-in sequence tools. Built with FastAPI (Python) and vanilla JS/SVG.

![PhyloScope screenshot](screenshot.png)

## How it compares

| Feature | PhyloScope | iTOL | FigTree | ETE Toolkit | Dendroscope |
|---|---|---|---|---|---|
| Hosting | Local, self-hosted | Cloud (freemium) | Desktop (Java) | Python library | Desktop (Java) |
| Species coloring | Built-in from FASTA inputs | Manual annotation files | Manual | Programmatic | Manual node/edge formatting |
| Motif search | Regex + PROSITE, multi-motif with per-motif colors | No | No | Programmatic | No |
| Shared node finding | Built-in species filter with exclusion | No | No | Scriptable | No |
| Alignment export | Click-to-copy FASTA, subtree slicing, column ranges | No | No | Scriptable | No |
| Click-to-copy | Tip FASTA + node aligned FASTA to clipboard | No | No | No | No |
| Annotation | Species, bootstrap, motif highlights, sequence lengths, clade labels | Very rich (heatmaps, domains, bars) | Moderate | Very rich | Basic (colors, fonts, line widths) |
| Large trees (10k+) | Fast mode: batched SVG, auto-collapse, render cache | Optimized for large trees | Moderate | Good | Optimized (magnifier tool) |
| Undo/redo | Full undo/redo for tree operations | No | Limited | No | No |
| Session persistence | Save/load all UI state to JSON | Server-side projects | Save to NEXUS | Scriptable | Save to file |
| Tip filtering | Regex and species-based hide/show | Dataset filtering | Taxon filtering | Programmatic | Find/filter |
| Pairwise comparison | Patristic distance + sequence identity | No | No | Programmatic | No |
| PDF export | Vector PDF via jsPDF/svg2pdf | PNG/SVG/PDF | PDF/SVG/PNG | PNG/SVG/PDF | PDF/SVG/PNG |

## Installation

The app requires Python 3.10+ with **fastapi** and **uvicorn**.

### Option A: micromamba / conda (recommended)

```bash
# Install micromamba if you don't have it:
# Linux/WSL
curl -Ls https://micro.mamba.pm/api/micromamba/linux-64/latest | tar -xvj -C ~/.local/bin --strip-components=1 bin/micromamba
# macOS (Intel)
curl -Ls https://micro.mamba.pm/api/micromamba/osx-64/latest | tar -xvj -C ~/.local/bin --strip-components=1 bin/micromamba
# macOS (Apple Silicon)
curl -Ls https://micro.mamba.pm/api/micromamba/osx-arm64/latest | tar -xvj -C ~/.local/bin --strip-components=1 bin/micromamba

# Create the environment
micromamba create -f environment.yml -y
micromamba activate tree-browser
```

### Option B: pip

```bash
pip install fastapi uvicorn
```

### Option C: System packages

**Debian/Ubuntu/WSL:**
```bash
sudo apt install python3 python3-pip
pip install fastapi uvicorn
```

**macOS (Homebrew):**
```bash
brew install python
pip3 install fastapi uvicorn
```

**Windows (native):**
```powershell
# Install Python from https://www.python.org/downloads/ then:
pip install fastapi uvicorn
```

## Quick Start

```bash
cd browser
./run.sh
# or manually:
micromamba run -n tree-browser python3 app.py
# or without micromamba:
python3 app.py
```

Then open http://localhost:8000.

## Getting Started

On launch, a setup dialog prompts for an input folder path. You can type a path directly or click **Browse** to navigate the filesystem visually. The browser shows a green checkmark when the current directory contains valid input files, and the **Select** button fills the path for you.

You can also click **Load saved session** to restore a previously saved session file, which automatically loads the original data folder and restores all UI state.

## Input Folder Structure

Point PhyloScope at any folder containing:

| File | Description |
|------|-------------|
| `*.nwk` | Newick tree (exactly one) |
| `*.aa.fa` | Gapped protein alignment (exactly one, optional) |
| `orthofinder-input/*.fa` | Per-species FASTA files for tip-to-species mapping (optional) |

An example dataset is provided in `example_data/`.

## Features

### Loaded Data Panel
- Shows currently loaded tree file (with tip count), alignment file, species count, and input folder at the top of the sidebar
- **Load different data** button resets all state and re-opens the setup dialog

### Tree Display
- **Three layouts**: rectangular, circular (polar), unrooted (Felsenstein equal-angle)
- **Branch lengths**: toggle phylogram vs cladogram
- **Tip labels**: toggle on/off (auto-hidden for trees >1000 tips); tips always show a small colored dot
- **Sequence lengths**: toggle to show ungapped amino acid length next to each tip label
- **Bootstrap values**: toggle display on internal nodes
- **Tip spacing**: adjustable via slider
- **Collapse/expand**: Shift+click an internal node to collapse its subtree into a triangle
- **Uniform triangles**: toggle to make all collapsed triangles the same size regardless of tip count
- **Triangle size**: adjustable via slider
- **Subtree focus**: Ctrl+click an internal node to view its subtree in isolation; click "Back to full tree" to return
- **Re-root**: Ctrl+Shift+click any node or tip to re-root the tree at that point
- **Pan and zoom**: mouse drag to pan, scroll wheel to zoom

### Fast Mode (Large Trees)
- Auto-enables for trees with >1000 tips; manual toggle available
- **Batched SVG rendering**: branches collapsed into single `<path>` elements per color, dots grouped — reduces DOM elements from ~5000-7000 to ~500-1500
- **Simplified tip dots**: single color per tip (no pie charts), no labels or bootstrap values
- **Render cache**: skips re-render when no relevant state has changed
- **Auto-collapse**: for trees >2000 tips, automatically collapses clades to show ~50 visible groups; shift-click to expand clades of interest

### Undo / Redo
- Full undo/redo for tree operations: re-root, collapse/expand, subtree focus, restore full tree
- **Keyboard shortcuts**: Ctrl+Z to undo, Ctrl+Shift+Z (or Ctrl+Y) to redo
- Buttons in the Subtree Focus section; stack capped at 20 entries

### Node Selection
- **Click** an internal node to select it — the node appears as a larger black dot with a red ring
- The aligned FASTA for the subtree is automatically copied to the clipboard
- The sidebar shows species counts per selected node, and motif entries show per-node match counts with matching sequence names

### Clade Labels
- Select a node, then type a label in the **Clade Labels** section to annotate it
- Labels display as bold text next to the node dot on the tree (and on collapsed triangles)
- Labels are included in SVG/PNG/PDF exports
- Labels persist across undo/redo and are saved/restored with sessions
- Small "x" button to remove individual labels

### Species Highlighting
- Check species in the sidebar to color their tips (both labels and dots)
- Species count badges appear next to each species name when a node is selected
- Colors persist even when tip labels are hidden
- 40-color palette auto-assigned to species

### Name Search
- Regex search against tip names (case-insensitive)
- Matched tips highlighted in blue on the tree
- Clickable results list — click a match to:
  - Highlight it with a large red circle on the tree (visible even inside collapsed clades)
  - Pan the view to center on the tip
  - Copy its FASTA sequence to the clipboard
- Warning shown when a tip exists in the tree but not in the alignment

### Motif Search
- Search protein sequences by **regex** or **PROSITE** pattern
- Syntax hints and examples shown for each mode
- Motifs accumulate into a running list — each entry shows:
  - Color swatch, pattern, total match count
  - Per-node match count and first 10 matching sequence names (when a node is selected)
  - Remove button to delete individual motifs
- Each motif gets a distinct color; tips matching multiple motifs display a **pie-chart dot** showing all matching colors
- Text labels use the first matching motif's color

### Tip Interaction
- **Hover** over a tip to see: species, amino acid length, matching motif patterns, and "Click to copy FASTA" (or warning if sequence missing from alignment)
- **Click** a tip to copy its ungapped FASTA sequence to the clipboard (shows warning if not found in alignment)

### Shared Nodes
- Select species, then highlight all internal nodes containing all checked species
- Optional species exclusion filter (nodes must not contain excluded species)
- Clickable list of matching nodes — click to select and pan to the node

### Tip Filtering
- **Hide by regex**: enter a pattern to hide all matching tips from the tree
- **Hide unchecked species**: hide all tips belonging to unchecked species
- **Show all**: reset to show all tips
- Badge shows how many tips are currently hidden
- Filtering is instant and reversible — hidden tips are visually removed from the layout but remain in the underlying data
- Works across all three layout modes

### Pairwise Compare
- Select two tips (with autocomplete) and click **Compare** to see:
  - **Patristic distance**: sum of branch lengths from each tip to their LCA (computed client-side)
  - **Sequence identity**: percentage of identical positions at ungapped alignment columns (computed server-side, requires alignment)

### Image Export
- **SVG**: download a standalone SVG with inlined styles (opens in any browser or Inkscape)
- **PNG**: download a 2x resolution PNG for presentations and documents
- **PDF**: download a vector PDF (uses jsPDF + svg2pdf.js, bundled locally); auto-detects landscape/portrait

### Alignment Export
- **Click** an internal node to select it for export (also copies FASTA to clipboard)
- Exports gapped FASTA for the subtree's sequences (in tree traversal order)
- Warning shown when tips in the subtree are missing from the alignment
- Options:
  - **Extra sequences**: add comma-separated tip names (validates they exist)
  - **Full alignment**: export all columns
  - **Alignment columns**: specify a 1-indexed column range
  - **Reference sequence positions**: specify residue positions in a reference sequence; automatically maps to alignment columns

### Newick Export
- **Click** an internal node to select it, then:
  - **Download .nwk**: save the subtree as a Newick file
  - **Copy to clipboard**: copy the Newick string directly

### Session Save / Load
- **Save session**: downloads a JSON file with all UI state — collapsed nodes, clade labels, species selections, motif searches, tip filters, layout settings, zoom/pan, and the input folder path
- **Load session**: pick a session file to restore all state; also available from the setup dialog to resume without re-entering the data path

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/browse?path=...` | List subdirectories, detect valid input files |
| `POST /api/load` | Load an input folder (`{"input_dir": "..."}`) |
| `GET /api/status` | Check if data is loaded |
| `GET /api/tree` | Full tree as JSON |
| `GET /api/species` | Species list and species-to-tips mapping |
| `GET /api/tip-lengths` | Ungapped amino acid lengths for all tips |
| `GET /api/tip-seq?name=...` | Ungapped sequence for a single tip |
| `GET /api/motif?pattern=...&type=regex` | Motif search (regex or prosite) |
| `GET /api/nodes-by-species?species=X&exclude=Y` | Find nodes with required/excluded species |
| `GET /api/node-tips?node_id=N` | List descendant tip names for a node |
| `GET /api/tip-names` | All tip names (for autocomplete) |
| `GET /api/export?node_id=N&...` | Download gapped FASTA for a subtree |
| `GET /api/export-newick?node_id=N` | Download subtree as Newick string |
| `GET /api/pairwise?tip1=X&tip2=Y` | Pairwise sequence identity between two tips |
| `POST /api/reroot` | Re-root tree at a node (`{"node_id": N}`) |
| `POST /api/reset` | Reset server state to load new data |

### Export Parameters

| Parameter | Description |
|-----------|-------------|
| `node_id` | Required. Internal node ID |
| `extra_tips` | Optional. Additional tip names (repeatable) |
| `col_start`, `col_end` | Optional. 1-indexed alignment column range |
| `ref_seq` | Optional. Reference sequence name |
| `ref_start`, `ref_end` | Optional. 1-indexed residue positions in the reference |

## Project Structure

```
logo.png              # PhyloScope logo
environment.yml       # Conda/micromamba environment spec
browser/
  app.py              # FastAPI backend
  run.sh              # Launch script
  static/
    index.html        # Single-page app
    app.js            # All client-side logic
    style.css         # Styling
    logo.png          # Cropped logo for sidebar
    jspdf.umd.min.js  # jsPDF library (bundled)
    svg2pdf.umd.min.js # svg2pdf.js library (bundled)
example_data/         # Example tree, alignment, and species data
```

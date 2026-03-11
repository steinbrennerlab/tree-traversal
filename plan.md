# PhyloScope Standalone App — Implementation Plan

Convert PhyloScope from a client-server app (Python FastAPI backend) to a fully standalone browser app. All server logic moves to JavaScript. The result is a folder you can open directly in a browser or host on any static server — no Python, no server, no install.

## New Files to Create

### `browser/static/js/parsers.js` — File Parsing Module

Port all Python parsers from `app.py`:

1. **`parseNewick(nwkString)`** — Port of `_parse_newick()` and `_parse_node()` (app.py lines 57-118). Recursive descent parser. Use a closure or passed counter object instead of the global `_node_counter`. Output the slim JSON format (`{id, bl, name, sup, sp, ch}`) directly, matching the existing wire format so the renderer can consume it unchanged.

2. **`parseFasta(fastaText)`** — Port of `parse_fasta()` (app.py lines 124-136). Line-by-line parsing, returns `{header: sequence}` dict.

3. **`prositeToRegex(pattern)`** — Port of `prosite_to_regex()` (app.py lines 241-276). Converts PROSITE notation to JS regex strings (`x` → `.`, `{ABC}` → `[^ABC]`, etc.).

4. **`parseDatasetFile(tsvText, treeData)`** — Port of `parse_dataset_file()` (app.py lines 326-387) and `parse_numeric_value()` (app.py lines 310-322). Tab-delimited parsing with tip cross-referencing.

### `browser/static/js/tree-ops.js` — Tree Operations Module

Port tree-manipulation algorithms from `app.py`:

1. **`rerootTree(treeData, targetId)`** — Port of `reroot_tree()` (app.py lines 513-593). The most complex algorithm. Steps: build parent map, find path to target, reverse parent-child relationships, fix branch lengths, collapse degree-2 old root, re-assign IDs. Operates on `{id, bl, name, sup, sp, ch}` nodes.

2. **`annotateSpecies(node, tipToSpecies)`** — Port of `annotate_species()` (app.py lines 199-210). Adds `sp` to tips and `descendant_species` arrays to internal nodes.

3. **`findNodesWithSpecies(node, requiredSpecies, excludedSpecies)`** — Port of `find_nodes_with_species()` (app.py lines 216-235). Recursive walk returning node IDs.

4. **`nodeToNewick(node)`** — Port of `node_to_newick()` (app.py lines 606-621). Recursive conversion back to Newick string.

5. **`buildSpeciesMap(treeData, speciesFileContents)`** — Adapted port of `build_species_map()` (app.py lines 142-193). Input is an array of `{filename, text}` objects from the file picker. Preserves the hardcoded `REF_SPECIES` dict and `new_genomes.` prefix parsing.

6. **`refPosToColumns(refSeqGapped, refStart, refEnd)`** — Port of `ref_pos_to_columns()` (app.py lines 624-637). Maps 1-indexed reference positions to alignment column indices.

### `browser/static/js/file-loader.js` — File Loading Module

Handles the browser File API workflow:

1. **`loadFromFiles(fileList)`** — Main entry point. Given a `FileList` from `<input type="file" webkitdirectory>` or drag-and-drop:
   - Scans for `.nwk`, `.aa.fa`, `orthofinder-input/`, `dataset/` files using `webkitRelativePath`
   - Reads and parses tree, alignment, species mapping
   - Calls `annotateSpecies()` if species data available
   - Populates client `state` with all parsed data

2. **`detectFiles(fileList)`** — Scans a FileList, returns `{nwkFiles, aaFiles, hasOrtho, datasetFiles}` for the setup UI preview.

## Files to Modify

### `browser/static/index.html` — Setup UI Redesign

- Remove the path text input (`#setup-path`), Browse button (`#setup-browse`), and `#setup-browser` panel
- Add a drag-and-drop zone (large bordered area)
- Add a folder picker button: `<input type="file" webkitdirectory multiple>`
- Keep the detected files panel (`#detected-files`), populated from client-side scanning
- Keep "Load saved session" button (behavior changes — see session handling)
- Change all `/static/` prefixed paths to relative paths so it works from `file://`

### `browser/static/js/state.js` — New State Fields

Add:
- `state.loaded` — boolean (replaces `/api/status` check)
- `state.proteinSeqs` — `{tipName: gappedSequence}`
- `state.proteinSeqsUngapped` — `{tipName: ungappedSequence}`
- `state.gene`, `state.nwkName`, `state.aaName` — metadata strings
- `state.numSeqs`, `state.numSpecies` — counts
- `state.datasetFileObjects` — array of `{name, file}` for lazy loading
- `state.parsedDatasets` — cache of parsed dataset files

Remove:
- `state.inputDir`, `state.browserCurrentDir`, `state.browserParentDir`

Update `resetClientState()` to cover all new fields.

### `browser/static/js/actions.js` — Replace All 22 Fetch Calls

Every `fetch("/api/...")` call becomes a direct call to a client-side function:

| Function | Current fetch | Replacement |
|---|---|---|
| `init()` | `/api/status`, `/api/tree`, `/api/species`, `/api/tip-lengths` | Read directly from state (already populated by `loadFromFiles()`) |
| `loadTipDatalist()` | `/api/tip-names` | `Object.keys(state.proteinSeqs).sort()` |
| `rerootAt()` | `POST /api/reroot` | Call `rerootTree()` + `annotateSpecies()` from tree-ops.js |
| `copyTipFasta()` | `/api/tip-seq` | Read from `state.proteinSeqsUngapped[tipName]` |
| `copyNodeFasta()` | `/api/export` | Build FASTA from `state.proteinSeqs` + `collectAllTipNames()` |
| `openExportPanel()` | `/api/node-tips` | `collectAllTipNames(state.nodeById[nodeId])` |
| `searchMotif()` | `/api/motif` | `prositeToRegex()` + regex search over `state.proteinSeqsUngapped` |
| `highlightSharedNodes()` | `/api/nodes-by-species` | `findNodesWithSpecies()` from tree-ops.js |
| `comparePairwise()` | `/api/pairwise` | Client-side identity calc from `state.proteinSeqs` |
| `refreshDatasetList()` | `/api/datasets` | Read from `state.datasetFileObjects` |
| `loadHeatmapDataset()` | `/api/dataset` | Read File object + `parseDatasetFile()` |
| `doExport()` | `/api/export?...` | Build FASTA client-side, download via blob URL |
| `exportNewick()` | `/api/export-newick` | `nodeToNewick()` + blob download |
| `copyNewick()` | `/api/export-newick` | `nodeToNewick()` + clipboard write |
| `doSetupLoad()` | `POST /api/load` | Complete rewrite using File API |
| `browserNavigate()` | `/api/browse` | Remove entirely |
| `scanFolder()` | `/api/browse-files` | Remove; replaced by `detectFiles()` |
| `loadSession()` | `POST /api/load` (re-load) | Redesigned — see session handling |
| `saveSession()` | (saves inputDir) | Redesigned — embed raw data |
| `bindStartupControls()` reset handler | `POST /api/reset` | `resetClientState()` + `clearUiForReset()` |

### `browser/static/style.css`

- Add drag-drop zone styles (highlighted border on dragover, visual feedback)
- Remove unused server-browser panel styles

## Data Loading Flow (New)

1. User drags folder onto drop zone or clicks "Select folder"
2. `<input type="file" webkitdirectory>` fires `change` with a `FileList`
3. `detectFiles(fileList)` scans via `file.webkitRelativePath` to find `.nwk`, `.aa.fa`, `orthofinder-input/`, `dataset/` files
4. Preview shown in detected-files panel; user confirms
5. `loadFromFiles()` reads each file via `await file.text()` and parses everything
6. All results stored directly in client `state`
7. `init()` reads from state instead of fetching from server

## Edge Cases and Tricky Parts

### Session Save/Load Without Server

Current sessions store `inputDir` and rely on the server to reload. New approach: embed raw Newick text and FASTA text in the session JSON so sessions are self-contained. Potentially large (tens of MB for big alignments) but practical. Store raw strings (not parsed objects) to keep JSON smaller.

### Reroot Mutates State

After rerooting, the server re-annotates species (app.py lines 777-778). The client-side reroot must also call `annotateSpecies()` on the new root. The undo system already calls `deepCopyNode()` before reroot, so mutation is safe.

### Species Mapping Has Hardcoded Rules

`build_species_map()` uses a `REF_SPECIES` dict and `new_genomes.` prefix parsing (app.py lines 164-177). Port these rules exactly for backward compatibility.

### Dataset Loading Should Stay Lazy

Dataset files are loaded on-demand when the user clicks "Add" for a heatmap. Keep `File` objects in `state.datasetFileObjects` and parse only when requested.

### webkitdirectory Browser Support

Supported in Chrome, Edge, Firefox, and Safari. Not a formal standard but has broad support. Should also support individual file selection as a fallback.

### file:// Protocol

ES module imports work from `file://` in modern browsers. All paths must be relative. Single-directory structure with `index.html` alongside the other files.

## Implementation Order

### Phase 1: Core Parsers
Create `parsers.js`: `parseNewick()`, `parseFasta()`, `prositeToRegex()`, `parseDatasetFile()`. Test by importing in browser console with sample data.

### Phase 2: Tree Operations
Create `tree-ops.js`: `nodeToNewick()`, `findNodesWithSpecies()`, `annotateSpecies()`, `buildSpeciesMap()`, `rerootTree()` (hardest), `refPosToColumns()`.

### Phase 3: File Loading Infrastructure
Create `file-loader.js`: `detectFiles()`, `loadFromFiles()`. Wires together parsers and tree-ops.

### Phase 4: Replace All Fetch Calls in actions.js
Replace all 22 `fetch("/api/...")` calls with local function calls. Work from simplest to most complex:
1. Simple reads: `refreshDatasetList`, `loadTipDatalist`, `openExportPanel`
2. Computation: `searchMotif`, `highlightSharedNodes`, `comparePairwise`
3. Export: `doExport`, `exportNewick`, `copyNewick`, `copyTipFasta`, `copyNodeFasta`
4. Reroot: `rerootAt`
5. Loading flow: `doSetupLoad`, `init`, `checkStatus`, `loadSession`

### Phase 5: Setup UI Redesign
Modify `index.html`: drag-drop zone + folder picker. Wire events in `actions.js` `bindStartupControls()`.

### Phase 6: Session Handling
Redesign `saveSession()` and `loadSession()` to embed raw data in session files.

### Phase 7: Static Path Cleanup
Change all `/static/` paths to relative. Restructure files if needed so `index.html` can be opened directly.

### Phase 8: Cleanup
Delete `app.py`, `run.sh`, `environment.yml` (or archive). Update README.

## End Result

A folder you can open directly in a browser or host on any static server. No Python, no server, no install required. Could be zipped into a single distributable archive.

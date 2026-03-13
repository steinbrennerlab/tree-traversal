# Revised Plan: Standalone PhyloScope

## Summary

Convert PhyloScope to a browser-only app, but ship it as a built `browser/dist/` bundle rather than raw source files. This is the safest way to support both static hosting and direct `file://` use without the current `/static/...` and ES-module assumptions.

Keep the existing renderer and most of `tree-utils.js`; move backend-only parsing, tree mutation, export, and dataset logic into a new client-side data layer.

Do not delete `browser/app.py`, `browser/run.sh`, or `environment.yml` until the standalone bundle reaches feature parity and the docs are updated. Use the Python app as the migration oracle during implementation.

## Key Changes

### Runtime and packaging

- Add a small dev-only build step with esbuild and a `browser/package.json`.
- Source remains modular under `browser/static/js/`; build output is a bundled `browser/dist/index.html`, `app.bundle.js`, `style.css`, `logo.png`, `jspdf.umd.min.js`, and `svg2pdf.umd.min.js`.
- Remove absolute `/static/...` references in source templates; emitted bundle uses relative paths only.
- **Acceptance criterion:** opening `browser/dist/index.html` must make zero `/api/...` requests and zero absolute `/static/...` requests.

### Client data layer

- Add `browser/static/js/parsers.js` with `parseNewick`, `parseFastaText`, `parseNumericValue`, `parseDatasetText`, and `prositeToRegex`.
- Add `browser/static/js/tree-ops.js` with `annotateSpecies`, `buildSpeciesMapFromFiles`, `findNodesWithSpecies`, `rerootTree`, `nodeToNewick`, `refPosToColumns`, `computePairwiseIdentity`, and `buildExportFasta`.
- Keep the canonical tree shape as the current frontend wire format: `{ id, bl, name?, sup?, sp?, ch? }`. Internal-only annotations may add `descendantSpecies`.
- Reuse existing helpers in `tree-utils.js` for indexing, copying, tip collection, and patristic distance rather than reimplementing them.

### Loading flow and UI

Replace path-entry and server-side browse UI with:

- **Primary:** folder picker using `<input type="file" webkitdirectory multiple>`.
- **Secondary fallback:** multi-file picker for users who cannot provide a recursive folder selection.
- **Optional enhancement:** drag-and-drop, but only if implemented with the browser's directory APIs; it is not required for parity.

Keep the detected-files panel, but convert tree/alignment fields from free-text inputs to selectors:

- **Tree:** required, user must choose one `.nwk` if multiple are present.
- **Alignment:** optional, default to the first `.aa.fa`, with an explicit "None" choice.

`file-loader.js` should scan files by relative path, build an in-memory workspace, and populate state with raw texts, parsed data, and lazy dataset handles.

`state.js` should remove `inputDir`, `browserCurrentDir`, and `browserParentDir`, and add:

- `loaded`, `gene`, `nwkName`, `aaName`, `numSeqs`, `numSpecies`
- `proteinSeqs`, `proteinSeqsUngapped`, `tipLengths`
- `sourceFiles` or equivalent raw-text/file-handle store
- `datasetFileObjects`, `parsedDatasets`

`init()` becomes a state/bootstrap routine with no status fetch. `checkStatus()` becomes "show setup or restore session" logic only.

### Behavior replacement

Replace every `fetch("/api/...")` flow in `actions.js` with local helpers:

- `loadTipDatalist`, `copyTipFasta`, `openExportPanel`, `searchMotif`, `highlightSharedNodes`, `comparePairwise`, `refreshDatasetList`, `loadHeatmapDataset`, `doExport`, `exportNewick`, `copyNewick`, `rerootAt`, setup load/reset.

Keep dataset loading lazy:

- Store dataset files in state.
- Parse on first use.
- Cache parsed results by dataset name.

After reroot, re-annotate species, rebuild node indexes, clear subtree/full-tree view as the current UI already expects.

Undo/redo and sessions must use the same client-owned tree state, which also fixes the current client/server drift after rerooting.

### Sessions and compatibility

Replace the current path-based session format with **version: 2** self-contained sessions.

v2 session payload must include:

- **Source texts:** selected `.nwk`, optional `.aa.fa`, all orthofinder species FASTAs needed for mapping, and all dataset `.txt` files so the restored session keeps the dataset picker functional.
- **View state:** current `treeData`, optional `fullTreeData`, collapsed nodes, labels, hidden tips, selected/export node, zoom/pan, layout toggles, checked/excluded species, motifs, active heatmaps.

This is a deliberate change from the current app: sessions should restore rerooted and subtree-focused state, not just the original input location.

Support old **version: 1** sessions as best-effort import:

- Read their UI settings.
- Prompt the user to provide the source files/folder manually.
- Apply only the settings that still map cleanly after load.

## Implementation Order

### Phase 1: Core Parsers
Create `parsers.js`: `parseNewick()`, `parseFastaText()`, `prositeToRegex()`, `parseNumericValue()`, `parseDatasetText()`. Test by comparing output against the Python app with `example_data/`.

### Phase 2: Tree Operations
Create `tree-ops.js`: `nodeToNewick()`, `findNodesWithSpecies()`, `annotateSpecies()`, `buildSpeciesMapFromFiles()`, `rerootTree()` (hardest), `refPosToColumns()`, `computePairwiseIdentity()`, `buildExportFasta()`.

### Phase 3: File Loading Infrastructure
Create `file-loader.js`: `detectFiles()`, `loadFromFiles()`. Wires together parsers and tree-ops.

### Phase 4: Replace All Fetch Calls in actions.js
Replace all `fetch("/api/...")` calls with local function calls. Work from simplest to most complex:
1. Simple reads: `refreshDatasetList`, `loadTipDatalist`, `openExportPanel`
2. Computation: `searchMotif`, `highlightSharedNodes`, `comparePairwise`
3. Export: `doExport`, `exportNewick`, `copyNewick`, `copyTipFasta`, `copyNodeFasta`
4. Reroot: `rerootAt`
5. Loading flow: `doSetupLoad`, `init`, `checkStatus`, `loadSession`

### Phase 5: Setup UI Redesign
Modify `index.html`: folder picker + multi-file fallback. Wire events in `actions.js` `bindStartupControls()`.

### Phase 6: Session Handling
Redesign `saveSession()` and `loadSession()` to use v2 self-contained format with v1 backward compat.

### Phase 7: Build Pipeline
Add `browser/package.json` with esbuild. Build to `browser/dist/` with bundled HTML, JS, CSS, and assets. Relative paths only.

### Phase 8: Cleanup
Update README. Keep `app.py`, `run.sh`, `environment.yml` in-repo until parity is confirmed.

## Test Plan

Parity-check the standalone app against the current FastAPI app using `example_data/`.

Verify these outputs match between old and new implementations:

- tree parse shape
- species mapping
- motif matches
- shared-node results
- reroot result
- pairwise identity
- dataset parsing summary
- FASTA export
- Newick export

Run full UI regressions:

- load data
- select node and copy/export
- reroot
- undo/redo
- subtree focus and return
- motif search
- heatmap add/remove
- session save/load
- reset and reload

Distribution smoke tests:

- open `browser/dist/index.html` directly from disk
- serve `browser/dist/` from a simple static server
- confirm no backend dependency in either case

## Assumptions

- A dev-time build dependency is acceptable; the no-install goal applies to end users of the shipped app, not contributors.
- Session files may become large because they are self-contained; compression and "lightweight session" variants are out of scope for this pass.
- Drag-and-drop directory loading is a nice-to-have, not the primary compatibility path.
- Backend cleanup happens only after the standalone bundle is verified; until then, the Python app remains in-repo as the reference implementation.

## End Result

A `browser/dist/` folder you can open directly in a browser or host on any static server. No Python, no server, no install required. Could be zipped into a single distributable archive.

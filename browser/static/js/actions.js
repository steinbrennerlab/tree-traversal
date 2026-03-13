import { dom, MOTIF_PALETTE, PALETTE, resetClientState, state } from "./state.js";
import {
  collectAllTipNames,
  countAllTips,
  deepCopyNode,
  indexNodes,
  patristicDistance,
} from "./tree-utils.js";
import {
  applyTransform,
  buildExportSVGString,
  configureRenderer,
  invalidateRenderCache,
  renderTree,
} from "./renderer.js";
import { parseDatasetText, prositeToRegex } from "./parsers.js";
import {
  annotateSpecies,
  buildExportFasta,
  computePairwiseIdentity,
  findNodesWithSpecies,
  nodeToNewick,
  refPosToColumns,
  rerootTree,
} from "./tree-ops.js";
import { detectFiles, loadFromFiles, loadFromSourceTexts } from "./file-loader.js";

let controlsBound = false;
let startupBound = false;

// ---------------------------------------------------------------------------
// UI helpers (unchanged)
// ---------------------------------------------------------------------------

function clearUiForReset() {
  dom.group.innerHTML = "";
  document.getElementById("loaded-info-section").style.display = "none";
  document.getElementById("species-list").innerHTML = "";
  document.getElementById("exclude-species-list").innerHTML = "";
  document.getElementById("motif-list").innerHTML = "";
  document.getElementById("name-result").textContent = "";
  document.getElementById("name-matches-list").innerHTML = "";
  document.getElementById("name-input").value = "";
  document.getElementById("motif-result").textContent = "";
  document.getElementById("shared-result").textContent = "";
  document.getElementById("shared-nodes-list").innerHTML = "";
  document.getElementById("heatmap-dataset-select").innerHTML = '<option value="">Select dataset</option>';
  document.getElementById("heatmap-status").textContent = "No dataset loaded";
  document.getElementById("heatmap-panels").innerHTML = "";
  document.getElementById("export-form").style.display = "none";
  document.getElementById("newick-form").style.display = "none";
  document.getElementById("subtree-bar").style.display = "none";
  document.getElementById("sidebar-back-full-tree").style.display = "none";
  document.getElementById("fast-mode-toggle").checked = false;
}

function setTooltip(message) {
  dom.tooltip.textContent = message;
  dom.tooltip.style.display = "block";
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function rebuildMotifMatches() {
  state.motifMatches = new Set();
  for (const entry of state.motifList) {
    for (const tip of entry.tipNames) state.motifMatches.add(tip);
  }
}

function updateUndoRedoButtons() {
  document.getElementById("undo-btn").disabled = state.undoStack.length === 0;
  document.getElementById("redo-btn").disabled = state.redoStack.length === 0;
}

function updateFilterBadge() {
  const badge = document.getElementById("filter-badge");
  if (state.hiddenTips.size > 0) {
    badge.textContent = `${state.hiddenTips.size} tips hidden`;
    badge.style.display = "";
  } else {
    badge.style.display = "none";
  }
}

function getDefaultHeatmapColumns(columns) {
  return columns.length <= 8 ? [...columns] : columns.slice(0, 5);
}

function updateHeatmapStatus() {
  const status = document.getElementById("heatmap-status");
  if (state.activeHeatmaps.length === 0) {
    status.textContent = state.datasetFiles.length > 0 ? "Add one or more datasets to render rectangular heatmaps" : "No dataset files found";
    return;
  }
  const datasetWord = state.activeHeatmaps.length === 1 ? "dataset" : "datasets";
  status.textContent = `${state.activeHeatmaps.length} ${datasetWord} loaded with independent color scales`;
}

function populateDatasetSelect() {
  const select = document.getElementById("heatmap-dataset-select");
  select.innerHTML = '<option value="">Select dataset</option>';
  state.datasetFiles.forEach(name => {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    select.appendChild(option);
  });
  select.value = "";
}

function updateHeatmapPanels() {
  const container = document.getElementById("heatmap-panels");
  container.innerHTML = "";
  state.activeHeatmaps.forEach(heatmap => {
    const panel = document.createElement("div");
    panel.className = "heatmap-panel";

    const header = document.createElement("div");
    header.className = "heatmap-panel-header";
    const title = document.createElement("span");
    title.className = "heatmap-panel-title";
    title.textContent = heatmap.name;
    const removeBtn = document.createElement("button");
    removeBtn.className = "btn-sm";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", () => removeHeatmapDataset(heatmap.name));
    header.append(title, removeBtn);

    const summary = document.createElement("div");
    summary.className = "hint";
    summary.textContent =
      `${heatmap.matched_row_count} matched, ${heatmap.unmatched_row_count} unmatched ignored, ` +
      `${heatmap.visibleColumns.length}/${heatmap.columns.length} columns shown`;

    panel.append(header, summary, buildHeatmapLegendElement(heatmap), buildHeatmapColumnListElement(heatmap));
    container.appendChild(panel);
  });
}

function buildHeatmapLegendElement(heatmap) {
  const wrapper = document.createElement("div");
  wrapper.className = "heatmap-legend";
  if (heatmap.min_value == null || heatmap.max_value == null) {
    wrapper.style.display = "none";
    return wrapper;
  }
  const bar = document.createElement("div");
  bar.className = "heatmap-legend-bar";
  const labels = document.createElement("div");
  labels.className = "heatmap-legend-labels";
  const min = document.createElement("span");
  min.textContent = heatmap.min_value.toFixed(2);
  const max = document.createElement("span");
  max.textContent = heatmap.max_value.toFixed(2);
  labels.append(min, max);
  const missing = document.createElement("div");
  missing.className = "heatmap-legend-missing";
  missing.textContent = "Missing values shown in gray";
  wrapper.append(bar, labels, missing);
  return wrapper;
}

function buildHeatmapColumnListElement(heatmap) {
  const container = document.createElement("div");
  container.className = "heatmap-columns";
  const visible = new Set(heatmap.visibleColumns);
  heatmap.columns.forEach(column => {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = visible.has(column);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        heatmap.visibleColumns.push(column);
      } else {
        heatmap.visibleColumns = heatmap.visibleColumns.filter(name => name !== column);
      }
      invalidateRenderCache();
      updateHeatmapPanels();
      renderTree();
    });
    const text = document.createElement("span");
    text.textContent = column;
    label.append(checkbox, text);
    container.appendChild(label);
  });
  return container;
}

// ---------------------------------------------------------------------------
// Dataset loading (local, replacing fetch)
// ---------------------------------------------------------------------------

function refreshDatasetList() {
  populateDatasetSelect();
  updateHeatmapStatus();
}

function loadHeatmapDataset(name, preserveColumns = false, presetColumns = []) {
  if (!name) return;
  const existing = state.activeHeatmaps.find(heatmap => heatmap.name === name);
  if (existing && !preserveColumns) {
    document.getElementById("heatmap-status").textContent = `${name} is already loaded`;
    return;
  }

  // Check cache first, or parse from stored text
  let data;
  if (state.parsedDatasets[name]) {
    data = state.parsedDatasets[name];
  } else {
    const text = state.datasetTextsByName[name];
    if (!text) {
      document.getElementById("heatmap-status").textContent = `Dataset text not found: ${name}`;
      return;
    }
    const sourceTree = state.fullTreeData || state.treeData;
    const treeTips = new Set(collectAllTipNames(sourceTree));
    const result = parseDatasetText(text, name, treeTips);
    if (result.error) {
      document.getElementById("heatmap-status").textContent = result.error;
      return;
    }
    data = result.data;
    state.parsedDatasets[name] = data;
  }

  const visibleColumns = preserveColumns && presetColumns.length > 0
    ? data.columns.filter(column => presetColumns.includes(column))
    : getDefaultHeatmapColumns(data.columns);
  const next = {
    ...data,
    visibleColumns: visibleColumns.length > 0 ? visibleColumns : getDefaultHeatmapColumns(data.columns),
  };
  if (existing) {
    const index = state.activeHeatmaps.findIndex(heatmap => heatmap.name === name);
    state.activeHeatmaps[index] = next;
  } else {
    state.activeHeatmaps.push(next);
  }
  populateDatasetSelect();
  updateHeatmapPanels();
  updateHeatmapStatus();
  invalidateRenderCache();
  renderTree();
}

function removeHeatmapDataset(name) {
  state.activeHeatmaps = state.activeHeatmaps.filter(heatmap => heatmap.name !== name);
  populateDatasetSelect();
  updateHeatmapPanels();
  updateHeatmapStatus();
  invalidateRenderCache();
  renderTree();
}

function clearHeatmapDatasets() {
  state.activeHeatmaps = [];
  populateDatasetSelect();
  updateHeatmapPanels();
  updateHeatmapStatus();
  invalidateRenderCache();
  renderTree();
}

// ---------------------------------------------------------------------------
// Label / species helpers (unchanged)
// ---------------------------------------------------------------------------

function updateLabelInput() {
  const container = document.getElementById("label-input-container");
  if (state.exportNodeId == null) {
    container.style.display = "none";
    return;
  }
  container.style.display = "";
  document.getElementById("node-label-input").value = state.nodeLabels[state.exportNodeId] || "";
}

function buildLabelList() {
  const container = document.getElementById("label-list");
  container.innerHTML = "";
  const hasLabels = Object.keys(state.nodeLabels).length > 0;
  document.getElementById("label-size-container").style.display = hasLabels ? "flex" : "none";
  for (const [nodeId, label] of Object.entries(state.nodeLabels)) {
    const row = document.createElement("div");
    row.className = "label-entry";
    const text = document.createElement("span");
    text.className = "label-text";
    text.textContent = `#${nodeId}: ${label}`;
    const removeBtn = document.createElement("button");
    removeBtn.className = "motif-remove";
    removeBtn.textContent = "\u00d7";
    removeBtn.addEventListener("click", () => {
      delete state.nodeLabels[nodeId];
      invalidateRenderCache();
      renderTree();
      buildLabelList();
      updateLabelInput();
    });
    row.append(text, removeBtn);
    container.appendChild(row);
  }
}

function updateSpeciesCounts() {
  const counts = {};
  for (const tip of state.selectedNodeTips) {
    const species = state.tipToSpecies[tip];
    if (species) counts[species] = (counts[species] || 0) + 1;
  }
  document.querySelectorAll("#species-list label").forEach(label => {
    const species = label.querySelector("input").dataset.species;
    let badge = label.querySelector(".sp-count");
    if (state.selectedNodeTips.length > 0 && counts[species]) {
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "sp-count";
        label.appendChild(badge);
      }
      badge.textContent = counts[species];
    } else if (badge) {
      badge.remove();
    }
  });
}

function buildMotifList() {
  const container = document.getElementById("motif-list");
  container.innerHTML = "";
  state.motifList.forEach((entry, index) => {
    const row = document.createElement("div");
    row.className = "motif-entry";

    const swatch = document.createElement("span");
    swatch.className = "motif-swatch";
    swatch.style.background = entry.color;

    const pat = document.createElement("span");
    pat.className = "motif-pattern";
    pat.textContent = entry.pattern;
    pat.title = entry.pattern;

    const count = document.createElement("span");
    count.className = "motif-count";
    count.textContent = `${entry.tipNames.length} total`;

    row.append(swatch, pat, count);

    let inNodeTips = [];
    if (state.selectedNodeTips.length > 0) {
      const nodeSet = new Set(state.selectedNodeTips);
      inNodeTips = entry.tipNames.filter(tip => nodeSet.has(tip));
      const nodeCount = document.createElement("span");
      nodeCount.className = "motif-node-count";
      nodeCount.textContent = `${inNodeTips.length} in node`;
      row.appendChild(nodeCount);
    }

    const removeBtn = document.createElement("button");
    removeBtn.className = "motif-remove";
    removeBtn.textContent = "\u00d7";
    removeBtn.title = "Remove";
    removeBtn.addEventListener("click", () => {
      state.motifList.splice(index, 1);
      rebuildMotifMatches();
      buildMotifList();
      renderTree();
    });
    row.appendChild(removeBtn);
    container.appendChild(row);

    if (inNodeTips.length > 0) {
      const tipsList = document.createElement("div");
      tipsList.className = "motif-tips-list";
      const shown = inNodeTips.slice(0, 10);
      tipsList.textContent = shown.join("\n") + (inNodeTips.length > 10 ? `\n... and ${inNodeTips.length - 10} more` : "");
      container.appendChild(tipsList);
    }
  });
}

function buildSpeciesList(speciesList) {
  const container = document.getElementById("species-list");
  container.innerHTML = "";
  if (speciesList.length === 0) {
    container.innerHTML = '<p class="hint">No species-specific FASTAs loaded</p>';
    return;
  }
  speciesList.forEach(species => {
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.dataset.species = species;
    cb.addEventListener("change", renderTree);
    const swatch = document.createElement("span");
    swatch.className = "sp-swatch";
    swatch.style.background = state.speciesColors[species];
    label.append(cb, swatch, ` ${species}`);
    container.appendChild(label);
  });
}

function buildExcludeSpeciesList(speciesList) {
  const container = document.getElementById("exclude-species-list");
  container.innerHTML = "";
  speciesList.forEach(species => {
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.dataset.excludeSpecies = species;
    const swatch = document.createElement("span");
    swatch.className = "sp-swatch";
    swatch.style.background = state.speciesColors[species];
    label.append(cb, swatch, ` ${species}`);
    container.appendChild(label);
  });
}

function applyFastaState() {
  const motifInput = document.getElementById("motif-input");
  const motifSearch = document.getElementById("motif-search");
  const motifType = document.getElementById("motif-type");
  const lengthToggle = document.getElementById("length-toggle");
  const motifHint = document.getElementById("motif-hint");
  const exportInfo = document.getElementById("export-info");
  const exportForm = document.getElementById("export-form");
  const subtreeHint = document.getElementById("subtree-hint");

  if (!state.hasFasta) {
    motifInput.disabled = true;
    motifSearch.disabled = true;
    motifType.disabled = true;
    motifInput.placeholder = "No alignment loaded";
    motifHint.textContent = "No alignment loaded";
    lengthToggle.disabled = true;
    lengthToggle.checked = false;
    state.showLengths = false;
    exportInfo.textContent = "No alignment loaded";
    exportForm.style.display = "none";
    subtreeHint.innerHTML = "Click: select node<br>Shift+click: collapse/expand<br>Ctrl+click: view subtree in isolation<br>Ctrl+Shift+click: re-root at node";
    return;
  }

  motifInput.disabled = false;
  motifSearch.disabled = false;
  motifType.disabled = false;
  lengthToggle.disabled = false;
  subtreeHint.innerHTML = "Click: select node &amp; copy FASTA<br>Shift+click: collapse/expand<br>Ctrl+click: view subtree in isolation<br>Ctrl+Shift+click: re-root at node";
}

// ---------------------------------------------------------------------------
// Tip datalist (local, replacing fetch)
// ---------------------------------------------------------------------------

function loadTipDatalist() {
  state.allTipNames = state.proteinSeqsUngapped ? Object.keys(state.proteinSeqsUngapped).sort() : [];
  const dl = document.getElementById("tip-datalist");
  dl.innerHTML = "";
  state.allTipNames.forEach(tip => {
    const opt = document.createElement("option");
    opt.value = tip;
    dl.appendChild(opt);
  });
}

// ---------------------------------------------------------------------------
// Info display
// ---------------------------------------------------------------------------

function showLoadedInfo(totalTips) {
  const section = document.getElementById("loaded-info-section");
  const el = document.getElementById("loaded-info");
  if (!state.loaded) {
    section.style.display = "none";
    return;
  }
  section.style.display = "";
  const lines = [];
  const tipStr = totalTips != null ? ` <span class="loaded-label">(${totalTips} tips)</span>` : "";
  lines.push(`<span class="loaded-label">Tree:</span> <span class="loaded-value">${state.nwkName || "unknown"}</span>${tipStr}`);
  if (state.hasFasta && state.aaName) {
    lines.push(`<span class="loaded-label">Alignment:</span> <span class="loaded-value">${state.aaName}</span> <span class="loaded-label">(${state.numSeqs} seqs)</span>`);
  } else {
    lines.push(`<span class="loaded-label">Alignment:</span> <span class="loaded-none">none</span>`);
  }
  if (state.numSpecies > 0) {
    lines.push(`<span class="loaded-label">Species:</span> <span class="loaded-value">${state.numSpecies} species</span>`);
  } else {
    lines.push(`<span class="loaded-label">Species:</span> <span class="loaded-none">none</span>`);
  }
  lines.push(`<span class="loaded-label">Datasets:</span> <span class="loaded-value">${state.datasetFiles.length}</span>`);
  el.innerHTML = lines.join("<br>");
}

// ---------------------------------------------------------------------------
// Undo / redo (unchanged)
// ---------------------------------------------------------------------------

function captureState() {
  return {
    treeData: deepCopyNode(state.treeData),
    collapsedNodes: new Set(state.collapsedNodes),
    exportNodeId: state.exportNodeId,
    selectedTip: state.selectedTip,
    fullTreeData: state.fullTreeData ? deepCopyNode(state.fullTreeData) : null,
    scale: state.scale,
    tx: state.tx,
    ty: state.ty,
    hiddenTips: new Set(state.hiddenTips),
    nodeLabels: { ...state.nodeLabels },
  };
}

function restoreState(snapshot) {
  state.treeData = snapshot.treeData;
  state.collapsedNodes = snapshot.collapsedNodes;
  state.exportNodeId = snapshot.exportNodeId;
  state.selectedTip = snapshot.selectedTip;
  state.fullTreeData = snapshot.fullTreeData;
  state.scale = snapshot.scale;
  state.tx = snapshot.tx;
  state.ty = snapshot.ty;
  state.hiddenTips = snapshot.hiddenTips;
  state.nodeLabels = snapshot.nodeLabels;
  state.nodeById = {};
  state.parentMap = {};
  indexNodes(state.treeData);
  if (state.fullTreeData) {
    document.getElementById("subtree-bar").style.display = "";
    document.getElementById("sidebar-back-full-tree").style.display = "";
  } else {
    document.getElementById("subtree-bar").style.display = "none";
    document.getElementById("sidebar-back-full-tree").style.display = "none";
  }
  invalidateRenderCache();
  updateFilterBadge();
  buildLabelList();
  updateLabelInput();
  updateUndoRedoButtons();
  renderTree();
}

function pushUndo() {
  state.undoStack.push(captureState());
  if (state.undoStack.length > 20) state.undoStack.shift();
  state.redoStack = [];
  updateUndoRedoButtons();
}

function undo() {
  if (state.undoStack.length === 0) return;
  state.redoStack.push(captureState());
  restoreState(state.undoStack.pop());
}

function redo() {
  if (state.redoStack.length === 0) return;
  state.undoStack.push(captureState());
  restoreState(state.redoStack.pop());
}

// ---------------------------------------------------------------------------
// Subtree focus (unchanged)
// ---------------------------------------------------------------------------

function openSubtree(nodeId) {
  pushUndo();
  if (state.fullTreeData === null) state.fullTreeData = state.treeData;
  state.treeData = deepCopyNode(state.nodeById[nodeId]);
  state.nodeById = {};
  state.parentMap = {};
  indexNodes(state.treeData);
  state.collapsedNodes.clear();
  state.scale = 1;
  state.tx = 20;
  state.ty = 20;
  document.getElementById("subtree-bar").style.display = "";
  document.getElementById("sidebar-back-full-tree").style.display = "";
  renderTree();
}

// ---------------------------------------------------------------------------
// Reroot (local, replacing fetch)
// ---------------------------------------------------------------------------

function rerootAt(nodeId) {
  pushUndo();
  const newRoot = rerootTree(state.treeData, nodeId);
  if (!newRoot) {
    setTooltip("Re-root failed: node not found");
    return;
  }

  // Re-annotate species if mapping exists
  if (Object.keys(state.tipToSpecies).length > 0) {
    annotateSpecies(newRoot, state.tipToSpecies);
  }

  state.treeData = newRoot;
  state.nodeById = {};
  state.parentMap = {};
  indexNodes(state.treeData);
  state.collapsedNodes.clear();
  state.selectedTip = null;
  state.exportNodeId = null;
  state.fullTreeData = null;
  invalidateRenderCache();
  state.scale = 1;
  state.tx = 20;
  state.ty = 20;
  document.getElementById("subtree-bar").style.display = "none";
  document.getElementById("sidebar-back-full-tree").style.display = "none";
  document.getElementById("export-form").style.display = "none";
  document.getElementById("newick-form").style.display = "none";
  renderTree();
  setTooltip("Tree re-rooted");
}

function restoreFullTree() {
  pushUndo();
  state.treeData = state.fullTreeData;
  state.fullTreeData = null;
  state.nodeById = {};
  state.parentMap = {};
  indexNodes(state.treeData);
  state.scale = 1;
  state.tx = 20;
  state.ty = 20;
  document.getElementById("subtree-bar").style.display = "none";
  document.getElementById("sidebar-back-full-tree").style.display = "none";
  renderTree();
}

// ---------------------------------------------------------------------------
// Copy / FASTA (local, replacing fetch)
// ---------------------------------------------------------------------------

async function copyTipName(tipName) {
  try {
    await navigator.clipboard.writeText(tipName);
    setTooltip("Name copied to clipboard!");
  } catch {
    setTooltip("Copy failed");
  }
}

async function copyTipFasta(tipName) {
  if (!state.proteinSeqsUngapped) {
    setTooltip("No alignment loaded");
    return;
  }
  const seq = state.proteinSeqsUngapped[tipName];
  if (!seq) {
    setTooltip(`Sequence not found in alignment: ${tipName}`);
    return;
  }
  try {
    await navigator.clipboard.writeText(`>${tipName}\n${seq}`);
    setTooltip("FASTA copied to clipboard!");
  } catch {
    setTooltip("Copy failed");
  }
}

async function copyNodeFasta(nodeId) {
  if (!state.proteinSeqs) {
    setTooltip("No alignment loaded");
    return;
  }
  const node = state.nodeById[nodeId];
  if (!node) return;
  const tips = collectAllTipNames(node);
  const fasta = buildExportFasta(tips, state.proteinSeqs, null, null);
  try {
    await navigator.clipboard.writeText(fasta);
    let warn = "";
    if (state.hasFasta && state.allTipNames.length > 0) {
      const alnSet = new Set(state.allTipNames);
      const missing = tips.filter(tip => !alnSet.has(tip));
      if (missing.length > 0) warn = ` (${missing.length} tip${missing.length !== 1 ? "s" : ""} missing from alignment)`;
    }
    setTooltip(`Aligned FASTA copied (node #${nodeId})${warn}`);
  } catch {
    setTooltip("Copy failed");
  }
}

// ---------------------------------------------------------------------------
// Tooltips (unchanged)
// ---------------------------------------------------------------------------

function buildTipTooltip(tipName, species) {
  const lines = [tipName, `Species: ${species || "unknown"}`];
  if (state.hasFasta) {
    const alnSet = new Set(state.allTipNames);
    if (!alnSet.has(tipName)) {
      lines.push("Warning: Sequence not found in alignment");
    } else {
      const len = state.tipLengths[tipName];
      if (len != null) lines.push(`Length: ${len} aa`);
      const matching = state.motifList.filter(motif => motif.tipNames.includes(tipName));
      if (matching.length > 0) lines.push(`Motifs: ${matching.map(motif => motif.pattern).join(", ")}`);
      lines.push("Click to copy name \u00b7 Shift+click to copy FASTA");
    }
  }
  return lines.join("\n");
}

function buildHeatmapTooltip(el) {
  const lines = [
    el.dataset.heatmapTip,
    `Dataset: ${el.dataset.dataset}`,
    `Column: ${el.dataset.column}`,
  ];
  if (el.dataset.value === "") {
    lines.push("Value: missing");
  } else {
    lines.push(`Value: ${el.dataset.rawValue || el.dataset.value}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Export panel (local, replacing fetch)
// ---------------------------------------------------------------------------

function openExportPanel(nodeId) {
  state.exportNodeId = nodeId;
  document.getElementById("export-form").style.display = "";

  const node = state.nodeById[nodeId];
  const tips = node ? collectAllTipNames(node) : [];
  state.selectedNodeTips = tips;

  updateSpeciesCounts();
  buildMotifList();
  renderTree();

  let missingTips = [];
  if (state.hasFasta && state.allTipNames.length > 0) {
    const alnSet = new Set(state.allTipNames);
    missingTips = tips.filter(tip => !alnSet.has(tip));
  }

  const infoEl = document.getElementById("export-info");
  if (missingTips.length > 0) {
    infoEl.innerHTML =
      `Node #${nodeId} \u2014 ${tips.length} tip${tips.length !== 1 ? "s" : ""}` +
      `<br><span style="color:#c0392b">${missingTips.length} tip${missingTips.length !== 1 ? "s" : ""} not in alignment: ${missingTips.slice(0, 5).join(", ")}${missingTips.length > 5 ? ", ..." : ""}</span>`;
  } else {
    infoEl.textContent = `Node #${nodeId} \u2014 ${tips.length} tip${tips.length !== 1 ? "s" : ""}`;
  }
  document.getElementById("export-tips-summary").textContent = `Tip names (${tips.length})`;
  document.getElementById("export-tips-list").textContent = tips.join("\n");
  document.getElementById("export-extra-tips").value = "";
  document.querySelector('input[name="export-range"][value="full"]').checked = true;
  document.getElementById("export-col-start").value = "";
  document.getElementById("export-col-end").value = "";
  document.getElementById("export-ref-seq").value = "";
  document.getElementById("export-ref-start").value = "";
  document.getElementById("export-ref-end").value = "";
  document.getElementById("export-result").textContent = "";
  document.getElementById("newick-form").style.display = "";
  document.getElementById("newick-info").textContent = `Node #${nodeId} \u2014 ${tips.length} tip${tips.length !== 1 ? "s" : ""}`;
  document.getElementById("newick-result").textContent = "";
  updateLabelInput();
  document.getElementById("export-section").scrollIntoView({ behavior: "smooth" });
}

// ---------------------------------------------------------------------------
// Search (unchanged or local)
// ---------------------------------------------------------------------------

function searchName() {
  const query = document.getElementById("name-input").value.trim();
  const listEl = document.getElementById("name-matches-list");
  if (!query) {
    state.nameMatches = new Set();
    state.selectedTip = null;
    listEl.innerHTML = "";
    renderTree();
    return;
  }
  try {
    const re = new RegExp(query, "i");
    const matched = collectAllTipNames(state.treeData).filter(name => re.test(name));
    state.nameMatches = new Set(matched);
    document.getElementById("name-result").textContent = `${state.nameMatches.size} tips matched`;
    listEl.innerHTML = "";
    matched.forEach(tipName => {
      const item = document.createElement("div");
      item.className = "name-match-item";
      item.textContent = tipName;
      if (tipName === state.selectedTip) item.classList.add("name-match-active");
      item.addEventListener("click", () => selectNameTip(tipName));
      listEl.appendChild(item);
    });
  } catch (e) {
    document.getElementById("name-result").textContent = `Invalid regex: ${e.message}`;
    state.nameMatches = new Set();
    listEl.innerHTML = "";
  }
  renderTree();
}

function selectNameTip(tipName) {
  state.selectedTip = tipName;
  document.getElementById("name-result").textContent = `${state.nameMatches.size} tips matched`;
  copyTipName(tipName);
  document.querySelectorAll(".name-match-item").forEach(el => {
    el.classList.toggle("name-match-active", el.textContent === tipName);
  });
  invalidateRenderCache();
  renderTree();
  const ring = dom.group.querySelector(".selected-tip-ring");
  if (ring) {
    const cx = parseFloat(ring.getAttribute("cx"));
    const cy = parseFloat(ring.getAttribute("cy"));
    const rect = dom.svg.getBoundingClientRect();
    state.tx = rect.width / 2 - cx * state.scale;
    state.ty = rect.height / 2 - cy * state.scale;
    applyTransform();
  }
}

// ---------------------------------------------------------------------------
// Motif search (local, replacing fetch)
// ---------------------------------------------------------------------------

function searchMotif() {
  const pattern = document.getElementById("motif-input").value.trim();
  if (!pattern) return;
  const type = document.getElementById("motif-type").value;
  const result = document.getElementById("motif-result");

  if (!state.proteinSeqsUngapped) {
    result.textContent = "No alignment loaded";
    return;
  }

  let regexStr;
  if (type === "prosite") {
    try {
      regexStr = prositeToRegex(pattern);
    } catch (e) {
      result.textContent = `Invalid PROSITE pattern: ${e.message}`;
      return;
    }
  } else {
    regexStr = pattern;
  }

  let compiled;
  try {
    compiled = new RegExp(regexStr, "i");
  } catch (e) {
    result.textContent = `Invalid regex: ${e.message}`;
    return;
  }

  const matched = Object.entries(state.proteinSeqsUngapped)
    .filter(([, seq]) => compiled.test(seq))
    .map(([tip]) => tip)
    .sort();

  const color = MOTIF_PALETTE[state.motifList.length % MOTIF_PALETTE.length];
  state.motifList.push({ pattern, type, tipNames: matched, color });
  rebuildMotifMatches();
  buildMotifList();
  result.textContent = `${matched.length} tips matched`;
  renderTree();
}

// ---------------------------------------------------------------------------
// Shared nodes (local, replacing fetch)
// ---------------------------------------------------------------------------

function highlightSharedNodes() {
  const checked = [...document.querySelectorAll("#species-list input:checked")].map(cb => cb.dataset.species);
  const listEl = document.getElementById("shared-nodes-list");
  if (checked.length === 0) {
    document.getElementById("shared-result").textContent = "Select at least one species";
    listEl.innerHTML = "";
    return;
  }
  const excluded = [...document.querySelectorAll("#exclude-species-list input:checked")].map(cb => cb.dataset.excludeSpecies);
  const nodeIds = findNodesWithSpecies(state.treeData, checked, excluded);
  state.sharedNodes = new Set(nodeIds);
  document.getElementById("shared-result").textContent = `${state.sharedNodes.size} nodes highlighted`;
  listEl.innerHTML = "";
  [...state.sharedNodes].sort((a, b) => a - b).forEach(nodeId => {
    const node = state.nodeById[nodeId];
    const tips = node ? countAllTips(node) : "?";
    const sup = node && node.sup != null ? node.sup : "\u2014";
    const item = document.createElement("div");
    item.className = "name-match-item";
    item.dataset.nodeid = nodeId;
    item.textContent = `Node #${nodeId} \u2014 ${tips} tips (support: ${sup})`;
    item.addEventListener("click", () => selectSharedNode(nodeId));
    listEl.appendChild(item);
  });
  renderTree();
}

function selectSharedNode(nodeId) {
  openExportPanel(nodeId);
  document.querySelectorAll("#shared-nodes-list .name-match-item").forEach(el => {
    el.classList.toggle("name-match-active", parseInt(el.dataset.nodeid, 10) === nodeId);
  });
  invalidateRenderCache();
  renderTree();
  requestAnimationFrame(() => {
    const ring = dom.group.querySelector(".selected-node-ring");
    if (ring) {
      const cx = parseFloat(ring.getAttribute("cx"));
      const cy = parseFloat(ring.getAttribute("cy"));
      const rect = dom.svg.getBoundingClientRect();
      state.tx = rect.width / 2 - cx * state.scale;
      state.ty = rect.height / 2 - cy * state.scale;
      applyTransform();
    }
  });
}

// ---------------------------------------------------------------------------
// Filter tips (unchanged)
// ---------------------------------------------------------------------------

function filterTipsByRegex() {
  const pattern = document.getElementById("filter-tips-input").value.trim();
  if (!pattern) return;
  try {
    const re = new RegExp(pattern, "i");
    let count = 0;
    collectAllTipNames(state.treeData).forEach(name => {
      if (re.test(name)) {
        state.hiddenTips.add(name);
        count++;
      }
    });
    updateFilterBadge();
    invalidateRenderCache();
    renderTree();
    document.getElementById("filter-result").textContent = `${count} tips hidden`;
  } catch (e) {
    document.getElementById("filter-result").textContent = `Invalid regex: ${e.message}`;
  }
}

function filterTipsUncheckedSpecies() {
  const checked = new Set([...document.querySelectorAll("#species-list input:checked")].map(cb => cb.dataset.species));
  if (checked.size === 0) {
    document.getElementById("filter-result").textContent = "Check at least one species first";
    return;
  }
  let count = 0;
  collectAllTipNames(state.treeData).forEach(name => {
    const species = state.tipToSpecies[name];
    if (species && !checked.has(species)) {
      state.hiddenTips.add(name);
      count++;
    }
  });
  updateFilterBadge();
  invalidateRenderCache();
  renderTree();
  document.getElementById("filter-result").textContent = `${count} tips hidden`;
}

function showAllTips() {
  state.hiddenTips.clear();
  updateFilterBadge();
  invalidateRenderCache();
  renderTree();
  document.getElementById("filter-result").textContent = "";
}

function setNodeLabel() {
  if (state.exportNodeId == null) return;
  const value = document.getElementById("node-label-input").value.trim();
  if (value) {
    state.nodeLabels[state.exportNodeId] = value;
  } else {
    delete state.nodeLabels[state.exportNodeId];
  }
  invalidateRenderCache();
  renderTree();
  buildLabelList();
}

// ---------------------------------------------------------------------------
// Pairwise compare (local, replacing fetch)
// ---------------------------------------------------------------------------

function comparePairwise() {
  const tipA = document.getElementById("pairwise-tip-a").value.trim();
  const tipB = document.getElementById("pairwise-tip-b").value.trim();
  const resultEl = document.getElementById("pairwise-result");
  if (!tipA || !tipB) {
    resultEl.textContent = "Enter two tip names";
    return;
  }

  const lines = [];
  const dist = patristicDistance(tipA, tipB);
  if (dist != null) {
    lines.push(`Patristic distance: ${dist.toFixed(6)}`);
  } else {
    lines.push("Could not compute patristic distance (tips not found)");
  }

  if (state.hasFasta && state.proteinSeqs) {
    const seq1 = state.proteinSeqs[tipA];
    const seq2 = state.proteinSeqs[tipB];
    if (!seq1) {
      lines.push(`Tip '${tipA}' not found in alignment`);
    } else if (!seq2) {
      lines.push(`Tip '${tipB}' not found in alignment`);
    } else {
      const result = computePairwiseIdentity(seq1, seq2);
      if (result.error) {
        lines.push(result.error);
      } else {
        lines.push(`Sequence identity: ${(result.identity * 100).toFixed(1)}% (${result.identical_positions}/${result.aligned_length} positions)`);
        lines.push(`Sequence similarity: ${(result.similarity * 100).toFixed(1)}% (${result.similar_positions}/${result.aligned_length} positions)`);
      }
    }
  }
  resultEl.textContent = lines.join("\n");
}

// ---------------------------------------------------------------------------
// Session save/load (v2 self-contained format)
// ---------------------------------------------------------------------------

function saveSession() {
  if (!state.loaded) return;

  const session = {
    version: 2,
    sourceTexts: state.sourceTexts,
    gene: state.gene,
    nwkName: state.nwkName,
    aaName: state.aaName,
    treeData: state.treeData,
    fullTreeData: state.fullTreeData,
    collapsedNodes: [...state.collapsedNodes],
    nodeLabels: state.nodeLabels,
    labelFontSize: state.labelFontSize,
    exportNodeId: state.exportNodeId,
    selectedTip: state.selectedTip,
    checkedSpecies: [...document.querySelectorAll("#species-list input:checked")].map(cb => cb.dataset.species),
    excludedSpecies: [...document.querySelectorAll("#exclude-species-list input:checked")].map(cb => cb.dataset.excludeSpecies),
    motifList: state.motifList.map(motif => ({ pattern: motif.pattern, type: motif.type })),
    nameSearch: document.getElementById("name-input").value,
    layoutMode: state.layoutMode,
    usePhylogram: state.usePhylogram,
    showTipLabels: state.showTipLabels,
    showBootstraps: state.showBootstraps,
    showLengths: state.showLengths,
    fastMode: state.fastMode,
    uniformTriangles: state.uniformTriangles,
    triangleScale: state.triangleScale,
    tipSpacing: state.tipSpacing,
    tipLabelSize: state.tipLabelSize,
    dotSize: state.dotSize,
    hiddenTips: [...state.hiddenTips],
    scale: state.scale,
    tx: state.tx,
    ty: state.ty,
    activeHeatmaps: state.activeHeatmaps.map(heatmap => ({
      name: heatmap.name,
      visibleColumns: [...heatmap.visibleColumns],
    })),
  };

  triggerDownload(new Blob([JSON.stringify(session, null, 2)], { type: "application/json" }), "phyloscope-session.json");
}

function loadSession(fromSetup = false) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json";
  input.addEventListener("change", async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      const session = JSON.parse(await file.text());

      if (session.version === 2) {
        await loadSessionV2(session, fromSetup);
      } else if (session.version === 1) {
        loadSessionV1(session, fromSetup);
      } else {
        alert("Unknown session version");
      }
    } catch (e) {
      const target = fromSetup ? dom.setupError : document.getElementById("session-result");
      target.textContent = `Load failed: ${e.message}`;
    }
  });
  input.click();
}

async function loadSessionV2(session, fromSetup) {
  // Reconstruct workspace from source texts
  const workspace = loadFromSourceTexts(session.sourceTexts);

  // Populate state with workspace data
  state.loaded = true;
  state.gene = session.gene || workspace.gene;
  state.nwkName = session.nwkName || workspace.nwkName;
  state.aaName = session.aaName || workspace.aaName;
  state.hasFasta = workspace.hasFasta;
  state.numSeqs = workspace.numSeqs;
  state.numSpecies = workspace.numSpecies;
  state.proteinSeqs = workspace.proteinSeqs;
  state.proteinSeqsUngapped = workspace.proteinSeqsUngapped;
  state.speciesMap = workspace.speciesToTips;
  state.tipToSpecies = workspace.tipToSpecies;
  state.tipLengths = workspace.tipLengths;
  state.sourceTexts = session.sourceTexts;
  state.datasetFiles = workspace.datasetFileNames;
  state.datasetTextsByName = {};
  for (const d of (session.sourceTexts.datasets || [])) {
    state.datasetTextsByName[d.name] = d.text;
  }
  state.parsedDatasets = {};

  // Use saved tree data (may be rerooted/subtree-focused)
  state.treeData = session.treeData;
  state.fullTreeData = session.fullTreeData || null;

  // Re-annotate species on saved tree
  if (Object.keys(state.tipToSpecies).length > 0) {
    annotateSpecies(state.treeData, state.tipToSpecies);
    if (state.fullTreeData) annotateSpecies(state.fullTreeData, state.tipToSpecies);
  }

  if (fromSetup) hideSetup();

  // Initialize species colors
  const speciesList = Object.keys(state.speciesMap).sort();
  speciesList.forEach((species, index) => {
    state.speciesColors[species] = PALETTE[index % PALETTE.length];
  });

  state.nodeById = {};
  state.parentMap = {};
  indexNodes(state.treeData);

  const totalTips = countAllTips(state.treeData);
  showLoadedInfo(totalTips);

  buildSpeciesList(speciesList);
  buildExcludeSpeciesList(speciesList);
  setupControls();
  refreshDatasetList();
  loadTipDatalist();
  applyFastaState();

  // Restore UI state
  applySessionSettings(session);

  // Restore motifs locally
  state.motifList = [];
  if (session.motifList && state.proteinSeqsUngapped) {
    for (const motif of session.motifList) {
      let regexStr;
      if (motif.type === "prosite") {
        try { regexStr = prositeToRegex(motif.pattern); } catch { continue; }
      } else {
        regexStr = motif.pattern;
      }
      try {
        const compiled = new RegExp(regexStr, "i");
        const matched = Object.entries(state.proteinSeqsUngapped)
          .filter(([, seq]) => compiled.test(seq))
          .map(([tip]) => tip)
          .sort();
        const color = MOTIF_PALETTE[state.motifList.length % MOTIF_PALETTE.length];
        state.motifList.push({ pattern: motif.pattern, type: motif.type, tipNames: matched, color });
      } catch { /* skip invalid patterns */ }
    }
    rebuildMotifMatches();
    buildMotifList();
  }

  // Restore heatmaps
  clearHeatmapDatasets();
  if (session.activeHeatmaps) {
    for (const heatmap of session.activeHeatmaps) {
      loadHeatmapDataset(heatmap.name, true, heatmap.visibleColumns || []);
    }
  }

  if (state.fullTreeData) {
    document.getElementById("subtree-bar").style.display = "";
    document.getElementById("sidebar-back-full-tree").style.display = "";
  }

  updateFilterBadge();
  buildLabelList();
  updateLabelInput();
  invalidateRenderCache();
  renderTree();
  document.getElementById("session-result").textContent = "Session loaded.";
}

function loadSessionV1(session, fromSetup) {
  if (fromSetup) {
    dom.setupError.textContent = "This is a v1 session. Please load your data files first using the folder/file picker, then load this session from the Session panel in the sidebar.";
    return;
  }
  if (!state.loaded) {
    document.getElementById("session-result").textContent = "Load data first, then load the v1 session to apply its settings.";
    return;
  }

  // Apply UI settings from v1 session to current data
  applySessionSettings(session);

  // Restore motifs locally
  state.motifList = [];
  if (session.motifList && state.proteinSeqsUngapped) {
    for (const motif of session.motifList) {
      let regexStr;
      if (motif.type === "prosite") {
        try { regexStr = prositeToRegex(motif.pattern); } catch { continue; }
      } else {
        regexStr = motif.pattern;
      }
      try {
        const compiled = new RegExp(regexStr, "i");
        const matched = Object.entries(state.proteinSeqsUngapped)
          .filter(([, seq]) => compiled.test(seq))
          .map(([tip]) => tip)
          .sort();
        const color = MOTIF_PALETTE[state.motifList.length % MOTIF_PALETTE.length];
        state.motifList.push({ pattern: motif.pattern, type: motif.type, tipNames: matched, color });
      } catch { /* skip */ }
    }
    rebuildMotifMatches();
    buildMotifList();
  }

  clearHeatmapDatasets();
  if (session.activeHeatmaps) {
    for (const heatmap of session.activeHeatmaps) {
      loadHeatmapDataset(heatmap.name, true, heatmap.visibleColumns || []);
    }
  }

  updateFilterBadge();
  buildLabelList();
  updateLabelInput();
  invalidateRenderCache();
  renderTree();
  document.getElementById("session-result").textContent = "V1 session settings applied.";
}

function applySessionSettings(session) {
  state.collapsedNodes = new Set(session.collapsedNodes || []);
  state.nodeLabels = session.nodeLabels || {};
  state.labelFontSize = session.labelFontSize ?? 10;
  state.exportNodeId = session.exportNodeId ?? null;
  state.selectedTip = session.selectedTip ?? null;
  state.hiddenTips = new Set(session.hiddenTips || []);
  state.layoutMode = session.layoutMode || "rectangular";
  state.usePhylogram = session.usePhylogram ?? true;
  state.showTipLabels = session.showTipLabels ?? true;
  state.showBootstraps = session.showBootstraps ?? false;
  state.showLengths = session.showLengths ?? false;
  state.fastMode = session.fastMode ?? false;
  state.uniformTriangles = session.uniformTriangles ?? false;
  state.triangleScale = session.triangleScale ?? 100;
  state.tipSpacing = session.tipSpacing ?? 16;
  state.tipLabelSize = session.tipLabelSize ?? 10;
  state.dotSize = session.dotSize ?? 3;
  state.scale = session.scale ?? 1;
  state.tx = session.tx ?? 20;
  state.ty = session.ty ?? 20;
  document.querySelector(`input[name="layout"][value="${state.layoutMode}"]`).checked = true;
  document.getElementById("phylogram-toggle").checked = state.usePhylogram;
  document.getElementById("tip-labels-toggle").checked = state.showTipLabels;
  document.getElementById("bootstrap-toggle").checked = state.showBootstraps;
  document.getElementById("length-toggle").checked = state.showLengths;
  document.getElementById("fast-mode-toggle").checked = state.fastMode;
  document.getElementById("uniform-triangles-toggle").checked = state.uniformTriangles;
  document.getElementById("triangle-size").value = state.triangleScale;
  document.getElementById("tip-spacing").value = state.tipSpacing;
  document.getElementById("tip-label-size").value = state.tipLabelSize;
  document.getElementById("dot-size").value = state.dotSize;
  document.getElementById("label-font-size").value = state.labelFontSize;

  if (session.checkedSpecies) {
    const checkSet = new Set(session.checkedSpecies);
    document.querySelectorAll("#species-list input").forEach(cb => {
      cb.checked = checkSet.has(cb.dataset.species);
    });
  }
  if (session.excludedSpecies) {
    const excludeSet = new Set(session.excludedSpecies);
    document.querySelectorAll("#exclude-species-list input").forEach(cb => {
      cb.checked = excludeSet.has(cb.dataset.excludeSpecies);
    });
  }

  if (session.nameSearch) {
    document.getElementById("name-input").value = session.nameSearch;
    searchName();
  }
}

// ---------------------------------------------------------------------------
// Export alignment (local, replacing fetch)
// ---------------------------------------------------------------------------

function doExport() {
  if (state.exportNodeId == null || !state.proteinSeqs) return;
  const resultEl = document.getElementById("export-result");

  const node = state.nodeById[state.exportNodeId];
  if (!node) return;
  let tips = collectAllTipNames(node);

  const extra = document.getElementById("export-extra-tips").value.trim();
  const extraList = extra ? extra.split(",").map(value => value.trim()).filter(Boolean) : [];
  if (extraList.length > 0) {
    const tipSet = new Set(state.allTipNames);
    const missing = extraList.filter(tip => !tipSet.has(tip));
    if (missing.length > 0) {
      resultEl.style.color = "#c0392b";
      resultEl.textContent = `Sequences not found: ${missing.join(", ")}`;
      return;
    }
    const existingSet = new Set(tips);
    for (const t of extraList) {
      if (!existingSet.has(t)) tips.push(t);
    }
  }

  let sliceStart = null;
  let sliceEnd = null;
  const mode = document.querySelector('input[name="export-range"]:checked').value;
  if (mode === "columns") {
    const start = parseInt(document.getElementById("export-col-start").value);
    const end = parseInt(document.getElementById("export-col-end").value);
    if (start) sliceStart = start - 1;
    if (end) sliceEnd = end;
  } else if (mode === "refseq") {
    const ref = document.getElementById("export-ref-seq").value.trim();
    const start = parseInt(document.getElementById("export-ref-start").value);
    const end = parseInt(document.getElementById("export-ref-end").value);
    if (ref && start && end && state.proteinSeqs[ref]) {
      const [cs, ce] = refPosToColumns(state.proteinSeqs[ref], start, end);
      if (cs == null || ce == null) {
        resultEl.style.color = "#c0392b";
        resultEl.textContent = "Reference positions out of range";
        return;
      }
      sliceStart = cs;
      sliceEnd = ce;
    }
  }

  const fasta = buildExportFasta(tips, state.proteinSeqs, sliceStart, sliceEnd);
  triggerDownload(
    new Blob([fasta], { type: "text/plain" }),
    `export_node${state.exportNodeId}.fasta`
  );
  resultEl.style.color = "#27ae60";
  resultEl.textContent = "Download started.";
}

// ---------------------------------------------------------------------------
// Export Newick (local, replacing fetch)
// ---------------------------------------------------------------------------

function exportNewick() {
  if (state.exportNodeId == null) return;
  const node = state.nodeById[state.exportNodeId];
  if (!node) return;
  const nwk = nodeToNewick(node) + ";";
  triggerDownload(
    new Blob([nwk], { type: "text/plain" }),
    `node${state.exportNodeId}.nwk`
  );
  const resultEl = document.getElementById("newick-result");
  resultEl.style.color = "#27ae60";
  resultEl.textContent = "Download started.";
}

async function copyNewick() {
  if (state.exportNodeId == null) return;
  const resultEl = document.getElementById("newick-result");
  const node = state.nodeById[state.exportNodeId];
  if (!node) return;
  const nwk = nodeToNewick(node) + ";";
  try {
    await navigator.clipboard.writeText(nwk);
    resultEl.style.color = "#27ae60";
    resultEl.textContent = "Copied to clipboard!";
  } catch {
    resultEl.style.color = "#c0392b";
    resultEl.textContent = "Copy failed.";
  }
}

// ---------------------------------------------------------------------------
// Image export (unchanged)
// ---------------------------------------------------------------------------

function exportSVG() {
  const resultEl = document.getElementById("export-viz-result");
  try {
    const { svgString } = buildExportSVGString();
    triggerDownload(new Blob([svgString], { type: "image/svg+xml;charset=utf-8" }), "phyloscope-tree.svg");
    resultEl.style.color = "#27ae60";
    resultEl.textContent = "SVG downloaded.";
  } catch (e) {
    resultEl.style.color = "#c0392b";
    resultEl.textContent = `Export failed: ${e.message}`;
  }
}

function exportPNG() {
  const resultEl = document.getElementById("export-viz-result");
  try {
    const { svgString, width, height } = buildExportSVGString();
    const svgBlob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(svgBlob);
    const img = new Image();
    img.onload = () => {
      const dpr = 2;
      const canvas = document.createElement("canvas");
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.scale(dpr, dpr);
      ctx.drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      canvas.toBlob(blob => {
        triggerDownload(blob, "phyloscope-tree.png");
        resultEl.style.color = "#27ae60";
        resultEl.textContent = "PNG downloaded.";
      }, "image/png");
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resultEl.style.color = "#c0392b";
      resultEl.textContent = "PNG rendering failed.";
    };
    img.src = url;
  } catch (e) {
    resultEl.style.color = "#c0392b";
    resultEl.textContent = `Export failed: ${e.message}`;
  }
}

async function exportPDF() {
  const resultEl = document.getElementById("export-viz-result");
  try {
    const { svgString, width, height } = buildExportSVGString();
    const { jsPDF } = window.jspdf;
    const landscape = width > height;
    const doc = new jsPDF({ orientation: landscape ? "landscape" : "portrait", unit: "pt", format: [width, height] });
    const parser = new DOMParser();
    const svgDoc = parser.parseFromString(svgString, "image/svg+xml");
    await doc.svg(svgDoc.documentElement, { x: 0, y: 0, width, height });
    doc.save("phyloscope-tree.pdf");
    resultEl.style.color = "#27ae60";
    resultEl.textContent = "PDF downloaded.";
  } catch (e) {
    resultEl.style.color = "#c0392b";
    resultEl.textContent = `PDF export failed: ${e.message}`;
  }
}

// ---------------------------------------------------------------------------
// File selection handling
// ---------------------------------------------------------------------------

function handleFilesSelected(files) {
  const detected = detectFiles(files);
  state.stagedFiles = { detected, allFiles: files };

  // Populate detected files panel
  dom.detectedFilesPanel.style.display = "";
  dom.setupLoadRow.style.display = "";
  dom.setupError.textContent = "";

  // Tree select
  const nwkSelect = dom.detectedNwkSelect;
  nwkSelect.innerHTML = "";
  if (detected.nwkFiles.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(no .nwk files found)";
    nwkSelect.appendChild(opt);
  } else {
    detected.nwkFiles.forEach(f => {
      const opt = document.createElement("option");
      opt.value = f.name;
      opt.textContent = f.name;
      nwkSelect.appendChild(opt);
    });
  }

  // Alignment select
  const aaSelect = dom.detectedAaSelect;
  aaSelect.innerHTML = "";
  const noneOpt = document.createElement("option");
  noneOpt.value = "";
  noneOpt.textContent = "None";
  aaSelect.appendChild(noneOpt);
  detected.aaFiles.forEach(f => {
    const opt = document.createElement("option");
    opt.value = f.name;
    opt.textContent = f.name;
    aaSelect.appendChild(opt);
  });
  if (detected.aaFiles.length > 0) {
    aaSelect.value = detected.aaFiles[0].name;
  }

  // Orthofinder
  dom.detectedOrthoSpan.textContent = detected.orthoFiles.length > 0
    ? `${detected.orthoFiles.length} species files found`
    : "no species files found";
  dom.detectedOrthoSpan.style.color = detected.orthoFiles.length > 0 ? "#27ae60" : "#888";

  // Datasets
  dom.detectedDatasetSpan.textContent = detected.datasetFiles.length > 0
    ? `${detected.datasetFiles.length} file${detected.datasetFiles.length === 1 ? "" : "s"} found`
    : "none found";
  dom.detectedDatasetSpan.style.color = detected.datasetFiles.length > 0 ? "#27ae60" : "#888";
}

// ---------------------------------------------------------------------------
// Setup load (local, replacing fetch)
// ---------------------------------------------------------------------------

async function doSetupLoad() {
  if (!state.stagedFiles) {
    dom.setupError.textContent = "Please select a folder or files first.";
    return;
  }

  const detected = state.stagedFiles.detected;
  const nwkName = dom.detectedNwkSelect.value;
  const aaName = dom.detectedAaSelect.value;

  if (!nwkName) {
    dom.setupError.textContent = "No tree file (.nwk) found. Please select a folder containing a .nwk file.";
    return;
  }

  const nwkFile = detected.nwkFiles.find(f => f.name === nwkName);
  const aaFile = aaName ? detected.aaFiles.find(f => f.name === aaName) : null;

  dom.setupError.textContent = "";
  dom.setupLoadBtn.disabled = true;
  dom.setupLoadBtn.textContent = "Loading...";

  try {
    const loadResult = await loadFromFiles({
      nwkFile,
      aaFile: aaFile || null,
      orthoFiles: detected.orthoFiles,
      datasetFiles: detected.datasetFiles,
    });

    if (!loadResult.success) {
      dom.setupError.textContent = loadResult.error;
      return;
    }

    applyLoadResult(loadResult.result);
    hideSetup();
    initAfterLoad();
  } catch (e) {
    dom.setupError.textContent = `Error: ${e.message}`;
  } finally {
    dom.setupLoadBtn.disabled = false;
    dom.setupLoadBtn.textContent = "Load";
  }
}

function applyLoadResult(result) {
  state.loaded = true;
  state.gene = result.gene;
  state.nwkName = result.nwkName;
  state.aaName = result.aaName;
  state.hasFasta = result.hasFasta;
  state.numSeqs = result.numSeqs;
  state.numSpecies = result.numSpecies;
  state.treeData = result.treeData;
  state.proteinSeqs = result.proteinSeqs;
  state.proteinSeqsUngapped = result.proteinSeqsUngapped;
  state.speciesMap = result.speciesToTips;
  state.tipToSpecies = result.tipToSpecies;
  state.tipLengths = result.tipLengths;
  state.sourceTexts = result.sourceTexts;
  state.datasetFiles = result.datasetFileNames;
  state.datasetTextsByName = {};
  if (result.sourceTexts && result.sourceTexts.datasets) {
    for (const d of result.sourceTexts.datasets) {
      state.datasetTextsByName[d.name] = d.text;
    }
  }
  state.parsedDatasets = {};
}

function initAfterLoad() {
  const speciesList = Object.keys(state.speciesMap).sort();
  speciesList.forEach((species, index) => {
    state.speciesColors[species] = PALETTE[index % PALETTE.length];
  });

  state.nodeById = {};
  state.parentMap = {};
  indexNodes(state.treeData);

  const totalTips = countAllTips(state.treeData);
  showLoadedInfo(totalTips);

  if (totalTips > 1000) {
    state.showTipLabels = false;
    document.getElementById("tip-labels-toggle").checked = false;
    state.fastMode = true;
    document.getElementById("fast-mode-toggle").checked = true;
  }

  buildSpeciesList(speciesList);
  buildExcludeSpeciesList(speciesList);
  setupControls();
  refreshDatasetList();

  if (totalTips > 2000 && state.fastMode && state.treeData.ch) {
    const targetLeaves = 50;
    const collapseThreshold = Math.max(20, Math.floor(totalTips / targetLeaves));
    const autoCollapse = node => {
      if (!node.ch || node.ch.length === 0) return;
      const tips = countAllTips(node);
      if (tips <= collapseThreshold && tips > 1) {
        state.collapsedNodes.add(node.id);
        return;
      }
      node.ch.forEach(autoCollapse);
    };
    state.treeData.ch.forEach(autoCollapse);
  }

  renderTree();
  loadTipDatalist();
  applyFastaState();
  buildLabelList();
  updateFilterBadge();
}

// ---------------------------------------------------------------------------
// Setup UI
// ---------------------------------------------------------------------------

function showSetup() {
  dom.setupOverlay.style.display = "flex";
  dom.detectedFilesPanel.style.display = "none";
  dom.setupLoadRow.style.display = "none";
  state.stagedFiles = null;
}

function hideSetup() {
  dom.setupOverlay.style.display = "none";
}

function bindStartupControls() {
  if (startupBound) return;
  startupBound = true;

  document.getElementById("reset-btn").addEventListener("click", () => {
    resetClientState();
    clearUiForReset();
    showSetup();
  });

  document.getElementById("setup-folder-btn").addEventListener("click", () => {
    dom.folderPicker.value = "";
    dom.folderPicker.click();
  });
  document.getElementById("setup-files-btn").addEventListener("click", () => {
    dom.filePicker.value = "";
    dom.filePicker.click();
  });
  dom.folderPicker.addEventListener("change", () => {
    if (dom.folderPicker.files.length > 0) {
      handleFilesSelected(dom.folderPicker.files);
    }
  });
  dom.filePicker.addEventListener("change", () => {
    if (dom.filePicker.files.length > 0) {
      handleFilesSelected(dom.filePicker.files);
    }
  });

  document.getElementById("setup-load-session").addEventListener("click", () => loadSession(true));
  dom.setupLoadBtn.addEventListener("click", doSetupLoad);

  document.getElementById("export-svg-btn").addEventListener("click", exportSVG);
  document.getElementById("export-png-btn").addEventListener("click", exportPNG);
  document.getElementById("export-pdf-btn").addEventListener("click", exportPDF);
  document.getElementById("export-btn").addEventListener("click", doExport);
  document.getElementById("export-newick-btn").addEventListener("click", exportNewick);
  document.getElementById("copy-newick-btn").addEventListener("click", copyNewick);
}

// ---------------------------------------------------------------------------
// Controls binding (unchanged)
// ---------------------------------------------------------------------------

function setupControls() {
  if (controlsBound) {
    updateUndoRedoButtons();
    return;
  }
  controlsBound = true;

  document.getElementById("phylogram-toggle").addEventListener("change", event => {
    state.usePhylogram = event.target.checked;
    renderTree();
  });
  document.getElementById("tip-spacing").addEventListener("input", event => {
    state.tipSpacing = +event.target.value;
    renderTree();
  });
  document.getElementById("tip-labels-toggle").addEventListener("change", event => {
    state.showTipLabels = event.target.checked;
    renderTree();
  });
  document.getElementById("tip-label-size").addEventListener("input", event => {
    state.tipLabelSize = +event.target.value;
    renderTree();
  });
  document.getElementById("dot-size").addEventListener("input", event => {
    state.dotSize = +event.target.value;
    invalidateRenderCache();
    renderTree();
  });
  document.getElementById("bootstrap-toggle").addEventListener("change", event => {
    state.showBootstraps = event.target.checked;
    renderTree();
  });
  document.getElementById("length-toggle").addEventListener("change", event => {
    state.showLengths = event.target.checked;
    renderTree();
  });
  document.getElementById("fast-mode-toggle").addEventListener("change", event => {
    state.fastMode = event.target.checked;
    invalidateRenderCache();
    renderTree();
  });
  document.getElementById("uniform-triangles-toggle").addEventListener("change", event => {
    state.uniformTriangles = event.target.checked;
    renderTree();
  });
  document.getElementById("triangle-size").addEventListener("input", event => {
    state.triangleScale = +event.target.value;
    renderTree();
  });
  document.querySelectorAll('input[name="layout"]').forEach(radio => {
    radio.addEventListener("change", event => {
      state.layoutMode = event.target.value;
      renderTree();
    });
  });
  document.getElementById("select-all-species").addEventListener("click", () => {
    document.querySelectorAll("#species-list input").forEach(cb => { cb.checked = true; });
    renderTree();
  });
  document.getElementById("select-none-species").addEventListener("click", () => {
    document.querySelectorAll("#species-list input").forEach(cb => { cb.checked = false; });
    renderTree();
  });
  document.getElementById("name-search").addEventListener("click", searchName);
  document.getElementById("name-input").addEventListener("keydown", event => {
    if (event.key === "Enter") searchName();
  });
  document.getElementById("motif-search").addEventListener("click", searchMotif);
  document.getElementById("motif-input").addEventListener("keydown", event => {
    if (event.key === "Enter") searchMotif();
  });
  const motifTypeEl = document.getElementById("motif-type");
  const motifInputEl = document.getElementById("motif-input");
  const motifHintEl = document.getElementById("motif-hint");
  const updateMotifPlaceholder = () => {
    if (motifTypeEl.value === "prosite") {
      motifInputEl.placeholder = "e.g. C-x(2,4)-C-x(3)-[LIVMFYWC]";
      motifHintEl.innerHTML =
        '<b>x</b> \u2014 any amino acid<br>' +
        '<b>[LIVM]</b> \u2014 one of L, I, V, or M<br>' +
        '<b>{PC}</b> \u2014 any AA except P or C<br>' +
        '<b>x(3)</b> \u2014 exactly 3 of any AA<br>' +
        '<b>x(2,4)</b> \u2014 2 to 4 of any AA';
    } else {
      motifInputEl.placeholder = "e.g. L.{2}L[KR] or C\\w{2,4}C";
      motifHintEl.innerHTML =
        '<b>.</b> \u2014 any amino acid<br>' +
        '<b>[KR]</b> \u2014 K or R<br>' +
        '<b>[^PC]</b> \u2014 any AA except P or C<br>' +
        '<b>.{3}</b> \u2014 exactly 3 of any AA<br>' +
        '<b>.{2,4}</b> \u2014 2 to 4 of any AA';
    }
  };
  motifTypeEl.addEventListener("change", updateMotifPlaceholder);
  updateMotifPlaceholder();

  document.getElementById("highlight-shared").addEventListener("click", highlightSharedNodes);
  document.getElementById("exclude-none").addEventListener("click", () => {
    document.querySelectorAll("#exclude-species-list input").forEach(cb => { cb.checked = false; });
  });
  document.getElementById("undo-btn").addEventListener("click", undo);
  document.getElementById("redo-btn").addEventListener("click", redo);
  document.addEventListener("keydown", event => {
    if ((event.ctrlKey || event.metaKey) && event.key === "z" && !event.shiftKey) {
      event.preventDefault();
      undo();
    }
    if ((event.ctrlKey || event.metaKey) && event.key === "Z" && event.shiftKey) {
      event.preventDefault();
      redo();
    }
    if ((event.ctrlKey || event.metaKey) && event.key === "y") {
      event.preventDefault();
      redo();
    }
  });

  document.getElementById("back-full-tree").addEventListener("click", restoreFullTree);
  document.getElementById("sidebar-back-full-tree").addEventListener("click", restoreFullTree);
  document.getElementById("filter-tips-btn").addEventListener("click", filterTipsByRegex);
  document.getElementById("filter-tips-input").addEventListener("keydown", event => {
    if (event.key === "Enter") filterTipsByRegex();
  });
  document.getElementById("filter-unchecked-btn").addEventListener("click", filterTipsUncheckedSpecies);
  document.getElementById("filter-show-all-btn").addEventListener("click", showAllTips);
  document.getElementById("set-label-btn").addEventListener("click", setNodeLabel);
  document.getElementById("node-label-input").addEventListener("keydown", event => {
    if (event.key === "Enter") setNodeLabel();
  });
  document.getElementById("label-font-size").addEventListener("input", event => {
    state.labelFontSize = +event.target.value;
    invalidateRenderCache();
    renderTree();
  });
  document.getElementById("pairwise-compare-btn").addEventListener("click", comparePairwise);
  document.getElementById("session-save-btn").addEventListener("click", saveSession);
  document.getElementById("session-load-btn").addEventListener("click", () => loadSession(false));
  document.getElementById("heatmap-load-btn").addEventListener("click", () => {
    const name = document.getElementById("heatmap-dataset-select").value;
    loadHeatmapDataset(name);
  });
  document.getElementById("heatmap-clear-all-btn").addEventListener("click", clearHeatmapDatasets);

  dom.svg.addEventListener("wheel", event => {
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
    const rect = dom.svg.getBoundingClientRect();
    const mx = event.clientX - rect.left;
    const my = event.clientY - rect.top;
    state.tx = mx - factor * (mx - state.tx);
    state.ty = my - factor * (my - state.ty);
    state.scale *= factor;
    applyTransform();
  }, { passive: false });
  dom.svg.addEventListener("mousedown", event => {
    if (event.button === 0) {
      state.dragging = true;
      state.dragStartX = event.clientX - state.tx;
      state.dragStartY = event.clientY - state.ty;
    }
  });
  window.addEventListener("mousemove", event => {
    if (!state.dragging) return;
    state.tx = event.clientX - state.dragStartX;
    state.ty = event.clientY - state.dragStartY;
    applyTransform();
  });
  window.addEventListener("mouseup", () => {
    state.dragging = false;
  });
  updateUndoRedoButtons();
}

// ---------------------------------------------------------------------------
// Tree click/hover handlers (unchanged)
// ---------------------------------------------------------------------------

function onTreeClick(event) {
  const el = event.target;
  const tipName = el.dataset?.tip;
  if (tipName) {
    if (event.ctrlKey && event.shiftKey) {
      const node = Object.values(state.nodeById).find(n => n.name === tipName);
      if (node) rerootAt(node.id);
      return;
    }
    if (event.shiftKey) {
      if (state.hasFasta) copyTipFasta(tipName);
      return;
    }
    copyTipName(tipName);
    return;
  }

  const nodeId = el.dataset?.nodeid;
  if (nodeId == null) return;
  const numericId = +nodeId;
  if (event.ctrlKey && event.shiftKey) {
    rerootAt(numericId);
    return;
  }
  if (event.ctrlKey) {
    openSubtree(numericId);
    return;
  }
  if (event.shiftKey) {
    pushUndo();
    if (state.collapsedNodes.has(numericId)) {
      state.collapsedNodes.delete(numericId);
    } else {
      state.collapsedNodes.add(numericId);
    }
    invalidateRenderCache();
    renderTree();
    return;
  }
  openExportPanel(numericId);
  if (state.hasFasta) copyNodeFasta(numericId);
}

function onTreeHover(event) {
  const el = event.target;
  if (el.dataset?.heatmap) {
    dom.tooltip.textContent = buildHeatmapTooltip(el);
    dom.tooltip.style.display = "block";
    dom.tooltip.style.left = `${event.clientX + 12}px`;
    dom.tooltip.style.top = `${event.clientY - 10}px`;
    return;
  }
  if (el.dataset?.tip) {
    dom.tooltip.textContent = buildTipTooltip(el.dataset.tip, el.dataset.species);
    dom.tooltip.style.display = "block";
    dom.tooltip.style.left = `${event.clientX + 12}px`;
    dom.tooltip.style.top = `${event.clientY - 10}px`;
    return;
  }
  if (el.dataset?.nodeid == null) return;
  let text = `Node #${el.dataset.nodeid}`;
  if (el.dataset.support != null) text += `\nSupport: ${el.dataset.support}`;
  text += state.hasFasta ? "\nClick: select & copy FASTA" : "\nClick: select node";
  text += "\nShift+click: collapse/expand\nCtrl+click: view subtree";
  dom.tooltip.textContent = text;
  dom.tooltip.style.display = "block";
  dom.tooltip.style.left = `${event.clientX + 12}px`;
  dom.tooltip.style.top = `${event.clientY - 10}px`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function initApp() {
  bindStartupControls();
  configureRenderer({ onTreeClick, onTreeHover });
  // No server check — always show setup dialog
  showSetup();
}

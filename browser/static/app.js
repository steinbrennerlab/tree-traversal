/* PhyloScope — lightweight phylogenetic tree viewer */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let treeData = null;
let speciesMap = {};        // species → [tipNames]
let tipToSpecies = {};      // tipName → species
let speciesColors = {};     // species → color
let nameMatches = new Set();
let motifMatches = new Set();
let sharedNodes = new Set();
let collapsedNodes = new Set();  // node IDs that are collapsed
let nodeById = {};          // id → node ref
let tipLengths = {};        // tipName → ungapped aa length
let selectedNodeTips = [];  // tips under the currently shift-clicked node
let motifList = [];         // [{pattern, type, tipNames, color}]
let showLengths = false;
let usePhylogram = true;
let tipSpacing = 16;
let layoutMode = "rectangular";  // "rectangular" | "circular" | "unrooted"
let showTipLabels = true;
let showBootstraps = false;
let uniformTriangles = false;
let triangleScale = 100;         // percentage slider for triangle size (10–200)
let exportNodeId = null;         // currently selected node for export
let allTipNames = [];            // cached for export validation
let fullTreeData = null;         // stores the original tree when viewing a subtree
let hasFasta = false;            // whether alignment data is available

// Pan / zoom state
let scale = 1, tx = 20, ty = 20;
let dragging = false, dragStartX = 0, dragStartY = 0;

const svg = document.getElementById("tree-svg");
const group = document.getElementById("tree-group");
const tooltip = document.getElementById("tooltip");

// ---------------------------------------------------------------------------
// Color palette (40 distinct colors for species)
// ---------------------------------------------------------------------------
const PALETTE = [
  "#e6194b","#3cb44b","#4363d8","#f58231","#911eb4",
  "#42d4f4","#f032e6","#bfef45","#fabed4","#469990",
  "#dcbeff","#9A6324","#fffac8","#800000","#aaffc3",
  "#808000","#ffd8b1","#000075","#a9a9a9","#e6beff",
  "#1abc9c","#d35400","#2c3e50","#8e44ad","#16a085",
  "#c0392b","#2980b9","#f39c12","#27ae60","#e74c3c",
  "#9b59b6","#1abc9c","#34495e","#e67e22","#3498db",
  "#2ecc71","#e91e63","#00bcd4","#ff9800","#795548",
];

// ---------------------------------------------------------------------------
// Motif color palette (distinct from species palette)
// ---------------------------------------------------------------------------
const MOTIF_PALETTE = [
  "#e22222","#2563eb","#16a085","#e67e22","#8e44ad",
  "#c0392b","#27ae60","#d35400","#2980b9","#f39c12",
];

function getMotifColors(tipName) {
  // Return array of colors from all motif entries that match this tip
  const colors = [];
  for (const entry of motifList) {
    if (entry.tipNames.includes(tipName)) colors.push(entry.color);
  }
  return colors;
}

function drawMotifPie(fragments, cx, cy, r, colors) {
  // Draw a pie-chart circle split evenly among the given colors
  if (colors.length === 1) {
    fragments.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${colors[0]}" class="tip-dot motif-match"/>`);
    return;
  }
  const n = colors.length;
  for (let i = 0; i < n; i++) {
    const a0 = (2 * Math.PI * i / n) - Math.PI / 2;
    const a1 = (2 * Math.PI * (i + 1) / n) - Math.PI / 2;
    const x0 = cx + r * Math.cos(a0);
    const y0 = cy + r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1);
    const y1 = cy + r * Math.sin(a1);
    const large = (a1 - a0 > Math.PI) ? 1 : 0;
    fragments.push(
      `<path d="M${cx},${cy} L${x0},${y0} A${r},${r} 0 ${large},1 ${x1},${y1} Z" fill="${colors[i]}" class="tip-dot motif-match"/>`
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function countLeaves(node) {
  if (collapsedNodes.has(node.id) && node.ch) return 1;
  if (!node.ch || node.ch.length === 0) return 1;
  let n = 0;
  for (const c of node.ch) n += countLeaves(c);
  return n;
}

function countAllTips(node) {
  if (!node.ch) return 1;
  let n = 0;
  for (const c of node.ch) n += countAllTips(c);
  return n;
}

function deepCopyNode(node) {
  const copy = { ...node };
  if (node.ch) copy.ch = node.ch.map(deepCopyNode);
  return copy;
}

function openSubtree(nodeId) {
  if (fullTreeData === null) fullTreeData = treeData;
  const subtreeCopy = deepCopyNode(nodeById[nodeId]);
  treeData = subtreeCopy;
  nodeById = {};
  indexNodes(treeData);
  collapsedNodes.clear();
  scale = 1; tx = 20; ty = 20;
  document.getElementById("subtree-bar").style.display = "";
  document.getElementById("sidebar-back-full-tree").style.display = "";
  renderTree();
}

function restoreFullTree() {
  treeData = fullTreeData;
  fullTreeData = null;
  nodeById = {};
  indexNodes(treeData);
  scale = 1; tx = 20; ty = 20;
  document.getElementById("subtree-bar").style.display = "none";
  document.getElementById("sidebar-back-full-tree").style.display = "none";
  renderTree();
}

function getNodeColor(node, checkedSpecies) {
  if (node.name && node.sp && checkedSpecies.has(node.sp))
    return speciesColors[node.sp] || "#333";
  return "#333";
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function init() {
  // Fetch status to get has_fasta flag
  const statusResp = await fetch("/api/status").then(r => r.json());
  hasFasta = !!statusResp.has_fasta;

  const fetches = [
    fetch("/api/tree").then(r => r.json()),
    fetch("/api/species").then(r => r.json()),
  ];
  if (hasFasta) fetches.push(fetch("/api/tip-lengths").then(r => r.json()));

  const results = await Promise.all(fetches);
  treeData = results[0];
  speciesMap = results[1].species_to_tips;
  tipLengths = hasFasta ? results[2] : {};

  for (const [sp, tips] of Object.entries(speciesMap)) {
    for (const t of tips) tipToSpecies[t] = sp;
  }

  const speciesList = results[1].species;
  speciesList.forEach((sp, i) => { speciesColors[sp] = PALETTE[i % PALETTE.length]; });

  indexNodes(treeData);

  // Auto-hide tip labels for large trees
  const totalTips = countAllTips(treeData);
  if (totalTips > 1000) {
    showTipLabels = false;
    document.getElementById("tip-labels-toggle").checked = false;
  }

  buildSpeciesList(speciesList);
  buildExcludeSpeciesList(speciesList);
  setupControls();
  renderTree();
  if (hasFasta) {
    loadTipDatalist();
  }
  applyFastaState();
}

function applyFastaState() {
  // Disable/enable sequence-dependent UI based on hasFasta
  const motifInput = document.getElementById("motif-input");
  const motifSearch = document.getElementById("motif-search");
  const motifType = document.getElementById("motif-type");
  const lengthToggle = document.getElementById("length-toggle");
  const motifHint = document.getElementById("motif-hint");
  const exportSection = document.getElementById("export-section");
  const exportInfo = document.getElementById("export-info");
  const exportForm = document.getElementById("export-form");

  const subtreeHint = document.getElementById("subtree-hint");

  if (!hasFasta) {
    motifInput.disabled = true;
    motifSearch.disabled = true;
    motifType.disabled = true;
    motifInput.placeholder = "No alignment loaded";
    motifHint.textContent = "No alignment loaded";
    lengthToggle.disabled = true;
    lengthToggle.checked = false;
    showLengths = false;
    exportInfo.textContent = "No alignment loaded";
    exportForm.style.display = "none";
    subtreeHint.innerHTML = "Click: select node<br>Shift+click: collapse/expand<br>Ctrl+click: view subtree in isolation";
  } else {
    motifInput.disabled = false;
    motifSearch.disabled = false;
    motifType.disabled = false;
    lengthToggle.disabled = false;
    subtreeHint.innerHTML = "Click: select node &amp; copy FASTA<br>Shift+click: collapse/expand<br>Ctrl+click: view subtree in isolation";
  }
}

function indexNodes(node) {
  nodeById[node.id] = node;
  if (node.ch) node.ch.forEach(indexNodes);
}

// ---------------------------------------------------------------------------
// Species checklist UI
// ---------------------------------------------------------------------------
function buildSpeciesList(speciesList) {
  const container = document.getElementById("species-list");
  container.innerHTML = "";
  for (const sp of speciesList) {
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.dataset.species = sp;
    cb.addEventListener("change", renderTree);
    const swatch = document.createElement("span");
    swatch.className = "sp-swatch";
    swatch.style.background = speciesColors[sp];
    label.append(cb, swatch, ` ${sp}`);
    container.appendChild(label);
  }
}

function buildExcludeSpeciesList(speciesList) {
  const container = document.getElementById("exclude-species-list");
  container.innerHTML = "";
  for (const sp of speciesList) {
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.dataset.excludeSpecies = sp;
    const swatch = document.createElement("span");
    swatch.className = "sp-swatch";
    swatch.style.background = speciesColors[sp];
    label.append(cb, swatch, ` ${sp}`);
    container.appendChild(label);
  }
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
function setupControls() {
  document.getElementById("phylogram-toggle").addEventListener("change", e => {
    usePhylogram = e.target.checked;
    renderTree();
  });
  document.getElementById("tip-spacing").addEventListener("input", e => {
    tipSpacing = +e.target.value;
    renderTree();
  });
  document.getElementById("tip-labels-toggle").addEventListener("change", e => {
    showTipLabels = e.target.checked;
    renderTree();
  });
  document.getElementById("bootstrap-toggle").addEventListener("change", e => {
    showBootstraps = e.target.checked;
    renderTree();
  });
  document.getElementById("length-toggle").addEventListener("change", e => {
    showLengths = e.target.checked;
    renderTree();
  });
  document.getElementById("uniform-triangles-toggle").addEventListener("change", e => {
    uniformTriangles = e.target.checked;
    renderTree();
  });
  document.getElementById("triangle-size").addEventListener("input", e => {
    triangleScale = +e.target.value;
    renderTree();
  });

  // Layout radio buttons
  document.querySelectorAll('input[name="layout"]').forEach(radio => {
    radio.addEventListener("change", e => {
      layoutMode = e.target.value;
      renderTree();
    });
  });

  document.getElementById("select-all-species").addEventListener("click", () => {
    document.querySelectorAll("#species-list input").forEach(cb => cb.checked = true);
    renderTree();
  });
  document.getElementById("select-none-species").addEventListener("click", () => {
    document.querySelectorAll("#species-list input").forEach(cb => cb.checked = false);
    renderTree();
  });

  // Name search
  document.getElementById("name-search").addEventListener("click", searchName);
  document.getElementById("name-input").addEventListener("keydown", e => {
    if (e.key === "Enter") searchName();
  });

  // Motif search
  document.getElementById("motif-search").addEventListener("click", searchMotif);
  document.getElementById("motif-input").addEventListener("keydown", e => {
    if (e.key === "Enter") searchMotif();
  });
  const motifTypeEl = document.getElementById("motif-type");
  const motifInputEl = document.getElementById("motif-input");
  const motifHintEl = document.getElementById("motif-hint");
  function updateMotifPlaceholder() {
    if (motifTypeEl.value === "prosite") {
      motifInputEl.placeholder = "e.g. C-x(2,4)-C-x(3)-[LIVMFYWC]";
      motifHintEl.innerHTML =
        '<b>x</b> — any amino acid<br>' +
        '<b>[LIVM]</b> — one of L, I, V, or M<br>' +
        '<b>{PC}</b> — any AA except P or C<br>' +
        '<b>x(3)</b> — exactly 3 of any AA<br>' +
        '<b>x(2,4)</b> — 2 to 4 of any AA';
    } else {
      motifInputEl.placeholder = "e.g. L.{2}L[KR] or C\\w{2,4}C";
      motifHintEl.innerHTML =
        '<b>.</b> — any amino acid<br>' +
        '<b>[KR]</b> — K or R<br>' +
        '<b>[^PC]</b> — any AA except P or C<br>' +
        '<b>.{3}</b> — exactly 3 of any AA<br>' +
        '<b>.{2,4}</b> — 2 to 4 of any AA';
    }
  }
  motifTypeEl.addEventListener("change", updateMotifPlaceholder);
  updateMotifPlaceholder();

  // Shared nodes
  document.getElementById("highlight-shared").addEventListener("click", highlightSharedNodes);

  // Exclude species reset
  document.getElementById("exclude-none").addEventListener("click", () => {
    document.querySelectorAll("#exclude-species-list input").forEach(cb => cb.checked = false);
  });

  // Subtree back buttons
  document.getElementById("back-full-tree").addEventListener("click", restoreFullTree);
  document.getElementById("sidebar-back-full-tree").addEventListener("click", restoreFullTree);

  // Pan/zoom
  svg.addEventListener("wheel", e => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const rect = svg.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    tx = mx - factor * (mx - tx);
    ty = my - factor * (my - ty);
    scale *= factor;
    applyTransform();
  }, { passive: false });

  svg.addEventListener("mousedown", e => {
    if (e.button === 0) { dragging = true; dragStartX = e.clientX - tx; dragStartY = e.clientY - ty; }
  });
  window.addEventListener("mousemove", e => {
    if (dragging) { tx = e.clientX - dragStartX; ty = e.clientY - dragStartY; applyTransform(); }
  });
  window.addEventListener("mouseup", () => { dragging = false; });
}

function applyTransform() {
  group.setAttribute("transform", `translate(${tx},${ty}) scale(${scale})`);
}

// ---------------------------------------------------------------------------
// Name search (client-side regex against tip names)
// ---------------------------------------------------------------------------
function searchName() {
  const query = document.getElementById("name-input").value.trim();
  const listEl = document.getElementById("name-matches-list");
  if (!query) { nameMatches = new Set(); listEl.textContent = ""; renderTree(); return; }
  try {
    const re = new RegExp(query, "i");
    // Collect all tip names from tree
    const allTips = [];
    function collectTips(n) {
      if (!n.ch || n.ch.length === 0) allTips.push(n.name);
      else n.ch.forEach(collectTips);
    }
    collectTips(treeData);
    const matched = allTips.filter(name => re.test(name));
    nameMatches = new Set(matched);
    document.getElementById("name-result").textContent = `${nameMatches.size} tips matched`;
    // Show up to 10 matching names
    const shown = matched.slice(0, 10);
    listEl.textContent = shown.join("\n") + (matched.length > 10 ? `\n... and ${matched.length - 10} more` : "");
  } catch (e) {
    document.getElementById("name-result").textContent = `Invalid regex: ${e.message}`;
    nameMatches = new Set();
    listEl.textContent = "";
  }
  renderTree();
}

// ---------------------------------------------------------------------------
// Motif search
// ---------------------------------------------------------------------------
async function searchMotif() {
  const pattern = document.getElementById("motif-input").value.trim();
  if (!pattern) return;
  const type = document.getElementById("motif-type").value;
  const resp = await fetch(`/api/motif?pattern=${encodeURIComponent(pattern)}&type=${type}`);
  const data = await resp.json();
  const el = document.getElementById("motif-result");
  if (data.error) {
    el.textContent = data.error;
    return;
  }
  const tipNames = data.matched_tips || [];
  const color = MOTIF_PALETTE[motifList.length % MOTIF_PALETTE.length];
  motifList.push({ pattern, type, tipNames, color });
  rebuildMotifMatches();
  buildMotifList();
  el.textContent = `${tipNames.length} tips matched`;
  renderTree();
}

function rebuildMotifMatches() {
  motifMatches = new Set();
  for (const entry of motifList) {
    for (const t of entry.tipNames) motifMatches.add(t);
  }
}

function buildMotifList() {
  const container = document.getElementById("motif-list");
  container.innerHTML = "";
  for (let i = 0; i < motifList.length; i++) {
    const entry = motifList[i];
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

    // Per-node count and matching names if a node is selected
    let inNodeTips = [];
    if (selectedNodeTips.length > 0) {
      const nodeSet = new Set(selectedNodeTips);
      inNodeTips = entry.tipNames.filter(t => nodeSet.has(t));
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
      motifList.splice(i, 1);
      rebuildMotifMatches();
      buildMotifList();
      renderTree();
    });
    row.appendChild(removeBtn);

    container.appendChild(row);

    // Show first 10 matching tip names under this entry when a node is selected
    if (inNodeTips.length > 0) {
      const tipsList = document.createElement("div");
      tipsList.className = "motif-tips-list";
      const shown = inNodeTips.slice(0, 10);
      tipsList.textContent = shown.join("\n") + (inNodeTips.length > 10 ? `\n... and ${inNodeTips.length - 10} more` : "");
      container.appendChild(tipsList);
    }
  }
}

// ---------------------------------------------------------------------------
// Shared nodes highlighting
// ---------------------------------------------------------------------------
function updateSpeciesCounts() {
  const labels = document.querySelectorAll("#species-list label");
  const counts = {};
  for (const tip of selectedNodeTips) {
    const sp = tipToSpecies[tip];
    if (sp) counts[sp] = (counts[sp] || 0) + 1;
  }
  for (const label of labels) {
    const cb = label.querySelector("input");
    const sp = cb.dataset.species;
    let badge = label.querySelector(".sp-count");
    if (selectedNodeTips.length > 0 && counts[sp]) {
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "sp-count";
        label.appendChild(badge);
      }
      badge.textContent = counts[sp];
    } else if (badge) {
      badge.remove();
    }
  }
}

async function highlightSharedNodes() {
  const checked = [...document.querySelectorAll("#species-list input:checked")].map(cb => cb.dataset.species);
  if (checked.length === 0) {
    document.getElementById("shared-result").textContent = "Select at least one species";
    return;
  }
  const excluded = [...document.querySelectorAll("#exclude-species-list input:checked")].map(cb => cb.dataset.excludeSpecies);
  const params = checked.map(s => `species=${encodeURIComponent(s)}`).join("&")
    + (excluded.length ? "&" + excluded.map(s => `exclude=${encodeURIComponent(s)}`).join("&") : "");
  const resp = await fetch(`/api/nodes-by-species?${params}`);
  const data = await resp.json();
  sharedNodes = new Set(data.highlighted_nodes || []);
  document.getElementById("shared-result").textContent = `${sharedNodes.size} nodes highlighted`;
  renderTree();
}

// ===========================================================================
// RENDERING — dispatch by layout mode
// ===========================================================================
function renderTree() {
  if (!treeData) return;
  const checkedSpecies = new Set(
    [...document.querySelectorAll("#species-list input:checked")].map(cb => cb.dataset.species)
  );
  const fragments = [];

  if (layoutMode === "rectangular") {
    renderRectangular(fragments, checkedSpecies);
  } else if (layoutMode === "circular") {
    renderCircular(fragments, checkedSpecies);
  } else {
    renderUnrooted(fragments, checkedSpecies);
  }

  group.innerHTML = fragments.join("\n");
  group.addEventListener("click", onTreeClick);
  group.addEventListener("mouseover", onTreeHover);
  group.addEventListener("mouseout", () => { tooltip.style.display = "none"; });

  // Center circular/unrooted layouts
  if (layoutMode !== "rectangular" && scale === 1 && tx === 20 && ty === 20) {
    const rect = svg.getBoundingClientRect();
    tx = rect.width / 2;
    ty = rect.height / 2;
  }
  applyTransform();
}

// ===========================================================================
// RECTANGULAR layout (original)
// ===========================================================================
function renderRectangular(fragments, checkedSpecies) {
  let leafIndex = 0;
  const xScale = usePhylogram ? 800 : 0;

  function layout(node, depth) {
    const bl = node.bl || 0;
    const x = usePhylogram ? depth + bl * xScale : depth + 20;

    if (collapsedNodes.has(node.id) && node.ch) {
      const tipCount = countAllTips(node);
      const triH = (uniformTriangles ? 30 : Math.min(tipCount * 2, 40)) * triangleScale / 100;
      const slotsNeeded = Math.max(1, Math.ceil(triH / tipSpacing));
      const y = (leafIndex + slotsNeeded / 2) * tipSpacing;
      leafIndex += slotsNeeded;
      return { ...node, x, parentX: depth, y, collapsed: true, tipCount };
    }
    if (!node.ch || node.ch.length === 0) {
      const y = leafIndex * tipSpacing;
      leafIndex++;
      return { ...node, x, parentX: depth, y };
    }
    const children = node.ch.map(c => layout(c, x));
    const y = (children[0].y + children[children.length - 1].y) / 2;
    return { ...node, x, parentX: depth, y, layoutChildren: children };
  }

  const root = layout(treeData, 0);

  function draw(node) {
    const px = node.parentX, nx = node.x, ny = node.y;
    const color = getNodeColor(node, checkedSpecies);

    fragments.push(`<line x1="${px}" y1="${ny}" x2="${nx}" y2="${ny}" stroke="${color}" stroke-width="1"/>`);

    if (node.collapsed) {
      const triH = (uniformTriangles ? 30 : Math.min(node.tipCount * 2, 40)) * triangleScale / 100;
      const triW = 30 * triangleScale / 100;
      fragments.push(
        `<polygon points="${nx},${ny} ${nx + triW},${ny - triH / 2} ${nx + triW},${ny + triH / 2}" class="collapsed-triangle" data-nodeid="${node.id}"/>` +
        `<text x="${nx + triW + 4}" y="${ny + 3}" font-size="9" fill="#666">${node.tipCount} tips</text>`
      );
      return;
    }
    if (node.layoutChildren) {
      const firstY = node.layoutChildren[0].y;
      const lastY = node.layoutChildren[node.layoutChildren.length - 1].y;
      fragments.push(`<line x1="${nx}" y1="${firstY}" x2="${nx}" y2="${lastY}" stroke="#999" stroke-width="1"/>`);
      drawNodeDot(fragments, nx, ny, node);
      node.layoutChildren.forEach(draw);
    } else {
      drawTipDot(fragments, nx, ny, node, checkedSpecies);
      if (showTipLabels) drawTipLabel(fragments, nx + 4, ny + 3, 0, node, checkedSpecies);
    }
  }
  draw(root);
}

// ===========================================================================
// CIRCULAR layout
// ===========================================================================
function renderCircular(fragments, checkedSpecies) {
  const totalLeaves = countLeaves(treeData);
  const rScale = usePhylogram ? 300 : 0;
  const rStep = usePhylogram ? 0 : 15;
  let leafIndex = 0;

  // Layout: assign angle (from leaf index) and radius (from depth)
  function layout(node, depth) {
    const bl = node.bl || 0;
    const r = usePhylogram ? depth + bl * rScale : depth + rStep;

    if (collapsedNodes.has(node.id) && node.ch) {
      const angle = (leafIndex / totalLeaves) * 2 * Math.PI;
      leafIndex++;
      const tipCount = countAllTips(node);
      return { ...node, r, parentR: depth, angle, collapsed: true, tipCount };
    }
    if (!node.ch || node.ch.length === 0) {
      const angle = (leafIndex / totalLeaves) * 2 * Math.PI;
      leafIndex++;
      return { ...node, r, parentR: depth, angle };
    }
    const children = node.ch.map(c => layout(c, r));
    // Node angle = midpoint of children's angular range
    const angle = (children[0].angle + children[children.length - 1].angle) / 2;
    return { ...node, r, parentR: depth, angle, layoutChildren: children };
  }

  const root = layout(treeData, 0);

  function toXY(r, angle) {
    return [r * Math.cos(angle), r * Math.sin(angle)];
  }

  function draw(node) {
    const [nx, ny] = toXY(node.r, node.angle);
    const [px, py] = toXY(node.parentR, node.angle);
    const color = getNodeColor(node, checkedSpecies);

    // Radial line (branch)
    fragments.push(`<line x1="${px}" y1="${py}" x2="${nx}" y2="${ny}" stroke="${color}" stroke-width="1"/>`);

    if (node.collapsed) {
      // Collapsed wedge
      const wedgeR = node.r + 20 * triangleScale / 100;
      const halfArc = (uniformTriangles ? 0.2 : Math.min(node.tipCount * 0.01, 0.3)) * triangleScale / 100;
      const [wx1, wy1] = toXY(wedgeR, node.angle - halfArc);
      const [wx2, wy2] = toXY(wedgeR, node.angle + halfArc);
      const large = halfArc * 2 > Math.PI ? 1 : 0;
      fragments.push(
        `<path d="M${nx},${ny} L${wx1},${wy1} A${wedgeR},${wedgeR} 0 ${large},1 ${wx2},${wy2} Z" class="collapsed-triangle" data-nodeid="${node.id}"/>` +
        `<text x="${(wx1 + wx2) / 2 + 4}" y="${(wy1 + wy2) / 2}" font-size="9" fill="#666">${node.tipCount}</text>`
      );
      return;
    }
    if (node.layoutChildren) {
      // Arc connecting children at this node's radius
      const a1 = node.layoutChildren[0].angle;
      const a2 = node.layoutChildren[node.layoutChildren.length - 1].angle;
      const [ax1, ay1] = toXY(node.r, a1);
      const [ax2, ay2] = toXY(node.r, a2);
      const sweep = a2 - a1;
      const large = sweep > Math.PI ? 1 : 0;
      fragments.push(
        `<path d="M${ax1},${ay1} A${node.r},${node.r} 0 ${large},1 ${ax2},${ay2}" fill="none" stroke="#999" stroke-width="1"/>`
      );
      drawNodeDot(fragments, nx, ny, node);
      node.layoutChildren.forEach(draw);
    } else {
      // Tip label — rotate to match angle
      const deg = (node.angle * 180 / Math.PI);
      const flip = (deg > 90 && deg < 270) || (deg < -90 && deg > -270);
      const textAngle = flip ? deg + 180 : deg;
      const anchor = flip ? "end" : "start";
      const lx = nx + (flip ? -4 : 4) * Math.cos(node.angle);
      const ly = ny + (flip ? -4 : 4) * Math.sin(node.angle);
      drawTipDot(fragments, nx, ny, node, checkedSpecies);
      if (showTipLabels) drawTipLabelRadial(fragments, lx, ly, textAngle, anchor, node, checkedSpecies);
    }
  }
  draw(root);
}

// ===========================================================================
// UNROOTED layout (equal-angle / Felsenstein)
// ===========================================================================
function renderUnrooted(fragments, checkedSpecies) {
  const totalLeaves = countLeaves(treeData);
  const blScale = usePhylogram ? 300 : 0;
  const blStep = usePhylogram ? 0 : 20;

  // Assign each node: x, y, parentX, parentY, angle (for label rotation)
  function layout(node, px, py, startAngle, wedge, depth) {
    const bl = node.bl || 0;
    const len = usePhylogram ? bl * blScale : blStep;
    const midAngle = startAngle + wedge / 2;
    const nx = px + len * Math.cos(midAngle);
    const ny = py + len * Math.sin(midAngle);

    if (collapsedNodes.has(node.id) && node.ch) {
      const tipCount = countAllTips(node);
      return { ...node, x: nx, y: ny, parentX: px, parentY: py, angle: midAngle, collapsed: true, tipCount, wedge };
    }
    if (!node.ch || node.ch.length === 0) {
      return { ...node, x: nx, y: ny, parentX: px, parentY: py, angle: midAngle };
    }

    // Divide wedge among children proportional to leaf count
    const childLeafCounts = node.ch.map(c => countLeaves(c));
    const totalChildLeaves = childLeafCounts.reduce((a, b) => a + b, 0);
    let curAngle = startAngle;
    const children = node.ch.map((c, i) => {
      const childWedge = (childLeafCounts[i] / totalChildLeaves) * wedge;
      const result = layout(c, nx, ny, curAngle, childWedge, depth + 1);
      curAngle += childWedge;
      return result;
    });

    return { ...node, x: nx, y: ny, parentX: px, parentY: py, angle: midAngle, layoutChildren: children };
  }

  const root = layout(treeData, 0, 0, 0, 2 * Math.PI, 0);

  function draw(node) {
    const color = getNodeColor(node, checkedSpecies);

    // Line from parent to this node
    fragments.push(`<line x1="${node.parentX}" y1="${node.parentY}" x2="${node.x}" y2="${node.y}" stroke="${color}" stroke-width="1"/>`);

    if (node.collapsed) {
      // Draw wedge fan
      const fanLen = 20 * triangleScale / 100;
      const halfW = (uniformTriangles ? 0.2 : Math.min(node.tipCount * 0.01, 0.3)) * triangleScale / 100;
      const x1 = node.x + fanLen * Math.cos(node.angle - halfW);
      const y1 = node.y + fanLen * Math.sin(node.angle - halfW);
      const x2 = node.x + fanLen * Math.cos(node.angle + halfW);
      const y2 = node.y + fanLen * Math.sin(node.angle + halfW);
      fragments.push(
        `<polygon points="${node.x},${node.y} ${x1},${y1} ${x2},${y2}" class="collapsed-triangle" data-nodeid="${node.id}"/>` +
        `<text x="${(x1 + x2) / 2 + 2}" y="${(y1 + y2) / 2}" font-size="9" fill="#666">${node.tipCount}</text>`
      );
      return;
    }
    if (node.layoutChildren) {
      drawNodeDot(fragments, node.x, node.y, node);
      node.layoutChildren.forEach(draw);
    } else {
      // Tip label
      const deg = node.angle * 180 / Math.PI;
      const flip = (deg > 90 && deg < 270) || (deg < -90 && deg > -270);
      const textAngle = flip ? deg + 180 : deg;
      const anchor = flip ? "end" : "start";
      const offset = 4;
      const lx = node.x + offset * Math.cos(node.angle);
      const ly = node.y + offset * Math.sin(node.angle);
      drawTipDot(fragments, node.x, node.y, node, checkedSpecies);
      if (showTipLabels) drawTipLabelRadial(fragments, lx, ly, textAngle, anchor, node, checkedSpecies);
    }
  }
  draw(root);
}

// ===========================================================================
// Shared drawing helpers
// ===========================================================================
function drawNodeDot(fragments, cx, cy, node) {
  const isSelected = node.id === exportNodeId;
  const isShared = sharedNodes.has(node.id);
  const r = isSelected ? 6 : isShared ? 5 : 3;
  const fill = isSelected ? '#000' : isShared ? '#ff6600' : '#999';
  const cls = isSelected ? 'node-dot selected-node' : isShared ? 'node-dot shared-node' : 'node-dot';
  fragments.push(
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" class="${cls}"
      data-nodeid="${node.id}"
      ${node.sup != null ? `data-support="${node.sup}"` : ""}/>`
  );
  if (showBootstraps && node.sup != null) {
    fragments.push(
      `<text x="${cx + 6}" y="${cy - 5}" class="bootstrap-label">${node.sup}</text>`
    );
  }
}

function drawTipDot(fragments, cx, cy, node, checkedSpecies) {
  const isMotif = motifMatches.has(node.name);
  const isName = nameMatches.has(node.name);
  const spColor = getNodeColor(node, checkedSpecies);
  const r = (isMotif || isName || spColor !== "#333") ? 3 : 2;
  if (isMotif) {
    const colors = getMotifColors(node.name);
    if (colors.length > 0) {
      drawMotifPie(fragments, cx, cy, r, colors);
      return;
    }
  }
  const color = isName ? "#2563eb" : spColor;
  fragments.push(
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" class="tip-dot"
      data-tip="${node.name}" data-species="${node.sp || ''}"/>`
  );
}

function drawTipLabel(fragments, x, y, rotation, node, checkedSpecies) {
  const isMotif = motifMatches.has(node.name);
  const isName = nameMatches.has(node.name);
  const highlight = isMotif || isName;
  const motifColors = isMotif ? getMotifColors(node.name) : [];
  const color = isMotif && motifColors.length > 0 ? motifColors[0] : isName ? "#2563eb" : getNodeColor(node, checkedSpecies);
  const bold = highlight ? ' font-weight="bold"' : "";
  const transform = rotation ? ` transform="rotate(${rotation},${x},${y})"` : "";
  let label = node.name;
  if (showLengths && tipLengths[node.name] != null) label += ` (${tipLengths[node.name]} aa)`;
  fragments.push(
    `<text x="${x}" y="${y}" class="tip-label" fill="${color}"${bold}${transform}
      data-tip="${node.name}" data-species="${node.sp || ''}">${label}</text>`
  );
  if (isMotif && motifColors.length > 0) {
    drawMotifPie(fragments, x - 4, y - 3, 3, motifColors);
  }
  if (isName) {
    fragments.push(`<circle cx="${x - 4}" cy="${y - 3}" r="3" fill="#2563eb" stroke="#1d4ed8" stroke-width="1"/>`);
  }
}

function drawTipLabelRadial(fragments, x, y, angleDeg, anchor, node, checkedSpecies) {
  const isMotif = motifMatches.has(node.name);
  const isName = nameMatches.has(node.name);
  const highlight = isMotif || isName;
  const motifColors = isMotif ? getMotifColors(node.name) : [];
  const color = isMotif && motifColors.length > 0 ? motifColors[0] : isName ? "#2563eb" : getNodeColor(node, checkedSpecies);
  const bold = highlight ? ' font-weight="bold"' : "";
  let label = node.name;
  if (showLengths && tipLengths[node.name] != null) label += ` (${tipLengths[node.name]} aa)`;
  fragments.push(
    `<text x="${x}" y="${y}" class="tip-label" fill="${color}"${bold}
      text-anchor="${anchor}" transform="rotate(${angleDeg},${x},${y})"
      data-tip="${node.name}" data-species="${node.sp || ''}">${label}</text>`
  );
  if (isMotif && motifColors.length > 0) {
    const rad = angleDeg * Math.PI / 180;
    const mx = x - 6 * Math.cos(rad);
    const my = y - 6 * Math.sin(rad);
    drawMotifPie(fragments, mx, my, 3, motifColors);
  }
  if (isName) {
    const rad = angleDeg * Math.PI / 180;
    const mx = x - 6 * Math.cos(rad);
    const my = y - 6 * Math.sin(rad);
    fragments.push(`<circle cx="${mx}" cy="${my}" r="3" fill="#2563eb" stroke="#1d4ed8" stroke-width="1"/>`);
  }
}

// ---------------------------------------------------------------------------
// Interaction handlers
// ---------------------------------------------------------------------------
function onTreeClick(e) {
  const el = e.target;

  // Tip click — copy ungapped FASTA to clipboard (if alignment loaded)
  const tipName = el.dataset?.tip;
  if (tipName) {
    if (hasFasta) copyTipFasta(tipName);
    return;
  }

  const nodeId = el.dataset?.nodeid;
  if (nodeId != null) {
    const nid = +nodeId;
    if (e.ctrlKey) {
      openSubtree(nid);
      return;
    }
    if (e.shiftKey) {
      if (collapsedNodes.has(nid)) collapsedNodes.delete(nid);
      else collapsedNodes.add(nid);
      renderTree();
      return;
    }
    // Plain click — select node, copy aligned FASTA if available
    openExportPanel(nid);
    if (hasFasta) copyNodeFasta(nid);
  }
}

async function copyNodeFasta(nodeId) {
  try {
    const resp = await fetch(`/api/export?node_id=${nodeId}`);
    const fasta = await resp.text();
    await navigator.clipboard.writeText(fasta);
    tooltip.textContent = `Aligned FASTA copied (node #${nodeId})`;
    tooltip.style.display = "block";
  } catch (e) {
    tooltip.textContent = "Copy failed";
    tooltip.style.display = "block";
  }
}

async function copyTipFasta(tipName) {
  try {
    const resp = await fetch(`/api/tip-seq?name=${encodeURIComponent(tipName)}`);
    const data = await resp.json();
    if (data.error) return;
    const fasta = `>${data.name}\n${data.seq}`;
    await navigator.clipboard.writeText(fasta);
    tooltip.textContent = "Copied to clipboard!";
  } catch (e) {
    tooltip.textContent = "Copy failed";
  }
}

function buildTipTooltip(tipName, species) {
  const lines = [tipName];
  lines.push(`Species: ${species || "unknown"}`);
  if (hasFasta) {
    const len = tipLengths[tipName];
    if (len != null) lines.push(`Length: ${len} aa`);
    // Matching motifs
    const matching = motifList.filter(m => m.tipNames.includes(tipName));
    if (matching.length > 0) {
      lines.push(`Motifs: ${matching.map(m => m.pattern).join(", ")}`);
    }
    lines.push("Click to copy FASTA");
  }
  return lines.join("\n");
}

function onTreeHover(e) {
  const el = e.target;
  if (el.dataset?.tip) {
    tooltip.textContent = buildTipTooltip(el.dataset.tip, el.dataset.species);
    tooltip.style.display = "block";
    tooltip.style.left = (e.clientX + 12) + "px";
    tooltip.style.top = (e.clientY - 10) + "px";
  } else if (el.dataset?.nodeid != null) {
    let text = `Node #${el.dataset.nodeid}`;
    if (el.dataset.support != null) text += `\nSupport: ${el.dataset.support}`;
    text += hasFasta ? "\nClick: select & copy FASTA" : "\nClick: select node";
    text += "\nShift+click: collapse/expand\nCtrl+click: view subtree";
    tooltip.textContent = text;
    tooltip.style.display = "block";
    tooltip.style.left = (e.clientX + 12) + "px";
    tooltip.style.top = (e.clientY - 10) + "px";
  }
}

// ---------------------------------------------------------------------------
// Export panel
// ---------------------------------------------------------------------------
async function openExportPanel(nodeId) {
  exportNodeId = nodeId;
  document.getElementById("export-form").style.display = "";

  const resp = await fetch(`/api/node-tips?node_id=${nodeId}`);
  const data = await resp.json();
  const tips = data.tips || [];
  selectedNodeTips = tips;

  updateSpeciesCounts();
  buildMotifList();  // refresh per-node counts
  renderTree();      // re-render to show selected node dot

  document.getElementById("export-info").textContent =
    `Node #${nodeId} — ${tips.length} tip${tips.length !== 1 ? "s" : ""}`;
  document.getElementById("export-tips-summary").textContent =
    `Tip names (${tips.length})`;

  const listEl = document.getElementById("export-tips-list");
  listEl.textContent = tips.join("\n");

  // Reset form
  document.getElementById("export-extra-tips").value = "";
  document.querySelector('input[name="export-range"][value="full"]').checked = true;
  document.getElementById("export-col-start").value = "";
  document.getElementById("export-col-end").value = "";
  document.getElementById("export-ref-seq").value = "";
  document.getElementById("export-ref-start").value = "";
  document.getElementById("export-ref-end").value = "";
  document.getElementById("export-result").textContent = "";

  // Scroll panel into view
  document.getElementById("export-section").scrollIntoView({ behavior: "smooth" });
}

async function loadTipDatalist() {
  const resp = await fetch("/api/tip-names");
  const data = await resp.json();
  allTipNames = data.tips || [];
  const dl = document.getElementById("tip-datalist");
  dl.innerHTML = "";
  for (const t of allTipNames) {
    const opt = document.createElement("option");
    opt.value = t;
    dl.appendChild(opt);
  }
}

function doExport() {
  if (exportNodeId == null) return;

  const params = new URLSearchParams();
  params.set("node_id", exportNodeId);
  const resultEl = document.getElementById("export-result");

  // Extra tips — validate against known tip names
  const extra = document.getElementById("export-extra-tips").value.trim();
  const extraList = extra ? extra.split(",").map(s => s.trim()).filter(Boolean) : [];
  if (extraList.length > 0) {
    const tipSet = new Set(allTipNames);
    const missing = extraList.filter(t => !tipSet.has(t));
    if (missing.length > 0) {
      resultEl.style.color = "#c0392b";
      resultEl.textContent = `Sequences not found: ${missing.join(", ")}`;
      return;
    }
    for (const t of extraList) {
      params.append("extra_tips", t);
    }
  }

  // Range mode
  const mode = document.querySelector('input[name="export-range"]:checked').value;
  if (mode === "columns") {
    const s = document.getElementById("export-col-start").value;
    const e = document.getElementById("export-col-end").value;
    if (s) params.set("col_start", s);
    if (e) params.set("col_end", e);
  } else if (mode === "refseq") {
    const ref = document.getElementById("export-ref-seq").value.trim();
    const s = document.getElementById("export-ref-start").value;
    const e = document.getElementById("export-ref-end").value;
    if (ref) params.set("ref_seq", ref);
    if (s) params.set("ref_start", s);
    if (e) params.set("ref_end", e);
  }

  // Trigger download via a hidden link
  const url = `/api/export?${params.toString()}`;
  const a = document.createElement("a");
  a.href = url;
  a.download = `export_node${exportNodeId}.fasta`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  resultEl.style.color = "#27ae60";
  resultEl.textContent = "Download started.";
}

// ---------------------------------------------------------------------------
// Filesystem browser
// ---------------------------------------------------------------------------
const browserPanel = document.getElementById("setup-browser");
const browserDirList = document.getElementById("browser-dir-list");
const browserCurrentPath = document.getElementById("browser-current-path");
const browserUpBtn = document.getElementById("browser-up");
const browserSelectBtn = document.getElementById("browser-select");
const browserValidIndicator = document.getElementById("browser-valid-indicator");
let browserCurrentDir = null;
let browserParentDir = null;

async function browserNavigate(path) {
  const url = path ? `/api/browse?path=${encodeURIComponent(path)}` : "/api/browse";
  try {
    const resp = await fetch(url);
    const data = await resp.json();
    if (!resp.ok) {
      document.getElementById("setup-error").textContent = data.error || "Browse failed.";
      return;
    }
    browserCurrentDir = data.current;
    browserParentDir = data.parent;
    browserCurrentPath.textContent = data.current;
    browserUpBtn.disabled = !data.parent;

    const isValid = data.has_nwk;
    const hasAlignment = data.has_nwk && data.has_aa_fa;
    browserValidIndicator.textContent = hasAlignment
      ? "\u2714 Valid input folder (.nwk + .aa.fa found)"
      : data.has_nwk
        ? "\u2714 Tree found (.nwk) \u2014 no alignment (.aa.fa)"
        : "";
    browserValidIndicator.style.display = isValid ? "" : "none";
    browserSelectBtn.disabled = !isValid;

    browserDirList.innerHTML = "";
    if (data.dirs.length === 0) {
      const empty = document.createElement("div");
      empty.style.cssText = "padding:8px;font-size:12px;color:#888;text-align:center;";
      empty.textContent = "No subdirectories";
      browserDirList.appendChild(empty);
    } else {
      for (const dir of data.dirs) {
        const entry = document.createElement("div");
        entry.className = "browser-dir-entry";
        entry.textContent = dir;
        entry.addEventListener("click", () => browserNavigate(data.current + "/" + dir));
        browserDirList.appendChild(entry);
      }
    }
  } catch (e) {
    document.getElementById("setup-error").textContent = `Browse error: ${e.message}`;
  }
}

document.getElementById("setup-browse").addEventListener("click", () => {
  const isHidden = browserPanel.style.display === "none";
  browserPanel.style.display = isHidden ? "" : "none";
  if (isHidden) {
    const currentVal = document.getElementById("setup-path").value.trim();
    browserNavigate(currentVal || null);
  }
});

browserUpBtn.addEventListener("click", () => {
  if (browserParentDir) browserNavigate(browserParentDir);
});

browserSelectBtn.addEventListener("click", () => {
  if (browserCurrentDir) {
    document.getElementById("setup-path").value = browserCurrentDir;
    browserPanel.style.display = "none";
    scanFolder(browserCurrentDir);
  }
});

// ---------------------------------------------------------------------------
// Detected-files auto-scan
// ---------------------------------------------------------------------------
const detectedFilesPanel = document.getElementById("detected-files");
const detectedNwkInput = document.getElementById("detected-nwk");
const detectedAaInput = document.getElementById("detected-aa");
const detectedOrthoSpan = document.getElementById("detected-ortho");

async function scanFolder(dirPath) {
  if (!dirPath) { detectedFilesPanel.style.display = "none"; return; }
  try {
    const resp = await fetch(`/api/browse-files?path=${encodeURIComponent(dirPath)}`);
    if (!resp.ok) { detectedFilesPanel.style.display = "none"; return; }
    const data = await resp.json();
    detectedFilesPanel.style.display = "";

    // Pre-fill tree
    if (data.nwk_files.length > 0) {
      detectedNwkInput.value = data.nwk_files[0];
      detectedNwkInput.title = `Available: ${data.nwk_files.join(", ")}`;
    } else {
      detectedNwkInput.value = "";
    }

    // Pre-fill alignment
    if (data.aa_files.length > 0) {
      detectedAaInput.value = data.aa_files[0];
      detectedAaInput.title = `Available: ${data.aa_files.join(", ")}`;
      detectedAaInput.placeholder = "none found (optional)";
    } else {
      detectedAaInput.value = "";
      detectedAaInput.placeholder = "none found (optional)";
    }

    // Species mapping status
    detectedOrthoSpan.textContent = data.has_ortho
      ? "orthofinder-input/ found \u2713"
      : "orthofinder-input/ not found";
    detectedOrthoSpan.style.color = data.has_ortho ? "#27ae60" : "#888";
  } catch {
    detectedFilesPanel.style.display = "none";
  }
}

// ---------------------------------------------------------------------------
// Setup flow — check status, show dialog or go straight to init
// ---------------------------------------------------------------------------
const setupOverlay = document.getElementById("setup-overlay");
const setupPathInput = document.getElementById("setup-path");
const setupLoadBtn = document.getElementById("setup-load");
const setupError = document.getElementById("setup-error");

function showSetup() {
  setupOverlay.style.display = "flex";
}

function hideSetup() {
  setupOverlay.style.display = "none";
}

async function doSetupLoad() {
  const inputDir = setupPathInput.value.trim();
  if (!inputDir) {
    setupError.textContent = "Please enter a folder path.";
    return;
  }
  setupError.textContent = "";
  setupLoadBtn.disabled = true;
  setupLoadBtn.textContent = "Loading...";

  const payload = { input_dir: inputDir };
  // Pass explicit file selections if the detected-files panel is visible
  if (detectedFilesPanel.style.display !== "none") {
    const nwk = detectedNwkInput.value.trim();
    const aa = detectedAaInput.value.trim();
    if (nwk) payload.nwk_file = nwk;
    payload.aa_file = aa;  // empty string → skip alignment
  }

  try {
    const resp = await fetch("/api/load", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!resp.ok) {
      setupError.textContent = data.error || "Failed to load data.";
      return;
    }
    hideSetup();
    await init();
  } catch (e) {
    setupError.textContent = `Error: ${e.message}`;
  } finally {
    setupLoadBtn.disabled = false;
    setupLoadBtn.textContent = "Load";
  }
}

setupLoadBtn.addEventListener("click", async () => {
  // Ensure detected files are scanned before loading
  const path = setupPathInput.value.trim();
  if (path && detectedFilesPanel.style.display === "none") {
    await scanFolder(path);
  }
  doSetupLoad();
});
setupPathInput.addEventListener("keydown", async e => {
  if (e.key === "Enter") {
    await scanFolder(setupPathInput.value.trim());
    doSetupLoad();
  }
});
// Trigger scan when path input loses focus
setupPathInput.addEventListener("blur", () => {
  scanFolder(setupPathInput.value.trim());
});
// Also scan on paste
setupPathInput.addEventListener("input", () => {
  // Debounce: only scan after user stops typing for 500ms
  clearTimeout(setupPathInput._scanTimer);
  setupPathInput._scanTimer = setTimeout(() => {
    scanFolder(setupPathInput.value.trim());
  }, 500);
});

// On page load: check if data is already loaded
(async function checkStatus() {
  try {
    const resp = await fetch("/api/status");
    const data = await resp.json();
    if (data.loaded) {
      hideSetup();
      await init();
    } else {
      showSetup();
    }
  } catch (e) {
    showSetup();
  }
})();

// ---------------------------------------------------------------------------
// SVG / PNG export
// ---------------------------------------------------------------------------
const INLINE_STYLES = {
  ".tip-label": "font-size:10px;font-family:system-ui,sans-serif",
  ".motif-match": "stroke:#e22;stroke-width:2",
  ".shared-node": "fill:#ff6600;stroke:#c40;stroke-width:1.5",
  ".collapsed-triangle": "fill:#cde;stroke:#89a",
  ".bootstrap-label": "font-size:8px;fill:#666",
};

function buildExportSVGString() {
  const original = document.getElementById("tree-svg");
  const clone = original.cloneNode(true);
  const g = clone.querySelector("#tree-group");

  // Compute tight bounding box from the live tree-group
  const liveGroup = document.getElementById("tree-group");
  const bbox = liveGroup.getBBox();
  const pad = 20;
  const vx = bbox.x - pad;
  const vy = bbox.y - pad;
  const vw = bbox.width + pad * 2;
  const vh = bbox.height + pad * 2;

  clone.setAttribute("viewBox", `${vx} ${vy} ${vw} ${vh}`);
  clone.setAttribute("width", vw);
  clone.setAttribute("height", vh);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");

  // Remove pan/zoom transform — viewBox handles framing
  g.removeAttribute("transform");

  // Inline CSS for standalone rendering
  for (const [selector, style] of Object.entries(INLINE_STYLES)) {
    clone.querySelectorAll(selector).forEach(el => {
      el.setAttribute("style", (el.getAttribute("style") || "") + ";" + style);
    });
  }

  return { svgString: new XMLSerializer().serializeToString(clone), width: vw, height: vh };
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

function exportSVG() {
  const resultEl = document.getElementById("export-viz-result");
  try {
    const { svgString } = buildExportSVGString();
    const blob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
    triggerDownload(blob, "phyloscope-tree.svg");
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
      const dpr = 2; // retina quality
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

document.getElementById("export-svg-btn").addEventListener("click", exportSVG);
document.getElementById("export-png-btn").addEventListener("click", exportPNG);

// Wire up export button and load tip datalist after DOM ready
document.getElementById("export-btn").addEventListener("click", doExport);

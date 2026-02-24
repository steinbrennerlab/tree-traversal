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
let usePhylogram = true;
let tipSpacing = 16;
let layoutMode = "rectangular";  // "rectangular" | "circular" | "unrooted"
let showTipLabels = true;
let showBootstraps = false;
let exportNodeId = null;         // currently selected node for export
let allTipNames = [];            // cached for export validation

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

function getNodeColor(node, checkedSpecies) {
  if (node.name && node.sp && checkedSpecies.has(node.sp))
    return speciesColors[node.sp] || "#333";
  return "#333";
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function init() {
  const [treeResp, speciesResp] = await Promise.all([
    fetch("/api/tree").then(r => r.json()),
    fetch("/api/species").then(r => r.json()),
  ]);
  treeData = treeResp;
  speciesMap = speciesResp.species_to_tips;

  for (const [sp, tips] of Object.entries(speciesMap)) {
    for (const t of tips) tipToSpecies[t] = sp;
  }

  const speciesList = speciesResp.species;
  speciesList.forEach((sp, i) => { speciesColors[sp] = PALETTE[i % PALETTE.length]; });

  indexNodes(treeData);
  buildSpeciesList(speciesList);
  buildExcludeSpeciesList(speciesList);
  setupControls();
  renderTree();
  loadTipDatalist();
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

  // Shared nodes
  document.getElementById("highlight-shared").addEventListener("click", highlightSharedNodes);

  // Exclude species reset
  document.getElementById("exclude-none").addEventListener("click", () => {
    document.querySelectorAll("#exclude-species-list input").forEach(cb => cb.checked = false);
  });

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
  motifMatches = new Set(data.matched_tips || []);
  const el = document.getElementById("motif-result");
  if (data.error) {
    el.textContent = data.error;
  } else {
    el.textContent = `${motifMatches.size} tips matched`;
  }
  renderTree();
}

// ---------------------------------------------------------------------------
// Shared nodes highlighting
// ---------------------------------------------------------------------------
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
      const y = leafIndex * tipSpacing;
      leafIndex++;
      const tipCount = countAllTips(node);
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
      const triH = Math.min(node.tipCount * 2, 40);
      fragments.push(
        `<polygon points="${nx},${ny} ${nx + 30},${ny - triH / 2} ${nx + 30},${ny + triH / 2}" class="collapsed-triangle" data-nodeid="${node.id}"/>` +
        `<text x="${nx + 34}" y="${ny + 3}" font-size="9" fill="#666">${node.tipCount} tips</text>`
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
      const wedgeR = node.r + 20;
      const halfArc = Math.min(node.tipCount * 0.01, 0.3);
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
      const fanLen = 20;
      const halfW = Math.min(node.tipCount * 0.01, 0.3);
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
  const isShared = sharedNodes.has(node.id);
  const r = isShared ? 5 : 3;
  fragments.push(
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${isShared ? '#ff6600' : '#999'}" class="node-dot ${isShared ? 'shared-node' : ''}"
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
  const color = isMotif ? "#e22" : isName ? "#2563eb" : spColor;
  const r = (isMotif || isName || spColor !== "#333") ? 3 : 2;
  fragments.push(
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" class="tip-dot"
      data-tip="${node.name}" data-species="${node.sp || ''}"/>`
  );
}

function drawTipLabel(fragments, x, y, rotation, node, checkedSpecies) {
  const isMotif = motifMatches.has(node.name);
  const isName = nameMatches.has(node.name);
  const highlight = isMotif || isName;
  const color = isMotif ? "#e22" : isName ? "#2563eb" : getNodeColor(node, checkedSpecies);
  const bold = highlight ? ' font-weight="bold"' : "";
  const transform = rotation ? ` transform="rotate(${rotation},${x},${y})"` : "";
  fragments.push(
    `<text x="${x}" y="${y}" class="tip-label" fill="${color}"${bold}${transform}
      data-tip="${node.name}" data-species="${node.sp || ''}">${node.name}</text>`
  );
  if (isMotif) {
    fragments.push(`<circle cx="${x - 4}" cy="${y - 3}" r="3" class="motif-match" fill="#e22"/>`);
  }
  if (isName) {
    fragments.push(`<circle cx="${x - 4}" cy="${y - 3}" r="3" fill="#2563eb" stroke="#1d4ed8" stroke-width="1"/>`);
  }
}

function drawTipLabelRadial(fragments, x, y, angleDeg, anchor, node, checkedSpecies) {
  const isMotif = motifMatches.has(node.name);
  const isName = nameMatches.has(node.name);
  const highlight = isMotif || isName;
  const color = isMotif ? "#e22" : isName ? "#2563eb" : getNodeColor(node, checkedSpecies);
  const bold = highlight ? ' font-weight="bold"' : "";
  fragments.push(
    `<text x="${x}" y="${y}" class="tip-label" fill="${color}"${bold}
      text-anchor="${anchor}" transform="rotate(${angleDeg},${x},${y})"
      data-tip="${node.name}" data-species="${node.sp || ''}">${node.name}</text>`
  );
  if (isMotif) {
    const rad = angleDeg * Math.PI / 180;
    const mx = x - 6 * Math.cos(rad);
    const my = y - 6 * Math.sin(rad);
    fragments.push(`<circle cx="${mx}" cy="${my}" r="3" class="motif-match" fill="#e22"/>`);
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
  const nodeId = el.dataset?.nodeid;
  if (nodeId != null) {
    const nid = +nodeId;
    if (e.shiftKey) {
      openExportPanel(nid);
      return;
    }
    if (collapsedNodes.has(nid)) collapsedNodes.delete(nid);
    else collapsedNodes.add(nid);
    renderTree();
  }
}

function onTreeHover(e) {
  const el = e.target;
  if (el.dataset?.tip) {
    tooltip.textContent = `${el.dataset.tip}\nSpecies: ${el.dataset.species || "unknown"}`;
    tooltip.style.display = "block";
    tooltip.style.left = (e.clientX + 12) + "px";
    tooltip.style.top = (e.clientY - 10) + "px";
  } else if (el.dataset?.support != null) {
    tooltip.textContent = `Support: ${el.dataset.support}`;
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

    const isValid = data.has_nwk && data.has_aa_fa;
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
  }
});

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

  try {
    const resp = await fetch("/api/load", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({input_dir: inputDir}),
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

setupLoadBtn.addEventListener("click", doSetupLoad);
setupPathInput.addEventListener("keydown", e => {
  if (e.key === "Enter") doSetupLoad();
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

// Wire up export button and load tip datalist after DOM ready
document.getElementById("export-btn").addEventListener("click", doExport);

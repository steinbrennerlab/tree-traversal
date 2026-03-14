import { dom, getInlineStyles, state } from "./state.js";
import {
  collectAllTipNames,
  countAllTips,
  countLeaves,
  getMotifColors,
  getNodeColor,
  isNodeHidden,
} from "./tree-utils.js";

let treeClickHandler = () => {};
let treeHoverHandler = () => {};

export function configureRenderer({ onTreeClick, onTreeHover }) {
  treeClickHandler = onTreeClick;
  treeHoverHandler = onTreeHover;
}

export function invalidateRenderCache() {
  state.renderCache = null;
  state.renderCacheKey = null;
}

export function applyTransform() {
  dom.group.setAttribute("transform", `translate(${state.tx},${state.ty}) scale(${state.scale})`);
}

function drawMotifPie(fragments, cx, cy, r, colors) {
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
    const large = a1 - a0 > Math.PI ? 1 : 0;
    fragments.push(
      `<path d="M${cx},${cy} L${x0},${y0} A${r},${r} 0 ${large},1 ${x1},${y1} Z" fill="${colors[i]}" class="tip-dot motif-match"/>`
    );
  }
}

function getRenderCacheKey(checkedSpecies) {
  return [
    state.layoutMode,
    state.usePhylogram,
    state.tipSpacing,
    state.triangleScale,
    state.uniformTriangles,
    [...state.collapsedNodes].sort().join(","),
    [...checkedSpecies].sort().join(","),
    [...state.nameMatches].sort().join(","),
    [...state.motifMatches].sort().join(","),
    [...state.sharedNodes].sort().join(","),
    state.exportNodeId,
    state.selectedTip,
    state.showTipLabels,
    state.tipLabelSize,
    state.dotSize,
    state.showLengths,
    state.showBootstraps,
    state.fastMode,
    [...state.hiddenTips].sort().join(","),
    state.labelFontSize,
    JSON.stringify(state.nodeLabels),
    JSON.stringify(state.nodeLabelIcons),
    JSON.stringify(state.activeHeatmaps.map(heatmap => ({
      name: heatmap.name,
      visibleColumns: heatmap.visibleColumns,
    }))),
  ].join("|");
}

function attachTreeEvents() {
  dom.group.onclick = treeClickHandler;
  dom.group.onmouseover = treeHoverHandler;
  dom.group.onmouseout = () => {
    dom.tooltip.style.display = "none";
  };
}

export function renderTree() {
  if (!state.treeData) return;

  const checkedSpecies = new Set(
    [...document.querySelectorAll("#species-list input:checked")].map(cb => cb.dataset.species)
  );

  const allowFastMode = state.fastMode && !(
    (state.layoutMode === "rectangular" || state.layoutMode === "circular") &&
    state.activeHeatmaps.length > 0
  );
  if (allowFastMode) {
    const key = getRenderCacheKey(checkedSpecies);
    if (state.renderCache && state.renderCacheKey === key) {
      dom.group.innerHTML = state.renderCache;
      attachTreeEvents();
      applyTransform();
      return;
    }
  }

  const fragments = [];
  if (state.layoutMode === "rectangular") {
    renderRectangular(fragments, checkedSpecies);
  } else if (state.layoutMode === "circular") {
    renderCircular(fragments, checkedSpecies);
  } else {
    renderUnrooted(fragments, checkedSpecies);
  }

  const html = fragments.join("\n");
  if (allowFastMode) {
    state.renderCache = html;
    state.renderCacheKey = getRenderCacheKey(checkedSpecies);
  }

  dom.group.innerHTML = html;
  attachTreeEvents();

  if (state.layoutMode !== "rectangular" && state.scale === 1 && state.tx === 20 && state.ty === 20) {
    const rect = dom.svg.getBoundingClientRect();
    state.tx = rect.width / 2;
    state.ty = rect.height / 2;
  }
  applyTransform();
}

function renderRectangular(fragments, checkedSpecies) {
  let leafIndex = 0;
  const xScale = state.usePhylogram ? 800 : 0;
  const heatmapRows = [];
  let heatmapAnchorX = 0;

  function layout(node, depth) {
    if (isNodeHidden(node)) return null;
    const bl = node.bl || 0;
    const x = state.usePhylogram ? depth + bl * xScale : depth + 20;

    if (state.collapsedNodes.has(node.id) && node.ch) {
      const tipCount = countAllTips(node);
      const triH = (state.uniformTriangles ? 30 : Math.min(tipCount * 2, 40)) * state.triangleScale / 100;
      const slotsNeeded = Math.max(1, Math.ceil(triH / state.tipSpacing));
      const y = (leafIndex + slotsNeeded / 2) * state.tipSpacing;
      leafIndex += slotsNeeded;
      return { ...node, x, parentX: depth, y, collapsed: true, tipCount };
    }
    if (!node.ch || node.ch.length === 0) {
      if (state.hiddenTips.has(node.name)) return null;
      const y = leafIndex * state.tipSpacing;
      leafIndex++;
      return { ...node, x, parentX: depth, y };
    }
    const children = node.ch.map(child => layout(child, x)).filter(Boolean);
    if (children.length === 0) return null;
    const y = (children[0].y + children[children.length - 1].y) / 2;
    return { ...node, x, parentX: depth, y, layoutChildren: children };
  }

  const root = layout(state.treeData, 0);
  if (!root) return;
  if (state.fastMode && state.activeHeatmaps.length === 0) {
    drawFastRectangular(fragments, root, checkedSpecies);
    return;
  }

  function draw(node) {
    const px = node.parentX;
    const nx = node.x;
    const ny = node.y;
    const color = getNodeColor(node, checkedSpecies);

    fragments.push(`<line x1="${px}" y1="${ny}" x2="${nx}" y2="${ny}" stroke="${color}" stroke-width="1"/>`);

    if (node.collapsed) {
      const triH = (state.uniformTriangles ? 30 : Math.min(node.tipCount * 2, 40)) * state.triangleScale / 100;
      const triW = 30 * state.triangleScale / 100;
      const triLabel = state.nodeLabels[node.id] ? `${state.nodeLabels[node.id]} (${node.tipCount})` : `${node.tipCount} tips`;
      fragments.push(
        `<polygon points="${nx},${ny} ${nx + triW},${ny - triH / 2} ${nx + triW},${ny + triH / 2}" class="collapsed-triangle" data-nodeid="${node.id}"/>` +
        `<text x="${nx + triW + 4}" y="${ny + 3}" font-size="9" fill="#666">${triLabel}</text>`
      );
      if (state.selectedTip && collectAllTipNames(node).includes(state.selectedTip)) {
        fragments.push(`<circle cx="${nx}" cy="${ny}" r="16" fill="none" stroke="#e22" stroke-width="3" class="selected-tip-ring"/>`);
      }
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
      const d = state.dotSize;
      const labelX = nx + d + 1;
      if (state.showTipLabels) drawTipLabel(fragments, labelX, ny + d, 0, node, checkedSpecies);
      const labelWidth = state.showTipLabels ? estimateTipLabelWidth(node) : 0;
      heatmapAnchorX = Math.max(heatmapAnchorX, labelX + labelWidth);
      heatmapRows.push({ node, y: ny - 5 });
    }
  }

  draw(root);
  drawRectangularHeatmap(fragments, heatmapRows, heatmapAnchorX + 12);
}

function renderCircular(fragments, checkedSpecies) {
  const totalLeaves = countLeaves(state.treeData);
  const spacingFactor = state.tipSpacing / 16;
  const rScale = state.usePhylogram ? 300 * spacingFactor : 0;
  const rStep = state.usePhylogram ? 0 : 15 * spacingFactor;
  let leafIndex = 0;
  const heatmapTips = [];

  function layout(node, depth) {
    if (isNodeHidden(node)) return null;
    const bl = node.bl || 0;
    const r = state.usePhylogram ? depth + bl * rScale : depth + rStep;

    if (state.collapsedNodes.has(node.id) && node.ch) {
      const angle = (leafIndex / totalLeaves) * 2 * Math.PI;
      leafIndex++;
      const tipCount = countAllTips(node);
      return { ...node, r, parentR: depth, angle, collapsed: true, tipCount };
    }
    if (!node.ch || node.ch.length === 0) {
      if (state.hiddenTips.has(node.name)) return null;
      const angle = (leafIndex / totalLeaves) * 2 * Math.PI;
      leafIndex++;
      return { ...node, r, parentR: depth, angle };
    }
    const children = node.ch.map(child => layout(child, r)).filter(Boolean);
    if (children.length === 0) return null;
    const angle = (children[0].angle + children[children.length - 1].angle) / 2;
    return { ...node, r, parentR: depth, angle, layoutChildren: children };
  }

  const root = layout(state.treeData, 0);
  if (!root) return;

  function toXY(r, angle) {
    return [r * Math.cos(angle), r * Math.sin(angle)];
  }

  if (state.fastMode) {
    drawFastCircular(fragments, root, checkedSpecies, toXY);
    return;
  }

  function draw(node) {
    const [nx, ny] = toXY(node.r, node.angle);
    const [px, py] = toXY(node.parentR, node.angle);
    const color = getNodeColor(node, checkedSpecies);

    fragments.push(`<line x1="${px}" y1="${py}" x2="${nx}" y2="${ny}" stroke="${color}" stroke-width="1"/>`);

    if (node.collapsed) {
      const wedgeR = node.r + 20 * state.triangleScale / 100;
      const halfArc = (state.uniformTriangles ? 0.2 : Math.min(node.tipCount * 0.01, 0.3)) * state.triangleScale / 100;
      const [wx1, wy1] = toXY(wedgeR, node.angle - halfArc);
      const [wx2, wy2] = toXY(wedgeR, node.angle + halfArc);
      const large = halfArc * 2 > Math.PI ? 1 : 0;
      fragments.push(
        `<path d="M${nx},${ny} L${wx1},${wy1} A${wedgeR},${wedgeR} 0 ${large},1 ${wx2},${wy2} Z" class="collapsed-triangle" data-nodeid="${node.id}"/>` +
        `<text x="${(wx1 + wx2) / 2 + 4}" y="${(wy1 + wy2) / 2}" font-size="9" fill="#666">${node.tipCount}</text>`
      );
      if (state.selectedTip && collectAllTipNames(node).includes(state.selectedTip)) {
        fragments.push(`<circle cx="${nx}" cy="${ny}" r="16" fill="none" stroke="#e22" stroke-width="3" class="selected-tip-ring"/>`);
      }
      return;
    }
    if (node.layoutChildren) {
      const a1 = node.layoutChildren[0].angle;
      const a2 = node.layoutChildren[node.layoutChildren.length - 1].angle;
      const [ax1, ay1] = toXY(node.r, a1);
      const [ax2, ay2] = toXY(node.r, a2);
      const sweep = a2 - a1;
      const large = sweep > Math.PI ? 1 : 0;
      fragments.push(`<path d="M${ax1},${ay1} A${node.r},${node.r} 0 ${large},1 ${ax2},${ay2}" fill="none" stroke="#999" stroke-width="1"/>`);
      drawNodeDot(fragments, nx, ny, node);
      node.layoutChildren.forEach(draw);
    } else {
      const d = state.dotSize;
      const deg = node.angle * 180 / Math.PI;
      const flip = (deg > 90 && deg < 270) || (deg < -90 && deg > -270);
      const textAngle = flip ? deg + 180 : deg;
      const anchor = flip ? "end" : "start";
      const gap = d + 1;
      const lx = nx + (flip ? -gap : gap) * Math.cos(node.angle);
      const ly = ny + (flip ? -gap : gap) * Math.sin(node.angle);
      drawTipDot(fragments, nx, ny, node, checkedSpecies);
      if (state.showTipLabels) drawTipLabelRadial(fragments, lx, ly, textAngle, anchor, node, checkedSpecies);
      heatmapTips.push({
        node,
        angle: node.angle,
        labelRadius: Math.hypot(lx, ly),
      });
    }
  }

  draw(root);
  drawCircularHeatmap(fragments, heatmapTips);
}

function renderUnrooted(fragments, checkedSpecies) {
  const spacingFactor = state.tipSpacing / 16;
  const blScale = state.usePhylogram ? 300 * spacingFactor : 0;
  const blStep = state.usePhylogram ? 0 : 20 * spacingFactor;

  function layout(node, px, py, startAngle, wedge) {
    if (isNodeHidden(node)) return null;
    const bl = node.bl || 0;
    const len = state.usePhylogram ? bl * blScale : blStep;
    const midAngle = startAngle + wedge / 2;
    const nx = px + len * Math.cos(midAngle);
    const ny = py + len * Math.sin(midAngle);

    if (state.collapsedNodes.has(node.id) && node.ch) {
      const tipCount = countAllTips(node);
      return { ...node, x: nx, y: ny, parentX: px, parentY: py, angle: midAngle, collapsed: true, tipCount };
    }
    if (!node.ch || node.ch.length === 0) {
      if (state.hiddenTips.has(node.name)) return null;
      return { ...node, x: nx, y: ny, parentX: px, parentY: py, angle: midAngle };
    }

    const childLeafCounts = node.ch.map(child => countLeaves(child));
    const totalChildLeaves = childLeafCounts.reduce((sum, count) => sum + count, 0);
    if (totalChildLeaves === 0) return null;
    let curAngle = startAngle;
    const children = [];
    node.ch.forEach((child, index) => {
      if (childLeafCounts[index] === 0) return;
      const childWedge = childLeafCounts[index] / totalChildLeaves * wedge;
      const result = layout(child, nx, ny, curAngle, childWedge);
      curAngle += childWedge;
      if (result) children.push(result);
    });
    if (children.length === 0) return null;

    return { ...node, x: nx, y: ny, parentX: px, parentY: py, angle: midAngle, layoutChildren: children };
  }

  const root = layout(state.treeData, 0, 0, 0, 2 * Math.PI);
  if (!root) return;
  if (state.fastMode) {
    drawFastUnrooted(fragments, root, checkedSpecies);
    return;
  }

  function draw(node) {
    const color = getNodeColor(node, checkedSpecies);
    fragments.push(`<line x1="${node.parentX}" y1="${node.parentY}" x2="${node.x}" y2="${node.y}" stroke="${color}" stroke-width="1"/>`);

    if (node.collapsed) {
      const fanLen = 20 * state.triangleScale / 100;
      const halfW = (state.uniformTriangles ? 0.2 : Math.min(node.tipCount * 0.01, 0.3)) * state.triangleScale / 100;
      const x1 = node.x + fanLen * Math.cos(node.angle - halfW);
      const y1 = node.y + fanLen * Math.sin(node.angle - halfW);
      const x2 = node.x + fanLen * Math.cos(node.angle + halfW);
      const y2 = node.y + fanLen * Math.sin(node.angle + halfW);
      fragments.push(
        `<polygon points="${node.x},${node.y} ${x1},${y1} ${x2},${y2}" class="collapsed-triangle" data-nodeid="${node.id}"/>` +
        `<text x="${(x1 + x2) / 2 + 2}" y="${(y1 + y2) / 2}" font-size="9" fill="#666">${node.tipCount}</text>`
      );
      if (state.selectedTip && collectAllTipNames(node).includes(state.selectedTip)) {
        fragments.push(`<circle cx="${node.x}" cy="${node.y}" r="16" fill="none" stroke="#e22" stroke-width="3" class="selected-tip-ring"/>`);
      }
      return;
    }
    if (node.layoutChildren) {
      drawNodeDot(fragments, node.x, node.y, node);
      node.layoutChildren.forEach(draw);
    } else {
      const gap = state.dotSize + 1;
      const deg = node.angle * 180 / Math.PI;
      const flip = (deg > 90 && deg < 270) || (deg < -90 && deg > -270);
      const textAngle = flip ? deg + 180 : deg;
      const anchor = flip ? "end" : "start";
      const lx = node.x + gap * Math.cos(node.angle);
      const ly = node.y + gap * Math.sin(node.angle);
      drawTipDot(fragments, node.x, node.y, node, checkedSpecies);
      if (state.showTipLabels) drawTipLabelRadial(fragments, lx, ly, textAngle, anchor, node, checkedSpecies);
    }
  }

  draw(root);
}

const EMOJI_MAP = {
  "e-dog":"\ud83d\udc15","e-cat":"\ud83d\udc08","e-mouse":"\ud83d\udc2d","e-rabbit":"\ud83d\udc07",
  "e-fish":"\ud83d\udc1f","e-bird":"\ud83d\udc26","e-chicken":"\ud83d\udc14","e-cow":"\ud83d\udc04",
  "e-pig":"\ud83d\udc16","e-horse":"\ud83d\udc0e","e-monkey":"\ud83d\udc12","e-snake":"\ud83d\udc0d",
  "e-frog":"\ud83d\udc38","e-turtle":"\ud83d\udc22","e-bug":"\ud83d\udc1b","e-butterfly":"\ud83e\udd8b",
  "e-bee":"\ud83d\udc1d","e-whale":"\ud83d\udc0b","e-dna":"\ud83e\uddec","e-microbe":"\ud83e\udda0",
  "e-tree":"\ud83c\udf33","e-palm":"\ud83c\udf34","e-evergreen":"\ud83c\udf32","e-seedling":"\ud83c\udf31",
  "e-herb":"\ud83c\udf3f","e-leaf":"\ud83c\udf43","e-flower":"\ud83c\udf3b","e-rose":"\ud83c\udf39",
  "e-mushroom":"\ud83c\udf44","e-cactus":"\ud83c\udf35","e-corn":"\ud83c\udf3d",
};

function drawNodeIcon(fragments, cx, cy, r, fill, cls, nodeId, sup) {
  const icon = state.nodeLabelIcons[nodeId] || "dot";
  const attrs = `fill="${fill}" class="${cls}" data-nodeid="${nodeId}"${sup != null ? ` data-support="${sup}"` : ""}`;
  if (EMOJI_MAP[icon]) {
    const fontSize = r * 2.5;
    fragments.push(`<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" font-size="${fontSize}" class="node-dot" data-nodeid="${nodeId}" style="cursor:pointer">${EMOJI_MAP[icon]}</text>`);
    return;
  }
  switch (icon) {
    case "star": {
      const pts = [];
      for (let i = 0; i < 10; i++) {
        const a = Math.PI / 2 + i * Math.PI / 5;
        const rad = i % 2 === 0 ? r : r * 0.45;
        pts.push(`${cx + rad * Math.cos(a)},${cy - rad * Math.sin(a)}`);
      }
      fragments.push(`<polygon points="${pts.join(" ")}" ${attrs}/>`);
      break;
    }
    case "square":
      fragments.push(`<rect x="${cx - r}" y="${cy - r}" width="${r * 2}" height="${r * 2}" ${attrs}/>`);
      break;
    case "diamond": {
      const dr = r * 1.2;
      fragments.push(`<polygon points="${cx},${cy - dr} ${cx + dr},${cy} ${cx},${cy + dr} ${cx - dr},${cy}" ${attrs}/>`);
      break;
    }
    case "triangle":
      fragments.push(`<polygon points="${cx},${cy - r} ${cx + r},${cy + r * 0.7} ${cx - r},${cy + r * 0.7}" ${attrs}/>`);
      break;
    case "none":
      fragments.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="transparent" class="node-dot" data-nodeid="${nodeId}"/>`);
      break;
    default:
      fragments.push(`<circle cx="${cx}" cy="${cy}" r="${r}" ${attrs}/>`);
  }
}

function drawNodeDot(fragments, cx, cy, node) {
  const d = state.dotSize;
  const isSelected = node.id === state.exportNodeId;
  const isShared = state.sharedNodes.has(node.id);
  const hasLabel = !!state.nodeLabels[node.id];
  const r = isSelected ? d * 2 : isShared ? d * 1.7 : hasLabel ? d * 1.5 : d;
  const ringR = d * 5;
  const fill = isSelected ? "#000" : isShared ? "#ff6600" : "#999";
  const cls = isSelected ? "node-dot selected-node" : isShared ? "node-dot shared-node" : "node-dot";
  if (isSelected) {
    fragments.push(`<circle cx="${cx}" cy="${cy}" r="${ringR}" fill="none" stroke="#e22" stroke-width="3" class="selected-node-ring"/>`);
  }
  if (hasLabel) {
    drawNodeIcon(fragments, cx, cy, r, fill, cls, node.id, node.sup);
  } else {
    fragments.push(
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" class="${cls}" data-nodeid="${node.id}" ${node.sup != null ? `data-support="${node.sup}"` : ""}/>`
    );
  }
  if (state.showBootstraps && node.sup != null) {
    fragments.push(`<text x="${cx + d * 2}" y="${cy - d * 1.7}" class="bootstrap-label">${node.sup}</text>`);
  }
  if (state.nodeLabels[node.id]) {
    fragments.push(`<text x="${cx + d * 2.5}" y="${cy + d * 1.3}" class="node-label" font-size="${state.labelFontSize}">${state.nodeLabels[node.id]}</text>`);
  }
}

function drawTipDot(fragments, cx, cy, node, checkedSpecies) {
  const d = state.dotSize;
  const isMotif = state.motifMatches.has(node.name);
  const isName = state.nameMatches.has(node.name);
  const spColor = getNodeColor(node, checkedSpecies);
  const r = isMotif || isName || spColor !== "#333" ? d : d * 0.7;
  if (node.name === state.selectedTip) {
    fragments.push(`<circle cx="${cx}" cy="${cy}" r="${d * 5}" fill="none" stroke="#e22" stroke-width="3" class="selected-tip-ring"/>`);
  }
  if (isMotif) {
    const colors = getMotifColors(node.name);
    if (colors.length > 0) {
      drawMotifPie(fragments, cx, cy, r, colors);
      return;
    }
  }
  const color = isName ? "#2563eb" : spColor;
  fragments.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" class="tip-dot" data-tip="${node.name}" data-species="${node.sp || ""}"/>`);
}

function drawTipLabel(fragments, x, y, rotation, node, checkedSpecies) {
  const isMotif = state.motifMatches.has(node.name);
  const isName = state.nameMatches.has(node.name);
  const highlight = isMotif || isName;
  const motifColors = isMotif ? getMotifColors(node.name) : [];
  const color = isMotif && motifColors.length > 0 ? motifColors[0] : isName ? "#2563eb" : getNodeColor(node, checkedSpecies);
  const bold = highlight ? ' font-weight="bold"' : "";
  const transform = rotation ? ` transform="rotate(${rotation},${x},${y})"` : "";
  const label = getTipLabelText(node);
  fragments.push(`<text x="${x}" y="${y}" class="tip-label" fill="${color}" font-size="${state.tipLabelSize}"${bold}${transform} data-tip="${node.name}" data-species="${node.sp || ""}">${label}</text>`);
  if (isMotif && motifColors.length > 0) {
    drawMotifPie(fragments, x - 4, y - 3, 3, motifColors);
  }
  if (isName) {
    fragments.push(`<circle cx="${x - 4}" cy="${y - 3}" r="3" fill="#2563eb" stroke="#1d4ed8" stroke-width="1"/>`);
  }
}

function drawTipLabelRadial(fragments, x, y, angleDeg, anchor, node, checkedSpecies) {
  const isMotif = state.motifMatches.has(node.name);
  const isName = state.nameMatches.has(node.name);
  const highlight = isMotif || isName;
  const motifColors = isMotif ? getMotifColors(node.name) : [];
  const color = isMotif && motifColors.length > 0 ? motifColors[0] : isName ? "#2563eb" : getNodeColor(node, checkedSpecies);
  const bold = highlight ? ' font-weight="bold"' : "";
  const label = getTipLabelText(node);
  fragments.push(`<text x="${x}" y="${y}" class="tip-label" fill="${color}" font-size="${state.tipLabelSize}"${bold} text-anchor="${anchor}" transform="rotate(${angleDeg},${x},${y})" data-tip="${node.name}" data-species="${node.sp || ""}">${label}</text>`);
  if (isMotif && motifColors.length > 0) {
    const rad = angleDeg * Math.PI / 180;
    drawMotifPie(fragments, x - 6 * Math.cos(rad), y - 6 * Math.sin(rad), 3, motifColors);
  }
  if (isName) {
    const rad = angleDeg * Math.PI / 180;
    fragments.push(`<circle cx="${x - 6 * Math.cos(rad)}" cy="${y - 6 * Math.sin(rad)}" r="3" fill="#2563eb" stroke="#1d4ed8" stroke-width="1"/>`);
  }
}

function drawFastRectangular(fragments, root, checkedSpecies) {
  const branchPaths = [];
  const vlinePaths = [];
  const dotData = [];
  const triangles = [];
  const tipLabels = [];

  function collect(node) {
    const color = getNodeColor(node, checkedSpecies);
    branchPaths.push({ x1: node.parentX, y1: node.y, x2: node.x, y2: node.y, color });

    if (node.collapsed) {
      const triH = (state.uniformTriangles ? 30 : Math.min(node.tipCount * 2, 40)) * state.triangleScale / 100;
      const triW = 30 * state.triangleScale / 100;
      const triLabel = state.nodeLabels[node.id] ? `${state.nodeLabels[node.id]} (${node.tipCount})` : `${node.tipCount} tips`;
      triangles.push(
        `<polygon points="${node.x},${node.y} ${node.x + triW},${node.y - triH / 2} ${node.x + triW},${node.y + triH / 2}" class="collapsed-triangle" data-nodeid="${node.id}"/>` +
        `<text x="${node.x + triW + 4}" y="${node.y + 3}" font-size="9" fill="#666">${triLabel}</text>`
      );
      if (state.selectedTip && collectAllTipNames(node).includes(state.selectedTip)) {
        triangles.push(`<circle cx="${node.x}" cy="${node.y}" r="16" fill="none" stroke="#e22" stroke-width="3" class="selected-tip-ring"/>`);
      }
      return;
    }
    if (node.layoutChildren) {
      vlinePaths.push({ x: node.x, y1: node.layoutChildren[0].y, y2: node.layoutChildren[node.layoutChildren.length - 1].y });
      const d = state.dotSize;
      const isSelected = node.id === state.exportNodeId;
      const isShared = state.sharedNodes.has(node.id);
      dotData.push({
        cx: node.x,
        cy: node.y,
        r: isSelected ? d * 2 : isShared ? d * 1.7 : d,
        fill: isSelected ? "#000" : isShared ? "#ff6600" : "#999",
        nodeId: node.id,
        sup: node.sup,
        isTip: false,
      });
      node.layoutChildren.forEach(collect);
    } else {
      const d = state.dotSize;
      const isMotif = state.motifMatches.has(node.name);
      const isName = state.nameMatches.has(node.name);
      const spColor = getNodeColor(node, checkedSpecies);
      let fill = "#333";
      if (isMotif) {
        const colors = getMotifColors(node.name);
        fill = colors.length > 0 ? colors[0] : "#e22";
      } else if (isName) {
        fill = "#2563eb";
      } else {
        fill = spColor;
      }
      const r = isMotif || isName || spColor !== "#333" ? d : d * 0.7;
      dotData.push({ cx: node.x, cy: node.y, r, fill, isTip: true, tipName: node.name, species: node.sp || "" });
      if (state.showTipLabels) {
        tipLabels.push({ x: node.x + d + 1, y: node.y + d, node });
      }
    }
  }

  collect(root);
  emitFastBranches(fragments, branchPaths);
  if (vlinePaths.length > 0) {
    fragments.push(`<path d="${vlinePaths.map(v => `M${v.x},${v.y1}L${v.x},${v.y2}`).join("")}" stroke="#999" stroke-width="1" fill="none"/>`);
  }
  emitFastTrianglesAndDots(fragments, triangles, dotData);
  tipLabels.forEach(label => drawTipLabel(fragments, label.x, label.y, 0, label.node, checkedSpecies));
}

function drawFastCircular(fragments, root, checkedSpecies, toXY) {
  const branchPaths = [];
  const arcPaths = [];
  const dotData = [];
  const triangles = [];
  const tipLabels = [];

  function collect(node) {
    const [nx, ny] = toXY(node.r, node.angle);
    const [px, py] = toXY(node.parentR, node.angle);
    const color = getNodeColor(node, checkedSpecies);
    branchPaths.push({ x1: px, y1: py, x2: nx, y2: ny, color });

    if (node.collapsed) {
      const wedgeR = node.r + 20 * state.triangleScale / 100;
      const halfArc = (state.uniformTriangles ? 0.2 : Math.min(node.tipCount * 0.01, 0.3)) * state.triangleScale / 100;
      const [wx1, wy1] = toXY(wedgeR, node.angle - halfArc);
      const [wx2, wy2] = toXY(wedgeR, node.angle + halfArc);
      const large = halfArc * 2 > Math.PI ? 1 : 0;
      triangles.push(
        `<path d="M${nx},${ny} L${wx1},${wy1} A${wedgeR},${wedgeR} 0 ${large},1 ${wx2},${wy2} Z" class="collapsed-triangle" data-nodeid="${node.id}"/>` +
        `<text x="${(wx1 + wx2) / 2 + 4}" y="${(wy1 + wy2) / 2}" font-size="9" fill="#666">${node.tipCount}</text>`
      );
      if (state.selectedTip && collectAllTipNames(node).includes(state.selectedTip)) {
        triangles.push(`<circle cx="${nx}" cy="${ny}" r="16" fill="none" stroke="#e22" stroke-width="3" class="selected-tip-ring"/>`);
      }
      return;
    }
    if (node.layoutChildren) {
      const a1 = node.layoutChildren[0].angle;
      const a2 = node.layoutChildren[node.layoutChildren.length - 1].angle;
      const [ax1, ay1] = toXY(node.r, a1);
      const [ax2, ay2] = toXY(node.r, a2);
      const large = a2 - a1 > Math.PI ? 1 : 0;
      arcPaths.push(`M${ax1},${ay1} A${node.r},${node.r} 0 ${large},1 ${ax2},${ay2}`);

      const d = state.dotSize;
      const isSelected = node.id === state.exportNodeId;
      const isShared = state.sharedNodes.has(node.id);
      dotData.push({
        cx: nx,
        cy: ny,
        r: isSelected ? d * 2 : isShared ? d * 1.7 : d,
        fill: isSelected ? "#000" : isShared ? "#ff6600" : "#999",
        nodeId: node.id,
        sup: node.sup,
        isTip: false,
      });
      node.layoutChildren.forEach(collect);
    } else {
      const d = state.dotSize;
      const isMotif = state.motifMatches.has(node.name);
      const isName = state.nameMatches.has(node.name);
      const spColor = getNodeColor(node, checkedSpecies);
      let fill = "#333";
      if (isMotif) {
        const colors = getMotifColors(node.name);
        fill = colors.length > 0 ? colors[0] : "#e22";
      } else if (isName) {
        fill = "#2563eb";
      } else {
        fill = spColor;
      }
      const r = isMotif || isName || spColor !== "#333" ? d : d * 0.7;
      dotData.push({ cx: nx, cy: ny, r, fill, isTip: true, tipName: node.name, species: node.sp || "" });
      if (state.showTipLabels) {
        const gap = d + 1;
        const deg = node.angle * 180 / Math.PI;
        const flip = (deg > 90 && deg < 270) || (deg < -90 && deg > -270);
        tipLabels.push({
          x: nx + (flip ? -gap : gap) * Math.cos(node.angle),
          y: ny + (flip ? -gap : gap) * Math.sin(node.angle),
          angle: flip ? deg + 180 : deg,
          anchor: flip ? "end" : "start",
          node,
        });
      }
    }
  }

  collect(root);
  emitFastBranches(fragments, branchPaths);
  if (arcPaths.length > 0) {
    fragments.push(`<path d="${arcPaths.join("")}" stroke="#999" stroke-width="1" fill="none"/>`);
  }
  emitFastTrianglesAndDots(fragments, triangles, dotData);
  tipLabels.forEach(label => drawTipLabelRadial(fragments, label.x, label.y, label.angle, label.anchor, label.node, checkedSpecies));
}

function drawFastUnrooted(fragments, root, checkedSpecies) {
  const branchPaths = [];
  const dotData = [];
  const triangles = [];
  const tipLabels = [];

  function collect(node) {
    const color = getNodeColor(node, checkedSpecies);
    branchPaths.push({ x1: node.parentX, y1: node.parentY, x2: node.x, y2: node.y, color });

    if (node.collapsed) {
      const fanLen = 20 * state.triangleScale / 100;
      const halfW = (state.uniformTriangles ? 0.2 : Math.min(node.tipCount * 0.01, 0.3)) * state.triangleScale / 100;
      const x1 = node.x + fanLen * Math.cos(node.angle - halfW);
      const y1 = node.y + fanLen * Math.sin(node.angle - halfW);
      const x2 = node.x + fanLen * Math.cos(node.angle + halfW);
      const y2 = node.y + fanLen * Math.sin(node.angle + halfW);
      triangles.push(
        `<polygon points="${node.x},${node.y} ${x1},${y1} ${x2},${y2}" class="collapsed-triangle" data-nodeid="${node.id}"/>` +
        `<text x="${(x1 + x2) / 2 + 2}" y="${(y1 + y2) / 2}" font-size="9" fill="#666">${node.tipCount}</text>`
      );
      if (state.selectedTip && collectAllTipNames(node).includes(state.selectedTip)) {
        triangles.push(`<circle cx="${node.x}" cy="${node.y}" r="16" fill="none" stroke="#e22" stroke-width="3" class="selected-tip-ring"/>`);
      }
      return;
    }
    if (node.layoutChildren) {
      const d = state.dotSize;
      const isSelected = node.id === state.exportNodeId;
      const isShared = state.sharedNodes.has(node.id);
      dotData.push({
        cx: node.x,
        cy: node.y,
        r: isSelected ? d * 2 : isShared ? d * 1.7 : d,
        fill: isSelected ? "#000" : isShared ? "#ff6600" : "#999",
        nodeId: node.id,
        sup: node.sup,
        isTip: false,
      });
      node.layoutChildren.forEach(collect);
    } else {
      const d = state.dotSize;
      const isMotif = state.motifMatches.has(node.name);
      const isName = state.nameMatches.has(node.name);
      const spColor = getNodeColor(node, checkedSpecies);
      let fill = "#333";
      if (isMotif) {
        const colors = getMotifColors(node.name);
        fill = colors.length > 0 ? colors[0] : "#e22";
      } else if (isName) {
        fill = "#2563eb";
      } else {
        fill = spColor;
      }
      const r = isMotif || isName || spColor !== "#333" ? d : d * 0.7;
      dotData.push({ cx: node.x, cy: node.y, r, fill, isTip: true, tipName: node.name, species: node.sp || "" });
      if (state.showTipLabels) {
        const gap = d + 1;
        const deg = node.angle * 180 / Math.PI;
        const flip = (deg > 90 && deg < 270) || (deg < -90 && deg > -270);
        tipLabels.push({
          x: node.x + gap * Math.cos(node.angle),
          y: node.y + gap * Math.sin(node.angle),
          angle: flip ? deg + 180 : deg,
          anchor: flip ? "end" : "start",
          node,
        });
      }
    }
  }

  collect(root);
  emitFastBranches(fragments, branchPaths);
  emitFastTrianglesAndDots(fragments, triangles, dotData);
  tipLabels.forEach(label => drawTipLabelRadial(fragments, label.x, label.y, label.angle, label.anchor, label.node, checkedSpecies));
}

function emitFastBranches(fragments, branchPaths) {
  const byColor = {};
  for (const branch of branchPaths) {
    if (!byColor[branch.color]) byColor[branch.color] = [];
    byColor[branch.color].push(`M${branch.x1},${branch.y1}L${branch.x2},${branch.y2}`);
  }
  for (const [color, segs] of Object.entries(byColor)) {
    fragments.push(`<path d="${segs.join("")}" stroke="${color}" stroke-width="1" fill="none"/>`);
  }
}

function emitFastTrianglesAndDots(fragments, triangles, dotData) {
  for (const triangle of triangles) fragments.push(triangle);

  const dotGroups = {};
  for (const dot of dotData) {
    const key = `${dot.fill}|${dot.r}`;
    if (!dotGroups[key]) dotGroups[key] = { fill: dot.fill, r: dot.r, dots: [] };
    dotGroups[key].dots.push(dot);
  }

  for (const group of Object.values(dotGroups)) {
    const circles = group.dots.map(dot => {
      if (dot.isTip) {
        return `<circle cx="${dot.cx}" cy="${dot.cy}" r="${group.r}" fill="${group.fill}" class="tip-dot" data-tip="${dot.tipName}" data-species="${dot.species}"/>`;
      }
      if (state.nodeLabels[dot.nodeId]) {
        const iconFrags = [];
        drawNodeIcon(iconFrags, dot.cx, dot.cy, group.r, group.fill, "node-dot", dot.nodeId, dot.sup);
        return iconFrags.join("");
      }
      return `<circle cx="${dot.cx}" cy="${dot.cy}" r="${group.r}" fill="${group.fill}" class="node-dot" data-nodeid="${dot.nodeId}"${dot.sup != null ? ` data-support="${dot.sup}"` : ""}/>`;
    }).join("");
    fragments.push(`<g>${circles}</g>`);
  }

  const d = state.dotSize;
  const ringR = d * 5;
  if (state.selectedTip) {
    const selectedTipDot = dotData.find(dot => dot.isTip && dot.tipName === state.selectedTip);
    if (selectedTipDot) {
      fragments.push(`<circle cx="${selectedTipDot.cx}" cy="${selectedTipDot.cy}" r="${ringR}" fill="none" stroke="#e22" stroke-width="3" class="selected-tip-ring"/>`);
    }
  }
  if (state.exportNodeId != null) {
    const selectedNodeDot = dotData.find(dot => !dot.isTip && dot.nodeId === state.exportNodeId);
    if (selectedNodeDot) {
      fragments.push(`<circle cx="${selectedNodeDot.cx}" cy="${selectedNodeDot.cy}" r="${ringR}" fill="none" stroke="#e22" stroke-width="3" class="selected-node-ring"/>`);
    }
  }

  for (const dot of dotData) {
    if (dot.isTip) continue;
    if (state.showBootstraps && dot.sup != null) {
      fragments.push(`<text x="${dot.cx + d * 2}" y="${dot.cy - d * 1.7}" class="bootstrap-label">${dot.sup}</text>`);
    }
    if (state.nodeLabels[dot.nodeId]) {
      fragments.push(`<text x="${dot.cx + d * 2.5}" y="${dot.cy + d * 1.3}" class="node-label" font-size="${state.labelFontSize}">${state.nodeLabels[dot.nodeId]}</text>`);
    }
  }
}

function getTipLabelText(node) {
  let label = node.name;
  if (state.showLengths && state.tipLengths[node.name] != null) label += ` (${state.tipLengths[node.name]} aa)`;
  return label;
}

function estimateTipLabelWidth(node) {
  return getTipLabelText(node).length * state.tipLabelSize * 0.6;
}

function getHeatmapColumns(heatmap) {
  if (!heatmap) return [];
  return heatmap.visibleColumns.length > 0 ? heatmap.visibleColumns : heatmap.columns;
}

function getHeatmapColor(heatmap, value) {
  if (value == null) return "#d9d9d9";
  const min = heatmap.displayMin ?? heatmap.min_value;
  const max = heatmap.displayMax ?? heatmap.max_value;
  const mid = heatmap.displayMid ?? (min + max) / 2;
  const colorLow = heatmap.colorLow || "#2166ac";
  const colorMid = heatmap.colorMid || "#f7f7f7";
  const colorHigh = heatmap.colorHigh || "#b2182b";
  if (min == null || max == null || min === max) return colorMid;
  if (value <= mid) {
    const t = mid === min ? 1 : Math.max(0, Math.min(1, (value - min) / (mid - min)));
    return interpolateColor(colorLow, colorMid, t);
  }
  const t = max === mid ? 1 : Math.max(0, Math.min(1, (value - mid) / (max - mid)));
  return interpolateColor(colorMid, colorHigh, t);
}

function interpolateColor(a, b, t) {
  const c1 = parseInt(a.slice(1), 16);
  const c2 = parseInt(b.slice(1), 16);
  const r1 = (c1 >> 16) & 255;
  const g1 = (c1 >> 8) & 255;
  const b1 = c1 & 255;
  const r2 = (c2 >> 16) & 255;
  const g2 = (c2 >> 8) & 255;
  const b2 = c2 & 255;
  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const blue = Math.round(b1 + (b2 - b1) * t);
  return `rgb(${r},${g},${blue})`;
}

function drawRectangularHeatmap(fragments, heatmapRows, startX) {
  if (state.activeHeatmaps.length === 0 || state.layoutMode !== "rectangular") return;

  const cellWidth = 14;
  const cellHeight = Math.max(8, state.tipSpacing - 4);
  const gap = 2;
  const datasetGap = 14;
  const headerY = -6;
  const titleY = -24;
  const outlineTop = -30;
  const outlineBottom = heatmapRows.length > 0 ? heatmapRows[heatmapRows.length - 1].y + cellHeight + 2 : 0;
  let offsetX = startX;

  state.activeHeatmaps.forEach(heatmap => {
    const columns = getHeatmapColumns(heatmap);
    if (columns.length === 0) return;
    const blockWidth = columns.length * (cellWidth + gap) - gap;

    fragments.push(
      `<rect x="${offsetX - 4}" y="${outlineTop}" width="${blockWidth + 8}" height="${outlineBottom - outlineTop}" class="heatmap-dataset-outline"/>`
    );
    fragments.push(
      `<text x="${offsetX}" y="${titleY}" class="heatmap-dataset-title">${escapeHtml(heatmap.name)}</text>`
    );

    columns.forEach((column, index) => {
      const x = offsetX + index * (cellWidth + gap);
      const labelX = x + cellWidth / 2;
      fragments.push(
        `<text x="${labelX}" y="${headerY}" class="heatmap-header-label" text-anchor="end" ` +
        `transform="rotate(-55,${labelX},${headerY})">${escapeHtml(column)}</text>`
      );
    });

    heatmapRows.forEach(({ node, y }) => {
      const rowValues = heatmap.tip_values[node.name];
      if (!rowValues) return;
      columns.forEach((column, index) => {
        const cell = rowValues[column];
        if (!cell) return;
        const x = offsetX + index * (cellWidth + gap);
        const fill = getHeatmapColor(heatmap, cell.value);
        const cls = cell.value == null ? "heatmap-cell heatmap-cell-missing" : "heatmap-cell";
        fragments.push(
          `<rect x="${x}" y="${y}" width="${cellWidth}" height="${cellHeight}" fill="${fill}" class="${cls}" ` +
          `data-heatmap="1" data-heatmap-tip="${node.name}" data-column="${escapeHtml(column)}" data-dataset="${escapeHtml(heatmap.name)}" ` +
          `data-raw-value="${escapeHtml(cell.raw || "")}" data-value="${cell.value == null ? "" : cell.value}"/>`
        );
      });
    });

    offsetX += blockWidth + datasetGap;
  });
}

function drawCircularHeatmap(fragments, heatmapTips) {
  if (state.activeHeatmaps.length === 0 || state.layoutMode !== "circular") return;
  if (heatmapTips.length === 0) return;

  const cellDepth = 10;
  const cellArc = 0.028;
  const columnGap = 3;
  const datasetGap = 10;
  let datasetOffset = 18;
  const maxLabelRadius = Math.max(...heatmapTips.map(tip => tip.labelRadius), 0);

  state.activeHeatmaps.forEach(heatmap => {
    const columns = getHeatmapColumns(heatmap);
    if (columns.length === 0) return;
    const blockDepth = columns.length * (cellDepth + columnGap) - columnGap;
    const ringInner = maxLabelRadius + datasetOffset;
    const ringOuter = ringInner + blockDepth;

    fragments.push(`<circle cx="0" cy="0" r="${ringInner - 3}" class="heatmap-dataset-outline"/>`);
    fragments.push(`<circle cx="0" cy="0" r="${ringOuter + 3}" class="heatmap-dataset-outline"/>`);
    fragments.push(
      `<text x="${ringOuter + 8}" y="0" class="heatmap-dataset-title">${escapeHtml(heatmap.name)}</text>`
    );

    heatmapTips.forEach(tip => {
      const rowValues = heatmap.tip_values[tip.node.name];
      if (!rowValues) return;
      columns.forEach((column, index) => {
        const cell = rowValues[column];
        if (!cell) return;
        const innerR = ringInner + index * (cellDepth + columnGap);
        const outerR = innerR + cellDepth;
        const startAngle = tip.angle - cellArc / 2;
        const endAngle = tip.angle + cellArc / 2;
        const fill = getHeatmapColor(heatmap, cell.value);
        const cls = cell.value == null ? "heatmap-cell heatmap-cell-missing" : "heatmap-cell";
        fragments.push(buildAnnularCellPath(innerR, outerR, startAngle, endAngle, fill, cls, {
          tip: tip.node.name,
          column,
          dataset: heatmap.name,
          rawValue: cell.raw || "",
          value: cell.value == null ? "" : String(cell.value),
        }));
      });
    });

    datasetOffset += blockDepth + datasetGap;
  });
}

function buildAnnularCellPath(innerR, outerR, startAngle, endAngle, fill, cls, meta) {
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
  const x1 = innerR * Math.cos(startAngle);
  const y1 = innerR * Math.sin(startAngle);
  const x2 = outerR * Math.cos(startAngle);
  const y2 = outerR * Math.sin(startAngle);
  const x3 = outerR * Math.cos(endAngle);
  const y3 = outerR * Math.sin(endAngle);
  const x4 = innerR * Math.cos(endAngle);
  const y4 = innerR * Math.sin(endAngle);

  const attrs = [
    `fill="${fill}"`,
    `class="${cls}"`,
    'data-heatmap="1"',
    `data-heatmap-tip="${escapeHtml(meta.tip)}"`,
    `data-column="${escapeHtml(meta.column)}"`,
    `data-dataset="${escapeHtml(meta.dataset)}"`,
    `data-raw-value="${escapeHtml(meta.rawValue)}"`,
    `data-value="${escapeHtml(meta.value)}"`,
  ].join(" ");

  return `<path d="M${x1},${y1} L${x2},${y2} A${outerR},${outerR} 0 ${largeArc},1 ${x3},${y3} L${x4},${y4} A${innerR},${innerR} 0 ${largeArc},0 ${x1},${y1} Z" ${attrs}/>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function buildExportSVGString() {
  const original = document.getElementById("tree-svg");
  const clone = original.cloneNode(true);
  const cloneGroup = clone.querySelector("#tree-group");
  const bbox = dom.group.getBBox();
  const pad = 20;
  const vx = bbox.x - pad;
  const vy = bbox.y - pad;
  const vw = bbox.width + pad * 2;
  const vh = bbox.height + pad * 2;

  clone.setAttribute("viewBox", `${vx} ${vy} ${vw} ${vh}`);
  clone.setAttribute("width", vw);
  clone.setAttribute("height", vh);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  cloneGroup.removeAttribute("transform");

  for (const [selector, style] of Object.entries(getInlineStyles())) {
    clone.querySelectorAll(selector).forEach(element => {
      element.setAttribute("style", `${element.getAttribute("style") || ""};${style}`);
    });
  }

  return { svgString: new XMLSerializer().serializeToString(clone), width: vw, height: vh };
}

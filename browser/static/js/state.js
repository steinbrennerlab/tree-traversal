export const state = {
  // Data loading
  loaded: false,
  gene: null,
  nwkName: null,
  aaName: null,
  numSeqs: 0,
  numSpecies: 0,

  // Tree data
  treeData: null,
  fullTreeData: null,
  nodeById: {},
  parentMap: {},

  // Protein sequences (client-side)
  proteinSeqs: null,
  proteinSeqsUngapped: null,

  // Source texts (for sessions)
  sourceTexts: null,

  // Dataset storage
  datasetFiles: [],
  datasetTextsByName: {},
  parsedDatasets: {},
  activeHeatmaps: [],

  // Species & sequences
  speciesMap: {},
  tipToSpecies: {},
  speciesColors: {},
  allTipNames: [],
  tipLengths: {},
  hasFasta: false,

  // Selections & highlights
  selectedNodeTips: [],
  selectedTip: null,
  exportNodeId: null,
  nameMatches: new Set(),
  motifMatches: new Set(),
  sharedNodes: new Set(),
  motifList: [],

  // Tree view state
  collapsedNodes: new Set(),
  hiddenTips: new Set(),
  nodeLabels: {},
  nodeLabelIcons: {},
  labelFontSize: 10,

  // Layout & render
  layoutMode: "rectangular",
  usePhylogram: true,
  showTipLabels: true,
  tipLabelSize: 10,
  dotSize: 3,
  showBootstraps: false,
  showLengths: false,
  tipSpacing: 16,
  triangleScale: 100,
  uniformTriangles: false,
  fastMode: false,

  // Pan/zoom
  scale: 1,
  tx: 20,
  ty: 20,
  dragging: false,
  dragStartX: 0,
  dragStartY: 0,

  // Render optimization
  renderCache: null,
  renderCacheKey: null,

  // Undo/redo
  undoStack: [],
  redoStack: [],

  // Staged files from picker (before Load)
  stagedFiles: null,
};

export const dom = {
  svg: document.getElementById("tree-svg"),
  group: document.getElementById("tree-group"),
  tooltip: document.getElementById("tooltip"),
  setupOverlay: document.getElementById("setup-overlay"),
  setupLoadBtn: document.getElementById("setup-load"),
  setupError: document.getElementById("setup-error"),
  folderPicker: document.getElementById("folder-picker"),
  filePicker: document.getElementById("file-picker"),
  detectedFilesPanel: document.getElementById("detected-files"),
  detectedNwkSelect: document.getElementById("detected-nwk"),
  detectedAaSelect: document.getElementById("detected-aa"),
  detectedOrthoSpan: document.getElementById("detected-ortho"),
  detectedDatasetSpan: document.getElementById("detected-datasets"),
  setupLoadRow: document.getElementById("setup-load-row"),
};

export const PALETTE = [
  "#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4",
  "#42d4f4", "#f032e6", "#bfef45", "#fabed4", "#469990",
  "#dcbeff", "#9A6324", "#fffac8", "#800000", "#aaffc3",
  "#808000", "#ffd8b1", "#000075", "#a9a9a9", "#e6beff",
  "#1abc9c", "#d35400", "#2c3e50", "#8e44ad", "#16a085",
  "#c0392b", "#2980b9", "#f39c12", "#27ae60", "#e74c3c",
  "#9b59b6", "#1abc9c", "#34495e", "#e67e22", "#3498db",
  "#2ecc71", "#e91e63", "#00bcd4", "#ff9800", "#795548",
];

export const MOTIF_PALETTE = [
  "#e22222", "#2563eb", "#16a085", "#e67e22", "#8e44ad",
  "#c0392b", "#27ae60", "#d35400", "#2980b9", "#f39c12",
];

export function getInlineStyles() {
  return {
    ".tip-label": `font-size:${state.tipLabelSize}px;font-family:system-ui,sans-serif`,
    ".motif-match": "stroke:#e22;stroke-width:2",
    ".shared-node": "fill:#ff6600;stroke:#c40;stroke-width:1.5",
    ".collapsed-triangle": "fill:#cde;stroke:#89a",
    ".bootstrap-label": "font-size:8px;fill:#666",
    ".node-label": `font-size:${state.labelFontSize}px;font-weight:bold;fill:#333;font-family:system-ui,sans-serif`,
  };
}

export function resetClientState() {
  state.loaded = false;
  state.gene = null;
  state.nwkName = null;
  state.aaName = null;
  state.numSeqs = 0;
  state.numSpecies = 0;
  state.treeData = null;
  state.fullTreeData = null;
  state.nodeById = {};
  state.parentMap = {};
  state.proteinSeqs = null;
  state.proteinSeqsUngapped = null;
  state.sourceTexts = null;
  state.datasetFiles = [];
  state.datasetTextsByName = {};
  state.parsedDatasets = {};
  state.activeHeatmaps = [];
  state.speciesMap = {};
  state.tipToSpecies = {};
  state.speciesColors = {};
  state.allTipNames = [];
  state.tipLengths = {};
  state.hasFasta = false;
  state.selectedNodeTips = [];
  state.selectedTip = null;
  state.exportNodeId = null;
  state.nameMatches = new Set();
  state.motifMatches = new Set();
  state.sharedNodes = new Set();
  state.motifList = [];
  state.collapsedNodes = new Set();
  state.hiddenTips = new Set();
  state.nodeLabels = {};
  state.nodeLabelIcons = {};
  state.labelFontSize = 10;
  state.layoutMode = "rectangular";
  state.usePhylogram = true;
  state.showTipLabels = true;
  state.tipLabelSize = 10;
  state.dotSize = 3;
  state.showBootstraps = false;
  state.showLengths = false;
  state.tipSpacing = 16;
  state.triangleScale = 100;
  state.uniformTriangles = false;
  state.fastMode = false;
  state.scale = 1;
  state.tx = 20;
  state.ty = 20;
  state.dragging = false;
  state.dragStartX = 0;
  state.dragStartY = 0;
  state.renderCache = null;
  state.renderCacheKey = null;
  state.undoStack = [];
  state.redoStack = [];
  state.stagedFiles = null;
}

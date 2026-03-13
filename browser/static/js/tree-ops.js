/**
 * Tree operations for PhyloScope standalone mode.
 * Ports of tree manipulation functions from app.py.
 */

import { collectAllTipNames } from "./tree-utils.js";

/**
 * Convert a tree node to Newick string (no trailing semicolon).
 */
export function nodeToNewick(node) {
  if (node.ch && node.ch.length > 0) {
    const childStrs = node.ch.map(c => nodeToNewick(c)).join(",");
    let s = `(${childStrs})`;
    if (node.sup != null) {
      s += String(node.sup);
    } else if (node.name) {
      s += node.name;
    }
    if (node.bl != null && node.bl !== 0) {
      s += `:${node.bl}`;
    }
    return s;
  }
  let s = node.name || "";
  if (node.bl != null && node.bl !== 0) {
    s += `:${node.bl}`;
  }
  return s;
}

/**
 * Find a node by its ID in the tree.
 */
export function findNodeById(node, targetId) {
  if (node.id === targetId) return node;
  if (node.ch) {
    for (const c of node.ch) {
      const result = findNodeById(c, targetId);
      if (result) return result;
    }
  }
  return null;
}

/**
 * Annotate tips with species and internal nodes with descendant species sets.
 * Modifies the tree in-place.
 */
export function annotateSpecies(node, tipToSpecies) {
  if (!node.ch || node.ch.length === 0) {
    const sp = tipToSpecies[node.name] || "unknown";
    node.sp = sp;
    return new Set([sp]);
  }
  const descSpecies = new Set();
  for (const child of node.ch) {
    for (const sp of annotateSpecies(child, tipToSpecies)) {
      descSpecies.add(sp);
    }
  }
  node.descendant_species = [...descSpecies].sort();
  return descSpecies;
}

/**
 * Build species-to-tips and tip-to-species maps from orthofinder FASTA file texts.
 * @param {object} treeData - Tree root node.
 * @param {Array<{name: string, text: string}>} orthoFiles - Array of { name, text }.
 * @returns {{ speciesToTips: object, tipToSpecies: object }}
 */
export function buildSpeciesMapFromFiles(treeData, orthoFiles) {
  const treeTips = new Set(collectAllTipNames(treeData));
  const speciesToTips = {};
  const tipToSpecies = {};

  const REF_SPECIES = {
    "Pvul218cds": "Pvul",
    "TAIR10cds": "TAIR",
    "Vung469cds": "Vung",
    "Zmarina_668_v3.1.cds_primaryTranscriptOnly": "Zmarina",
  };

  const sorted = [...orthoFiles].sort((a, b) => a.name.localeCompare(b.name));

  for (const file of sorted) {
    let fname = file.name;
    if (fname.endsWith(".fasta")) fname = fname.slice(0, -6);
    else if (fname.endsWith(".fa")) fname = fname.slice(0, -3);

    let species;
    if (fname.startsWith("new_genomes.")) {
      const parts = fname.replace("new_genomes.", "").split(".");
      species = parts[0];
    } else {
      species = REF_SPECIES[fname] || fname;
    }

    const headers = new Set();
    for (const line of file.text.split(/\r?\n/)) {
      if (line.startsWith(">")) {
        headers.add(line.substring(1).trim().split(/\s+/)[0]);
      }
    }

    const matchingTips = [...headers].filter(h => treeTips.has(h)).sort();
    if (matchingTips.length > 0) {
      speciesToTips[species] = matchingTips;
      for (const tip of matchingTips) {
        tipToSpecies[tip] = species;
      }
    }
  }

  return { speciesToTips, tipToSpecies };
}

/**
 * Find nodes whose descendants include all required species and no excluded species.
 */
export function findNodesWithSpecies(node, requiredSpecies, excludedSpecies) {
  const required = requiredSpecies instanceof Set ? requiredSpecies : new Set(requiredSpecies);
  const excluded = excludedSpecies instanceof Set ? excludedSpecies : new Set(excludedSpecies || []);
  const result = [];

  function getDescSpecies(n) {
    if (!n.ch || n.ch.length === 0) {
      return new Set([n.sp || "unknown"]);
    }
    return new Set(n.descendant_species || []);
  }

  function walk(n) {
    const ds = getDescSpecies(n);
    let hasAll = true;
    for (const sp of required) {
      if (!ds.has(sp)) { hasAll = false; break; }
    }
    if (hasAll) {
      let hasExcluded = false;
      for (const sp of excluded) {
        if (ds.has(sp)) { hasExcluded = true; break; }
      }
      if (!hasExcluded) result.push(n.id);
    }
    if (n.ch) {
      for (const c of n.ch) walk(c);
    }
  }

  walk(node);
  return result;
}

/**
 * Re-root the tree at the given node ID.
 * Returns the new root node, or null if not found.
 */
export function rerootTree(treeData, targetId) {
  if (treeData.id === targetId) return treeData;

  const parentMap = {};
  function buildParentMap(node) {
    if (node.ch) {
      for (const c of node.ch) {
        parentMap[c.id] = node;
        buildParentMap(c);
      }
    }
  }
  buildParentMap(treeData);

  const target = findNodeById(treeData, targetId);
  if (!target) return null;

  const path = [target];
  let cur = target;
  while (parentMap[cur.id]) {
    cur = parentMap[cur.id];
    path.push(cur);
  }

  const origBls = path.map(n => n.bl);

  for (let i = 0; i < path.length - 1; i++) {
    const child = path[i];
    const parent = path[i + 1];
    parent.ch = parent.ch.filter(c => c.id !== child.id);
    if (!child.ch) child.ch = [];
    child.ch.push(parent);
  }

  for (let i = 0; i < path.length - 1; i++) {
    path[i + 1].bl = origBls[i];
  }
  target.bl = 0;

  const oldRoot = path[path.length - 1];
  if (oldRoot.ch && oldRoot.ch.length === 1) {
    const onlyChild = oldRoot.ch[0];
    onlyChild.bl = (onlyChild.bl || 0) + (oldRoot.bl || 0);
    if (oldRoot.sup != null && onlyChild.sup == null) {
      onlyChild.sup = oldRoot.sup;
    }
    if (path.length >= 2) {
      const newParent = path[path.length - 2];
      newParent.ch = newParent.ch.map(c => c.id === oldRoot.id ? onlyChild : c);
    }
  }

  let counter = 0;
  function reassignIds(node) {
    node.id = counter++;
    if (node.ch) {
      for (const c of node.ch) reassignIds(c);
    }
  }
  reassignIds(target);

  return target;
}

/**
 * Map 1-indexed reference residue positions to alignment column indices.
 */
export function refPosToColumns(refSeqGapped, refStart, refEnd) {
  let colStart = null;
  let colEnd = null;
  let residuePos = 0;
  for (let colIdx = 0; colIdx < refSeqGapped.length; colIdx++) {
    if (refSeqGapped[colIdx] !== "-") {
      residuePos++;
      if (residuePos === refStart && colStart === null) {
        colStart = colIdx;
      }
      if (residuePos === refEnd) {
        colEnd = colIdx + 1;
        break;
      }
    }
  }
  return [colStart, colEnd];
}

/**
 * Compute pairwise sequence identity between two gapped sequences.
 */
export function computePairwiseIdentity(seq1, seq2) {
  if (seq1.length !== seq2.length) {
    return { error: "Sequences have different lengths in alignment" };
  }
  let identical = 0;
  let aligned = 0;
  for (let i = 0; i < seq1.length; i++) {
    if (seq1[i] === "-" || seq2[i] === "-") continue;
    aligned++;
    if (seq1[i] === seq2[i]) identical++;
  }
  return {
    identity: aligned > 0 ? identical / aligned : 0,
    identical_positions: identical,
    aligned_length: aligned,
  };
}

/**
 * Build a FASTA string for export.
 * @param {string[]} tips - Tip names to include.
 * @param {object} proteinSeqs - Map of tip name -> gapped sequence.
 * @param {number|null} sliceStart - Start column (0-indexed), or null for full.
 * @param {number|null} sliceEnd - End column (0-indexed exclusive), or null for full.
 * @returns {string} FASTA content.
 */
export function buildExportFasta(tips, proteinSeqs, sliceStart, sliceEnd) {
  const lines = [];
  for (const tip of tips) {
    const seq = proteinSeqs[tip];
    if (!seq) continue;
    const sliced = (sliceStart != null && sliceEnd != null) ? seq.slice(sliceStart, sliceEnd) : seq;
    lines.push(`>${tip}`);
    for (let i = 0; i < sliced.length; i += 80) {
      lines.push(sliced.slice(i, i + 80));
    }
  }
  return lines.join("\n") + "\n";
}

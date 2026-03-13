/**
 * File loading infrastructure for PhyloScope standalone mode.
 * Handles folder/file picker input, detects file types, builds workspace.
 */

import { parseNewick, parseFastaText } from "./parsers.js";
import { annotateSpecies, buildSpeciesMapFromFiles } from "./tree-ops.js";

/**
 * Detect relevant files from a FileList/array of File objects.
 * @param {File[]} files - Array of File objects from folder or file picker.
 * @returns {object} Categorized file lists.
 */
export function detectFiles(files) {
  const nwkFiles = [];
  const aaFiles = [];
  const orthoFiles = [];
  const datasetFiles = [];

  const hasRelativePaths = Array.from(files).some(
    f => f.webkitRelativePath && f.webkitRelativePath.includes("/")
  );

  for (const file of files) {
    const relPath = file.webkitRelativePath || file.name;
    const name = file.name;

    if (hasRelativePaths) {
      if (relPath.includes("orthofinder-input/") || relPath.includes("orthofinder-input\\")) {
        if (name.endsWith(".fa") || name.endsWith(".fasta")) {
          orthoFiles.push(file);
        }
        continue;
      }
      if ((relPath.includes("dataset/") || relPath.includes("dataset\\")) && name.endsWith(".txt")) {
        if (!name.endsWith(":Zone.Identifier")) {
          datasetFiles.push(file);
        }
        continue;
      }
    }

    if (name.endsWith(".nwk")) {
      nwkFiles.push(file);
    } else if (name.endsWith(".aa.fa")) {
      aaFiles.push(file);
    } else if (!hasRelativePaths) {
      if ((name.endsWith(".fa") || name.endsWith(".fasta")) && !name.endsWith(".aa.fa")) {
        orthoFiles.push(file);
      } else if (name.endsWith(".txt") && !name.endsWith(":Zone.Identifier")) {
        datasetFiles.push(file);
      }
    }
  }

  return {
    nwkFiles: nwkFiles.sort((a, b) => a.name.localeCompare(b.name)),
    aaFiles: aaFiles.sort((a, b) => a.name.localeCompare(b.name)),
    orthoFiles: orthoFiles.sort((a, b) => a.name.localeCompare(b.name)),
    datasetFiles: datasetFiles.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/**
 * Load data from the selected files, building the full workspace.
 * @param {object} opts
 * @param {File} opts.nwkFile - The Newick tree file.
 * @param {File|null} opts.aaFile - The protein alignment file (optional).
 * @param {File[]} opts.orthoFiles - Orthofinder species FASTA files.
 * @param {File[]} opts.datasetFiles - Dataset .txt files.
 * @returns {Promise<{ success: boolean, error?: string, result?: object }>}
 */
export async function loadFromFiles({ nwkFile, aaFile, orthoFiles, datasetFiles }) {
  if (!nwkFile) return { success: false, error: "No tree file (.nwk) selected." };

  const nwkText = await nwkFile.text();
  const aaText = aaFile ? await aaFile.text() : null;
  const orthoTexts = orthoFiles
    ? await Promise.all(orthoFiles.map(async f => ({ name: f.name, text: await f.text() })))
    : [];
  const datasetTexts = await Promise.all(
    (datasetFiles || []).map(async f => ({ name: f.name, text: await f.text() }))
  );

  const treeData = parseNewick(nwkText);
  const gene = nwkFile.name.replace(/\.nwk$/, "");

  let proteinSeqs = null;
  let proteinSeqsUngapped = null;
  if (aaText) {
    proteinSeqs = parseFastaText(aaText);
    proteinSeqsUngapped = {};
    for (const [k, v] of Object.entries(proteinSeqs)) {
      proteinSeqsUngapped[k] = v.replace(/-/g, "");
    }
  }

  let speciesToTips = {};
  let tipToSpecies = {};
  if (orthoTexts.length > 0) {
    const mapping = buildSpeciesMapFromFiles(treeData, orthoTexts);
    speciesToTips = mapping.speciesToTips;
    tipToSpecies = mapping.tipToSpecies;
    annotateSpecies(treeData, tipToSpecies);
  }

  const hasFasta = proteinSeqs !== null;
  const tipLengths = {};
  if (proteinSeqsUngapped) {
    for (const [k, v] of Object.entries(proteinSeqsUngapped)) {
      tipLengths[k] = v.length;
    }
  }

  return {
    success: true,
    result: {
      treeData,
      gene,
      nwkName: nwkFile.name,
      aaName: aaFile ? aaFile.name : null,
      hasFasta,
      numSeqs: hasFasta ? Object.keys(proteinSeqs).length : 0,
      numSpecies: Object.keys(speciesToTips).length,
      proteinSeqs,
      proteinSeqsUngapped,
      speciesToTips,
      tipToSpecies,
      tipLengths,
      datasetFileNames: datasetTexts.map(d => d.name).sort(),
      sourceTexts: {
        nwk: nwkText,
        nwkName: nwkFile.name,
        aa: aaText,
        aaName: aaFile ? aaFile.name : null,
        ortho: orthoTexts,
        datasets: datasetTexts,
      },
    },
  };
}

/**
 * Reconstruct workspace from source texts (used for session loading).
 * Same as loadFromFiles but takes raw text content instead of File objects.
 */
export function loadFromSourceTexts(sourceTexts) {
  const nwkText = sourceTexts.nwk;
  const aaText = sourceTexts.aa;
  const orthoTexts = sourceTexts.ortho || [];
  const datasetTexts = sourceTexts.datasets || [];

  const treeData = parseNewick(nwkText);
  const gene = (sourceTexts.nwkName || "tree.nwk").replace(/\.nwk$/, "");

  let proteinSeqs = null;
  let proteinSeqsUngapped = null;
  if (aaText) {
    proteinSeqs = parseFastaText(aaText);
    proteinSeqsUngapped = {};
    for (const [k, v] of Object.entries(proteinSeqs)) {
      proteinSeqsUngapped[k] = v.replace(/-/g, "");
    }
  }

  let speciesToTips = {};
  let tipToSpecies = {};
  if (orthoTexts.length > 0) {
    const mapping = buildSpeciesMapFromFiles(treeData, orthoTexts);
    speciesToTips = mapping.speciesToTips;
    tipToSpecies = mapping.tipToSpecies;
  }

  const hasFasta = proteinSeqs !== null;
  const tipLengths = {};
  if (proteinSeqsUngapped) {
    for (const [k, v] of Object.entries(proteinSeqsUngapped)) {
      tipLengths[k] = v.length;
    }
  }

  return {
    treeData,
    gene,
    nwkName: sourceTexts.nwkName || "tree.nwk",
    aaName: sourceTexts.aaName || null,
    hasFasta,
    numSeqs: hasFasta ? Object.keys(proteinSeqs).length : 0,
    numSpecies: Object.keys(speciesToTips).length,
    proteinSeqs,
    proteinSeqsUngapped,
    speciesToTips,
    tipToSpecies,
    tipLengths,
    datasetFileNames: datasetTexts.map(d => d.name).sort(),
    sourceTexts,
  };
}

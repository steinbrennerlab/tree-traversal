/**
 * Client-side parsers for PhyloScope standalone mode.
 * Ports of the Python parsers from app.py.
 */

let _nodeCounter = 0;

/**
 * Parse a Newick string into the compact tree format { id, bl, name?, sup?, ch? }.
 */
export function parseNewick(s) {
  _nodeCounter = 0;
  s = s.trim().replace(/;+$/, "");
  const [node] = _parseNode(s, 0);
  return node;
}

function _parseNode(s, pos) {
  const children = [];
  if (pos < s.length && s[pos] === "(") {
    pos++;
    while (true) {
      const [child, newPos] = _parseNode(s, pos);
      pos = newPos;
      children.push(child);
      if (pos < s.length && s[pos] === ",") {
        pos++;
      } else {
        break;
      }
    }
    if (pos < s.length && s[pos] === ")") {
      pos++;
    }
  }

  let label = "";
  while (pos < s.length && !",):;".includes(s[pos])) {
    label += s[pos];
    pos++;
  }

  let bl = 0;
  if (pos < s.length && s[pos] === ":") {
    pos++;
    let blStr = "";
    while (pos < s.length && !",);".includes(s[pos])) {
      blStr += s[pos];
      pos++;
    }
    const parsed = parseFloat(blStr);
    bl = isNaN(parsed) ? 0 : parsed;
  }

  const nid = _nodeCounter++;

  let sup = null;
  let name = "";
  if (children.length > 0) {
    const num = parseFloat(label);
    if (!isNaN(num) && label.trim() !== "") {
      sup = num;
    } else {
      name = label;
    }
  } else {
    name = label;
  }

  const node = { id: nid, bl };
  if (name) node.name = name;
  if (sup !== null) node.sup = sup;
  if (children.length > 0) node.ch = children;

  return [node, pos];
}

/**
 * Parse FASTA text content into an object of { header: sequence }.
 */
export function parseFastaText(text) {
  const seqs = {};
  let current = null;
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith(">")) {
      current = line.substring(1).trim().split(/\s+/)[0];
      seqs[current] = [];
    } else if (current !== null) {
      seqs[current].push(line.trim());
    }
  }
  const result = {};
  for (const [k, v] of Object.entries(seqs)) {
    result[k] = v.join("");
  }
  return result;
}

/**
 * Convert a PROSITE-style pattern to a JavaScript regex string.
 */
export function prositeToRegex(pattern) {
  pattern = pattern.replace(/^\.+|\.+$/g, "").trim();
  const parts = pattern.split("-");
  const regexParts = [];
  for (const part of parts) {
    if (part === "x" || part === "X") {
      regexParts.push(".");
    } else if (part.startsWith("{") && part.endsWith("}")) {
      regexParts.push(`[^${part.slice(1, -1)}]`);
    } else if (part.startsWith("[") && part.endsWith("]")) {
      regexParts.push(part);
    } else if (part === "<") {
      regexParts.push("^");
    } else if (part === ">") {
      regexParts.push("$");
    } else {
      const m = part.match(/^(.+)\((\d+)(?:,(\d+))?\)$/);
      if (m) {
        const base = m[1];
        const baseRegex = prositeToRegex(base);
        if (m[3]) {
          regexParts.push(`(?:${baseRegex}){${m[2]},${m[3]}}`);
        } else {
          regexParts.push(`(?:${baseRegex}){${m[2]}}`);
        }
      } else {
        regexParts.push(part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      }
    }
  }
  return regexParts.join("");
}

/**
 * Parse a dataset cell into a number or null.
 */
export function parseNumericValue(value) {
  if (value == null) return null;
  const text = value.trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  if (lower === "na" || lower === "nan" || lower === "#num!" || lower === "null") return null;
  const num = parseFloat(text);
  return isNaN(num) ? null : num;
}

/**
 * Parse a tab-delimited dataset text, keeping only rows matching tree tips.
 * @param {string} text - Raw text content of the dataset file.
 * @param {string} name - Filename for the returned object.
 * @param {Set<string>} treeTips - Set of tip names present in the tree.
 * @returns {{ data: object|null, error: string|null }}
 */
export function parseDatasetText(text, name, treeTips) {
  const lines = text.split(/\r?\n/);
  const rows = lines.map(line => line.split("\t"));

  if (rows.length === 0 || (rows.length === 1 && rows[0].join("").trim() === "")) {
    return { data: null, error: "Dataset file is empty" };
  }

  const header = rows[0];
  if (header.length < 2) {
    return { data: null, error: "Dataset file must have a taxa column and at least one value column" };
  }

  const columns = header.slice(1);
  const tipValues = {};
  let matchedRowCount = 0;
  let unmatchedRowCount = 0;
  const matchedTipNames = [];
  let missingValueCount = 0;
  const numericValues = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;
    const tipName = (row[0] || "").trim();
    if (!tipName) continue;
    const values = row.slice(1);
    if (!treeTips.has(tipName)) {
      unmatchedRowCount++;
      continue;
    }
    matchedRowCount++;
    matchedTipNames.push(tipName);
    const rowValues = {};
    for (let idx = 0; idx < columns.length; idx++) {
      const rawValue = idx < values.length ? values[idx] : "";
      const numericValue = parseNumericValue(rawValue);
      if (numericValue === null) {
        missingValueCount++;
      } else {
        numericValues.push(numericValue);
      }
      rowValues[columns[idx]] = { raw: rawValue, value: numericValue };
    }
    tipValues[tipName] = rowValues;
  }

  const minValue = numericValues.length > 0 ? Math.min(...numericValues) : null;
  const maxValue = numericValues.length > 0 ? Math.max(...numericValues) : null;

  return {
    data: {
      name,
      columns,
      tip_values: tipValues,
      matched_tips: matchedTipNames.sort(),
      matched_row_count: matchedRowCount,
      unmatched_row_count: unmatchedRowCount,
      missing_value_count: missingValueCount,
      min_value: minValue,
      max_value: maxValue,
    },
    error: null,
  };
}

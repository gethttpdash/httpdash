'use strict';

// Runner data files: CSV (a header row, then one row per iteration) or a JSON array of objects.
// Kept apart from the runner so `httpdash mcp` can read one without loading the script sandbox.

function parseCsv(textInput) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = String(textInput).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; } else if (c === '"') inQuotes = false; else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x !== '')) rows.push(row);
  if (!rows.length) return [];
  const [header, ...data] = rows;
  return data.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] === undefined ? '' : r[i]])));
}

function parseDataFile(content, filename = '') {
  const trimmed = String(content).trim();
  if (/\.json$/i.test(filename) || trimmed.startsWith('[')) {
    const data = JSON.parse(trimmed);
    if (!Array.isArray(data)) throw new Error('JSON data file must contain an array of objects');
    return data;
  }
  return parseCsv(content);
}

module.exports = { parseCsv, parseDataFile };

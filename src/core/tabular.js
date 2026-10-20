'use strict';

/**
 * Turns JSON records into a flat table and writes it as CSV or as an Excel workbook (.xlsx).
 * The workbook is written directly (it's a zip of a few XML files), so no spreadsheet library
 * is needed.
 */
const zlib = require('zlib');

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Flattens records into { columns, rows }: nested objects become dotted columns ("address.city"),
 * arrays become JSON text. Columns keep the order they first appear in.
 */
function flatten(records, { maxColumns = 500 } = {}) {
  const columns = [];
  const seen = new Set();
  const flatRows = records.map((record) => {
    const out = {};
    const walk = (value, prefix) => {
      if (isObj(value) && Object.keys(value).length) {
        for (const [k, v] of Object.entries(value)) walk(v, prefix ? `${prefix}.${k}` : k);
        return;
      }
      const key = prefix || 'value';
      if (!seen.has(key) && columns.length < maxColumns) { seen.add(key); columns.push(key); }
      out[key] = Array.isArray(value) || isObj(value) ? JSON.stringify(value) : value;
    };
    walk(record, '');
    return out;
  });
  return { columns, rows: flatRows.map((r) => columns.map((c) => (c in r ? r[c] : null))) };
}

// RFC 4180: fields with commas, quotes or line breaks are quoted, and quotes doubled.
function toCsv({ columns, rows }) {
  const field = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns, ...rows].map((r) => r.map(field).join(',')).join('\r\n') + '\r\n';
}

// ---- .xlsx ----------------------------------------------------------------------------------

const xml = (s) => String(s)
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '') // not allowed in XML
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colName = (i) => { let s = ''; for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };
const MAX_CELL = 32767; // Excel's limit on characters in a cell

function sheetXml({ columns, rows }) {
  const cell = (v, ref, header) => {
    if (v === null || v === undefined || v === '') return '';
    if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
    if (typeof v === 'boolean') return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
    const text = String(v).slice(0, MAX_CELL);
    const keep = /^\s|\s$|\n/.test(text) ? ' xml:space="preserve"' : '';
    return `<c r="${ref}" t="inlineStr"${header ? ' s="1"' : ''}><is><t${keep}>${xml(text)}</t></is></c>`;
  };
  const row = (values, r, header) => `<row r="${r}">${values.map((v, c) => cell(v, `${colName(c)}${r}`, header)).join('')}</row>`;
  // Column widths from the first rows' contents, within sensible bounds.
  const widths = columns.map((c, i) => Math.min(60, Math.max(8, String(c).length + 2, ...rows.slice(0, 200).map((r) => (r[i] == null ? 0 : String(r[i]).length + 1)))));
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    + `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    + `<sheetData>${row(columns, 1, true)}${rows.map((r, i) => row(r, i + 2, false)).join('')}</sheetData>`
    + '</worksheet>';
}

// A zip file with deflated entries (enough for .xlsx).
function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.from(content);
    const packed = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc >>> 0, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc >>> 0, 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, packed);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + packed.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

/** An Excel workbook with one sheet: bold, frozen header row; numbers and booleans typed. */
function toXlsx(table, { sheetName = 'Data' } = {}) {
  const name = xml(String(sheetName).replace(/[[\]:*?/\\]/g, ' ').slice(0, 31) || 'Data');
  return zip([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
    ['xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf fontId="0" xfId="0"/><xf fontId="1" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'],
    ['xl/worksheets/sheet1.xml', sheetXml(table)],
  ]);
}

module.exports = { flatten, toCsv, toXlsx, colName };

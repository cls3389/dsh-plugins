"use strict";

/**
 * 轻量级 CSV 解析与格式化工具。
 * 不支持流式解析，适合 Kimi datasource 返回的小到中等 CSV。
 */

function parseCsv(text) {
  if (typeof text !== "string") return [];
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.trim()) return [];

  const rows = [];
  const len = normalized.length;
  let row = [];
  let field = "";
  let index = 0;
  let insideQuotes = false;

  while (index < len) {
    const char = normalized[index];
    const nextChar = normalized[index + 1];

    if (insideQuotes) {
      if (char === '"') {
        if (nextChar === '"') {
          field += '"';
          index += 2;
          continue;
        }
        insideQuotes = false;
        index++;
        continue;
      }
      field += char;
      index++;
      continue;
    }

    if (char === '"') {
      insideQuotes = true;
      index++;
      continue;
    }

    if (char === ",") {
      row.push(field);
      field = "";
      index++;
      continue;
    }

    if (char === "\n") {
      row.push(field);
      if (row.length > 1 || row[0] !== "" || (index > 0 && normalized[index - 1] === ",")) {
        rows.push(row);
      }
      row = [];
      field = "";
      index++;
      continue;
    }

    field += char;
    index++;
  }

  // 处理末尾无换行的情况
  row.push(field);
  if (row.length > 1 || row[0] !== "") {
    rows.push(row);
  }

  if (rows.length === 0) return [];

  const headers = rows[0].map((h) => String(h).trim());
  const records = [];
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
    const cells = rows[rowIndex];
    // 跳过完全空行
    if (cells.every((c) => c === "")) continue;
    const record = {};
    for (let colIndex = 0; colIndex < headers.length; colIndex++) {
      const key = headers[colIndex];
      const value = colIndex < cells.length ? cells[colIndex] : "";
      record[key] = value;
    }
    records.push(record);
  }
  return records;
}

module.exports = {
  parseCsv,
};

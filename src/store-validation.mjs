"use strict";
// Server-side store validation. Mirrors the rules in dist/store-data.js
// (StoreData.validate / validateRows / nextId) so the API enforces exactly
// what the browser enforces. Keep both in sync when the rules change.

export const REGION = [[139.7652, 35.6968], [139.7818, 35.7164]];
export const STATIONS = ["秋葉原", "御徒町", "上野"];
export const LABELS = { shop: "カードショップ", play: "対戦スペース", retail: "取扱店" };
const TYPES = Object.keys(LABELS);

function text(x, field) {
  if (typeof x !== "string" || !x.trim() || x.trim().length > 80) {
    throw new Error(field + "は1〜80文字で入力してください。");
  }
  return x.trim();
}

function coord(x, min, max, field) {
  if ((typeof x !== "number" && typeof x !== "string") || String(x).trim() === "" ||
      !Number.isFinite(Number(x)) || Number(x) < min || Number(x) > max) {
    throw new Error(field + "は " + min + "〜" + max + " の範囲で入力してください。");
  }
  return Number(x);
}

export function validate(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
      typeof raw.id !== "string" || !/^[0-9]{2,4}$/.test(raw.id)) {
    throw new Error("店舗IDが正しくありません。");
  }
  if (!STATIONS.includes(raw.station)) throw new Error("最寄り駅を選んでください。");
  if (!TYPES.includes(raw.type)) throw new Error("店舗タイプを選んでください。");
  return {
    id: raw.id,
    name: text(raw.name, "店舗名"),
    station: raw.station,
    area: text(raw.area, "エリア"),
    type: raw.type,
    lat: coord(raw.lat, REGION[0][1], REGION[1][1], "緯度"),
    lon: coord(raw.lon, REGION[0][0], REGION[1][0], "経度"),
  };
}

export function validateRows(list) {
  if (!Array.isArray(list) || list.length > 250) {
    throw new Error("店舗一覧は250件以下の配列にしてください。");
  }
  const clean = list.map(validate);
  if (new Set(clean.map((r) => r.id)).size !== clean.length) {
    throw new Error("同じ店舗IDが複数あります。");
  }
  return clean;
}

export function nextId(rows) {
  const used = new Set(rows.map((r) => r.id));
  for (let i = 1; i < 10000; i++) {
    const id = String(i).padStart(2, "0");
    if (!used.has(id)) return id;
  }
  throw new Error("店舗IDを作れませんでした。");
}

"use strict";
// Server-side store validation. Mirrors the rules in dist/store-data.js
// (StoreData.validate / validateRows / nextId) so the API enforces exactly
// what the browser enforces. Keep both in sync when the rules change.

export const REGION = [[122.0, 24.0], [146.0, 45.6]];
export const STATIONS = ["札幌", "旭川", "仙台", "盛岡", "秋田", "山形", "福島", "宇都宮", "高崎", "新潟", "長野", "金沢", "秋葉原", "御徒町", "上野", "東京", "新宿", "渋谷", "池袋", "横浜", "川崎", "千葉", "大宮", "静岡", "名古屋", "京都", "大阪", "難波", "神戸", "岡山", "広島", "松山", "高知", "博多", "小倉", "熊本", "鹿児島中央", "那覇"];
export const STATION_POINTS = {"札幌":[43.0687,141.3508],"旭川":[43.7628,142.3589],"仙台":[38.2601,140.8824],"盛岡":[39.7014,141.1365],"秋田":[39.7168,140.1298],"山形":[38.2486,140.3272],"福島":[37.7543,140.459],"宇都宮":[36.5593,139.8986],"高崎":[36.3227,139.013],"新潟":[37.9119,139.0617],"長野":[36.6436,138.1889],"金沢":[36.5783,136.6478],"秋葉原":[35.6982,139.773],"御徒町":[35.7073,139.7745],"上野":[35.7138,139.7773],"東京":[35.6812,139.7671],"新宿":[35.6896,139.7006],"渋谷":[35.658,139.7016],"池袋":[35.7289,139.7104],"横浜":[35.4657,139.6224],"川崎":[35.5316,139.697],"千葉":[35.6132,140.1135],"大宮":[35.9065,139.6239],"静岡":[34.9717,138.3889],"名古屋":[35.1706,136.8816],"京都":[34.9855,135.7585],"大阪":[34.7024,135.4959],"難波":[34.6669,135.5008],"神戸":[34.6946,135.1949],"岡山":[34.6663,133.9186],"広島":[34.3977,132.4753],"松山":[33.8402,132.7517],"高知":[33.5471,133.5435],"博多":[33.5897,130.4207],"小倉":[33.887,130.8827],"熊本":[32.79,130.6889],"鹿児島中央":[31.5834,130.5419],"那覇":[26.2159,127.667]};
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
      typeof raw.id !== "string" || !/^[0-9]{2,5}$/.test(raw.id)) {
    throw new Error("店舗IDが正しくありません。");
  }
  if (!STATIONS.includes(raw.station)) throw new Error("最寄り駅を選んでください。");
  if (!TYPES.includes(raw.type)) throw new Error("店舗タイプを選んでください。");
  // Existence proof: a store counts as verified only with an https source
  // URL recorded as evidence. verified_at is stamped by the server.
  const verified = raw.verified === true || raw.verified === 1;
  let sourceUrl = null;
  if (raw.source_url !== undefined && raw.source_url !== null && raw.source_url !== "") {
    if (typeof raw.source_url !== "string" || raw.source_url.length > 300 || !raw.source_url.startsWith("https://")) {
      throw new Error("出典URLは https:// で始まる300文字以内のURLで入力してください。");
    }
    sourceUrl = raw.source_url;
  }
  if (verified && !sourceUrl) throw new Error("実在確認には出典URLが必要です。");
  return {
    id: raw.id,
    name: text(raw.name, "店舗名"),
    station: raw.station,
    area: text(raw.area, "エリア"),
    type: raw.type,
    lat: coord(raw.lat, REGION[0][1], REGION[1][1], "緯度"),
    lon: coord(raw.lon, REGION[0][0], REGION[1][0], "経度"),
    verified,
    source_url: sourceUrl,
    verified_at: verified && typeof raw.verified_at === "string" ? raw.verified_at : null,
  };
}

export function validateRows(list) {
  if (!Array.isArray(list) || list.length > 20000) {
    throw new Error("店舗一覧は20000件以下の配列にしてください。");
  }
  const clean = list.map(validate);
  if (new Set(clean.map((r) => r.id)).size !== clean.length) {
    throw new Error("同じ店舗IDが複数あります。");
  }
  return clean;
}

export function nextId(rows) {
  const used = new Set(rows.map((r) => r.id));
  for (let i = 1; i < 100000; i++) {
    const id = String(i).padStart(5, "0");
    if (!used.has(id)) return id;
  }
  throw new Error("店舗IDを作れませんでした。");
}

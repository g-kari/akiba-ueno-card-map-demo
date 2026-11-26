-- akiba-card-map initial schema + seed data.
-- The OIDC sub is stored only in accounts.sub; the rest of the app uses the
-- internal accounts.id. Sessions and OAuth states store hashes / short-lived
-- values only.

CREATE TABLE accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sub TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE stores (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  station TEXT NOT NULL,
  area TEXT NOT NULL,
  type TEXT NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  updated_at TEXT,
  updated_by INTEGER REFERENCES accounts (id)
);

-- Seed: the 9 fictional stores from dist/stores.csv (the CSV stays the
-- human-edited source for the seed; this migration is its D1 form).
INSERT INTO stores (id, name, station, area, type, lat, lon) VALUES
  ('01', 'アキバ・デッキラボ', '秋葉原', '外神田', 'shop', 35.7002, 139.7708),
  ('02', '万世橋カードスタンド', '秋葉原', '神田須田町', 'retail', 35.6979, 139.7704),
  ('03', '電気街プレイテーブル', '秋葉原', '外神田', 'play', 35.6994, 139.7730),
  ('04', '末広町スリーブルーム', '秋葉原', '末広町', 'shop', 35.7037, 139.7693),
  ('05', '御徒町カード書架', '御徒町', '上野', 'shop', 35.7064, 139.7735),
  ('06', '仲御徒町ゲーム卓', '御徒町', '台東', 'play', 35.7057, 139.7767),
  ('07', 'アメ横トレカ売店', '御徒町', '上野', 'retail', 35.7089, 139.7746),
  ('08', '上野デッキ工房', '上野', '東上野', 'shop', 35.7107, 139.7787),
  ('09', '公園口カードテーブル', '上野', '上野公園', 'play', 35.7136, 139.7747);

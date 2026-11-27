"use strict";
// Database providers.
//
// The worker never touches a database API directly; it uses the small
// repository interface below, and the DB_PROVIDER variable selects the
// implementation:
//
//   DB_PROVIDER=d1      (default) Cloudflare D1 via the DB binding.
//   DB_PROVIDER=memory  In-process memory. For local development and
//                       tests; data is lost when the process restarts.
//
// To add another provider (for example an HTTP SQL service), implement
// the same methods and register it in createDb(). Methods that write a
// store take the validated record plus the server-stamped fields.

const STORE_COLUMNS = "id, name, station, area, type, lat, lon, verified, source_url, verified_at";

const SQL = {
  listStores: "SELECT " + STORE_COLUMNS + " FROM stores ORDER BY id",
  listStoreIds: "SELECT id FROM stores ORDER BY id",
  storeSummary: "SELECT station, COUNT(*) AS n FROM stores GROUP BY station",
  insertStore: "INSERT INTO stores (id, name, station, area, type, lat, lon, verified, source_url, verified_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  updateStore: "UPDATE stores SET name = ?, station = ?, area = ?, type = ?, lat = ?, lon = ?, verified = ?, source_url = ?, verified_at = ?, updated_at = ?, updated_by = ? WHERE id = ?",
  deleteStore: "DELETE FROM stores WHERE id = ?",
  clearStores: "DELETE FROM stores",
  insertEvent: "INSERT INTO events (store_id, kind, created_at) VALUES (?, ?, ?)",
  eventStats: "SELECT store_id, kind, COUNT(*) AS n FROM events GROUP BY store_id, kind",
  accountBySub: "SELECT id FROM accounts WHERE sub = ?",
  insertAccount: "INSERT OR IGNORE INTO accounts (sub, created_at) VALUES (?, ?)",
  insertState: "INSERT INTO oauth_states (state, nonce, code_verifier, expires_at) VALUES (?, ?, ?, ?)",
  stateById: "SELECT nonce, code_verifier, expires_at FROM oauth_states WHERE state = ?",
  deleteState: "DELETE FROM oauth_states WHERE state = ?",
  insertSession: "INSERT INTO sessions (token_hash, account_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
  sessionByHash: "SELECT account_id, expires_at FROM sessions WHERE token_hash = ?",
  deleteSession: "DELETE FROM sessions WHERE token_hash = ?",
};

// Builds the WHERE clause + bind args for a filtered store query.
// Supported filters (all optional, combined with AND): station (exact),
// id (exact), bbox ([minLon, minLat, maxLon, maxLat], inclusive).
function storeFilterSql(q) {
  const where = [];
  const args = [];
  if (q.station) { where.push("station = ?"); args.push(q.station); }
  if (q.id) { where.push("id = ?"); args.push(q.id); }
  if (q.bbox) {
    where.push("lon >= ? AND lon <= ? AND lat >= ? AND lat <= ?");
    args.push(q.bbox[0], q.bbox[2], q.bbox[1], q.bbox[3]);
  }
  return { clause: where.length ? " WHERE " + where.join(" AND ") : "", args };
}

function storeArgs(rec, updatedAt, updatedBy) {
  return [rec.name, rec.station, rec.area, rec.type, rec.lat, rec.lon,
    rec.verified ? 1 : 0, rec.source_url, rec.verified_at, updatedAt, updatedBy];
}

function d1Db(d1) {
  return {
    async listStores() {
      const { results } = await d1.prepare(SQL.listStores).all();
      return results;
    },
    // Filtered, paged read for the public API. Returns the page rows plus
    // the total number of rows matching the filter (before paging), so the
    // client can tell when a view is truncated. The count and the page run
    // as one D1 batch (a single round trip) instead of two sequential
    // queries; providers without batch() fall back to the sequential pair.
    async queryStores(q) {
      const { clause, args } = storeFilterSql(q);
      const countStmt = d1.prepare("SELECT COUNT(*) AS n FROM stores" + clause).bind(...args);
      const pageStmt = d1.prepare(
        "SELECT " + STORE_COLUMNS + " FROM stores" + clause + " ORDER BY id LIMIT ? OFFSET ?"
      ).bind(...args, q.limit, q.offset);
      if (typeof d1.batch === "function") {
        const [countRes, pageRes] = await d1.batch([countStmt, pageStmt]);
        const countRow = countRes.results && countRes.results[0];
        return { total: countRow ? countRow.n : 0, rows: pageRes.results };
      }
      const countRow = await countStmt.first();
      const { results } = await pageStmt.all();
      return { total: countRow ? countRow.n : 0, rows: results };
    },
    // Counts only (total + per-station); never returns store records.
    async storeSummary() {
      const { results } = await d1.prepare(SQL.storeSummary).all();
      return { total: results.reduce((sum, r) => sum + r.n, 0), stations: results };
    },
    async listStoreIds() {
      const { results } = await d1.prepare(SQL.listStoreIds).all();
      return results.map((r) => r.id);
    },
    async insertStore(rec, updatedAt, updatedBy) {
      await d1.prepare(SQL.insertStore).bind(rec.id, ...storeArgs(rec, updatedAt, updatedBy)).run();
    },
    async updateStore(id, rec, updatedAt, updatedBy) {
      const res = await d1.prepare(SQL.updateStore).bind(...storeArgs(rec, updatedAt, updatedBy), id).run();
      return Boolean(res.meta && res.meta.changes > 0);
    },
    async deleteStore(id) {
      const res = await d1.prepare(SQL.deleteStore).bind(id).run();
      return Boolean(res.meta && res.meta.changes > 0);
    },
    async clearStores() { await d1.prepare(SQL.clearStores).run(); },
    async insertEvent(storeId, kind, at) {
      await d1.prepare(SQL.insertEvent).bind(storeId, kind, at).run();
    },
    async eventStats() {
      const { results } = await d1.prepare(SQL.eventStats).all();
      return results;
    },
    async accountIdBySub(sub) {
      const row = await d1.prepare(SQL.accountBySub).bind(sub).first();
      return row ? row.id : null;
    },
    async ensureAccount(sub, at) {
      await d1.prepare(SQL.insertAccount).bind(sub, at).run();
      return this.accountIdBySub(sub);
    },
    async insertState(state, nonce, verifier, expiresAt) {
      await d1.prepare(SQL.insertState).bind(state, nonce, verifier, expiresAt).run();
    },
    async stateById(state) {
      return d1.prepare(SQL.stateById).bind(state).first();
    },
    async deleteState(state) { await d1.prepare(SQL.deleteState).bind(state).run(); },
    async insertSession(tokenHash, accountId, expiresAt, createdAt) {
      await d1.prepare(SQL.insertSession).bind(tokenHash, accountId, expiresAt, createdAt).run();
    },
    async sessionByHash(tokenHash) {
      return d1.prepare(SQL.sessionByHash).bind(tokenHash).first();
    },
    async deleteSession(tokenHash) { await d1.prepare(SQL.deleteSession).bind(tokenHash).run(); },
  };
}

function memoryDb() {
  const stores = new Map();
  const events = [];
  const accounts = new Map();
  const states = new Map();
  const sessions = new Map();
  let nextAccountId = 1;
  return {
    async listStores() {
      return [...stores.values()].sort((a, b) => a.id.localeCompare(b.id)).map((r) => ({ ...r }));
    },
    async queryStores(q) {
      let rows = [...stores.values()];
      if (q.station) rows = rows.filter((r) => r.station === q.station);
      if (q.id) rows = rows.filter((r) => r.id === q.id);
      if (q.bbox) {
        rows = rows.filter((r) => r.lon >= q.bbox[0] && r.lon <= q.bbox[2] && r.lat >= q.bbox[1] && r.lat <= q.bbox[3]);
      }
      rows.sort((a, b) => a.id.localeCompare(b.id));
      const total = rows.length;
      return { total, rows: rows.slice(q.offset, q.offset + q.limit).map((r) => ({ ...r })) };
    },
    async storeSummary() {
      const counts = new Map();
      for (const r of stores.values()) counts.set(r.station, (counts.get(r.station) || 0) + 1);
      const stations = [...counts.entries()]
        .map(([station, n]) => ({ station, n }))
        .sort((a, b) => a.station.localeCompare(b.station));
      return { total: stores.size, stations };
    },
    async listStoreIds() {
      return [...stores.keys()].sort();
    },
    async insertStore(rec, updatedAt, updatedBy) {
      stores.set(rec.id, {
        id: rec.id, name: rec.name, station: rec.station, area: rec.area, type: rec.type,
        lat: rec.lat, lon: rec.lon, verified: rec.verified ? 1 : 0,
        source_url: rec.source_url, verified_at: rec.verified_at,
        updated_at: updatedAt, updated_by: updatedBy,
      });
    },
    async updateStore(id, rec, updatedAt, updatedBy) {
      if (!stores.has(id)) return false;
      await this.insertStore({ ...rec, id }, updatedAt, updatedBy);
      return true;
    },
    async deleteStore(id) { return stores.delete(id); },
    async clearStores() { stores.clear(); },
    async insertEvent(storeId, kind, at) { events.push({ store_id: storeId, kind, created_at: at }); },
    async eventStats() {
      const map = new Map();
      for (const e of events) {
        const key = e.store_id + "|" + e.kind;
        map.set(key, (map.get(key) || 0) + 1);
      }
      return [...map.entries()].map(([key, n]) => {
        const [store_id, kind] = key.split("|");
        return { store_id, kind, n };
      });
    },
    async accountIdBySub(sub) {
      const row = accounts.get(sub);
      return row ? row.id : null;
    },
    async ensureAccount(sub, at) {
      if (!accounts.has(sub)) accounts.set(sub, { id: nextAccountId++, sub, created_at: at });
      return accounts.get(sub).id;
    },
    async insertState(state, nonce, verifier, expiresAt) {
      states.set(state, { nonce, code_verifier: verifier, expires_at: expiresAt });
    },
    async stateById(state) { return states.get(state) ?? null; },
    async deleteState(state) { states.delete(state); },
    async insertSession(tokenHash, accountId, expiresAt, createdAt) {
      sessions.set(tokenHash, { account_id: accountId, expires_at: expiresAt, created_at: createdAt });
    },
    async sessionByHash(tokenHash) { return sessions.get(tokenHash) ?? null; },
    async deleteSession(tokenHash) { sessions.delete(tokenHash); },
  };
}

let memorySingleton = null;

export function createDb(env) {
  const name = env.DB_PROVIDER || "d1";
  if (name === "d1") {
    if (!env.DB) throw new Error("DB_PROVIDER=d1 には D1 バインディング（DB）が必要です。");
    return d1Db(env.DB);
  }
  if (name === "memory") {
    if (!memorySingleton) memorySingleton = memoryDb();
    return memorySingleton;
  }
  throw new Error("DB_PROVIDER の値が不正です: " + name);
}

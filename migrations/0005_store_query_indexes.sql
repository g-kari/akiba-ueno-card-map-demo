-- Indexes for the public store API's filtered queries: station exact
-- match (station = ?) and map-viewport bounding boxes (lon/lat ranges).
-- The unfiltered full-table read is no longer used by the API.
CREATE INDEX IF NOT EXISTS idx_stores_station ON stores (station);
CREATE INDEX IF NOT EXISTS idx_stores_lon_lat ON stores (lon, lat);

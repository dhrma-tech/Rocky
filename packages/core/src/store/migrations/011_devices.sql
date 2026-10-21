-- Paired phones (roadmap A3, D-064): each holds a long-lived device cookie; only its SHA-256 is
-- stored. Revoking keeps the row for the record. Reversible: 011_devices.down.sql.
create table devices (
  id text primary key,
  name text not null,
  token_hash text not null unique,
  created_at integer not null,
  expires_at integer not null,
  last_seen_at integer,
  revoked_at integer
);

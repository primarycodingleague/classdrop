-- ClassDrop sync schema. Plain Postgres; also runs unchanged on PGlite for local work.
-- Every school's classroom data lives in `records` as JSON documents keyed by
-- (school, collection, key), versioned by one global sequence so a client can ask
-- "everything after version N". Credentials never live in records.

create table if not exists schools_meta (
  id          text primary key,
  name        text not null,
  created_at  timestamptz not null default now()
);

-- staff sign in with email + password; pupils with class code + PIN; parents with a code
create table if not exists accounts (
  school_id   text not null,
  user_id     text not null,
  email       text not null unique,
  pass_hash   text not null,
  created_at  timestamptz not null default now(),
  primary key (school_id, user_id)
);

alter table accounts add column if not exists mfa_secret text;
alter table accounts add column if not exists mfa_enabled boolean not null default false;

create table if not exists pupil_pins (
  school_id   text not null,
  user_id     text not null,
  pin_hash    text not null,
  updated_at  timestamptz not null default now(),
  primary key (school_id, user_id)
);

create table if not exists sessions (
  token_hash  text primary key,
  school_id   text not null,
  user_id     text not null,
  role        text not null,          -- staff | student | parent
  child_id    text,                   -- parents only
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
create index if not exists sessions_expiry on sessions (expires_at);

create sequence if not exists record_version;

create table if not exists records (
  school_id   text not null,
  collection  text not null,
  key         text not null,
  doc         jsonb,                  -- null when deleted (tombstone)
  deleted     boolean not null default false,
  version     bigint not null,
  updated_at  timestamptz not null default now(),
  updated_by  text,
  primary key (school_id, collection, key)
);
create index if not exists records_by_version on records (school_id, version);

-- who read or exported sensitive data, for the DSL and the office
create table if not exists access_log (
  id          bigserial primary key,
  school_id   text not null,
  user_id     text not null,
  kind        text not null,          -- safeguarding-read | export-pupil | erase-pupil
  detail      jsonb,
  at          timestamptz not null default now()
);
create index if not exists access_log_school on access_log (school_id, at);

create table if not exists media (
  school_id   text not null,
  id          text not null,          -- sha256 of the bytes, hex
  mime        text not null,
  bytes       bigint not null,
  owner_id    text,
  created_at  timestamptz not null default now(),
  primary key (school_id, id)
);

-- =====================================================================
--  REHOTEQ FIELD — V1 Database Schema
--  Postgres (Supabase) · Row Level Security on every table
--  Design rules:
--    · every mutable table carries local_id + sync_state (offline-first)
--    · soft delete everywhere (deleted_at) — deleted evidence is worse
--      than no evidence
--    · jobs lock after sign-off (locked_at) — that is what makes a
--      job card evidence rather than a note
-- =====================================================================

create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";       -- gen_random_uuid, digest
create extension if not exists "vector";         -- pgvector, for V3 RAG

-- ---------- enums ----------------------------------------------------
create type user_role      as enum ('technician','supervisor','admin');
create type plan_tier      as enum ('free','pro','business','enterprise');
create type trade_type     as enum ('electrical','solar','cctv','networking',
                                    'generator','hvac','plumbing','electronics','other');
create type job_status     as enum ('draft','in_progress','completed','sent','cancelled');
create type photo_stage    as enum ('before','during','after','serial','damage','other');
create type quote_status   as enum ('draft','sent','accepted','declined','expired');
create type sync_state     as enum ('synced','pending','conflict','failed');

-- =====================================================================
--  ORGANISATIONS & USERS
-- =====================================================================
create table organisations (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  slug          text unique not null,
  logo_url      text,
  brand_color   text default '#0E7C5A',
  address       text,
  phone         text,
  email         text,
  bank_name     text,
  bank_account  text,
  bank_sort     text,
  plan          plan_tier not null default 'free',
  seats         int not null default 1,
  created_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

create table users (
  id            uuid primary key references auth.users on delete cascade,
  org_id        uuid references organisations(id) on delete set null,
  full_name     text not null,
  phone         text unique not null,
  role          user_role not null default 'technician',
  -- default trade pre-selects the Home screen grid
  default_trade trade_type,
  signature_url text,
  -- RehoVerify (V3): verified professional reputation
  is_verified   boolean not null default false,
  verified_at   timestamptz,
  rating_avg    numeric(3,2),
  jobs_completed int not null default 0,
  plan          plan_tier not null default 'free',
  created_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

-- =====================================================================
--  CUSTOMERS · SITES · EQUIPMENT
--  sites is separate from customers: one customer, many locations, is
--  normal. getting this wrong early is expensive later.
-- =====================================================================
create table customers (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references users(id) on delete cascade,
  org_id      uuid references organisations(id) on delete cascade,
  name        text not null,
  phone       text,
  alt_phone   text,
  email       text,
  address     text,
  city        text,
  state       text,
  notes       text,
  local_id    text,                       -- client-generated, offline writes
  sync_state  sync_state not null default 'synced',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index idx_customers_owner on customers(owner_id);
create index idx_customers_name  on customers using gin(to_tsvector('simple', name));

create table sites (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id) on delete cascade,
  label       text,                        -- "Main house", "Shop 2", "Generator house"
  address     text,
  latitude    double precision,
  longitude   double precision,
  gps_accuracy double precision,
  notes       text,
  local_id    text,
  sync_state  sync_state not null default 'synced',
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index idx_sites_customer on sites(customer_id);

-- equipment is a FIRST-CLASS entity, never a free-text field.
-- serial numbers + install dates + warranty are what make Proof and
-- Passport possible at all.
create table equipment (
  id              uuid primary key default gen_random_uuid(),
  site_id         uuid not null references sites(id) on delete cascade,
  category        text not null,           -- inverter | battery | panel | cctv_nvr | router | generator ...
  brand           text,
  model           text,
  serial_number   text,
  capacity        text,                    -- "6.2 kVA", "10 kWh", "8 x 600 W"
  voltage         text,
  install_date    date,
  warranty_months int,
  -- Solar Passport (V1.5): public QR slug
  passport_slug   text unique,
  qr_code_url     text,
  photo_url       text,
  nameplate_url   text,
  -- V2 vision identification confidence loop
  identified_by   text check (identified_by in ('manual','vision','catalogue')),
  ident_confidence numeric(4,3),
  metadata        jsonb not null default '{}',
  local_id        text,
  sync_state      sync_state not null default 'synced',
  created_at      timestamptz not null default now(),
  deleted_at      timestamptz
);
create index idx_equipment_site    on equipment(site_id);
create index idx_equipment_serial  on equipment(serial_number);
create index idx_equipment_slug    on equipment(passport_slug);

-- =====================================================================
--  JOBS  (the core entity)
-- =====================================================================
create table jobs (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid references organisations(id) on delete cascade,
  technician_id   uuid not null references users(id) on delete cascade,
  customer_id     uuid references customers(id) on delete set null,
  site_id         uuid references sites(id) on delete set null,
  equipment_id    uuid references equipment(id) on delete set null,
  trade           trade_type not null,
  job_type        text not null,           -- "inverter_fault", "solar_install", "cctv_service"
  reference       text unique not null,    -- RF-2026-00184
  status          job_status not null default 'draft',

  fault_reported  text,
  diagnosis       text,
  diagnosis_source text check (diagnosis_source in ('manual','library','ai')),
  diagnosis_confirmed boolean,             -- human-in-the-loop gate for AI (V3)
  work_performed  text,
  recommendation  text,

  latitude        double precision,
  longitude       double precision,
  gps_accuracy    double precision,
  started_at      timestamptz,
  completed_at    timestamptz,
  locked_at       timestamptz,             -- set on sign-off → read-only = evidence

  labour_cost     numeric(12,2) default 0,
  materials_cost  numeric(12,2) default 0,
  total_cost      numeric(12,2) default 0,
  currency        text not null default 'NGN',

  -- tamper-evident chain: hash of (report content + previous job hash)
  content_hash    text,
  prev_hash       text,

  local_id        text,
  sync_state      sync_state not null default 'synced',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);
create index idx_jobs_tech    on jobs(technician_id, created_at desc);
create index idx_jobs_org     on jobs(org_id, created_at desc);
create index idx_jobs_cust    on jobs(customer_id);
create index idx_jobs_status  on jobs(status);

-- =====================================================================
--  CHECKLISTS
-- =====================================================================
create table checklist_templates (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid references organisations(id) on delete cascade,  -- null = system default
  trade       trade_type not null,
  job_type    text not null,
  name        text not null,
  version     int not null default 1,
  is_default  boolean not null default false,
  created_at  timestamptz not null default now()
);

create table checklist_items (
  id            uuid primary key default gen_random_uuid(),
  template_id   uuid not null references checklist_templates(id) on delete cascade,
  sort_order    int not null,
  label         text not null,
  help_text     text,
  requires_photo boolean not null default false,
  is_critical   boolean not null default false,  -- blocks completion if failed
  created_at    timestamptz not null default now()
);

create table checklist_runs (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references jobs(id) on delete cascade,
  template_id uuid not null references checklist_templates(id),
  template_version int not null,
  completed_at timestamptz,
  local_id    text,
  sync_state  sync_state not null default 'synced'
);

create table checklist_results (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid not null references checklist_runs(id) on delete cascade,
  item_label  text not null,
  passed      boolean,
  note        text,
  photo_url   text,
  created_at  timestamptz not null default now()
);

-- =====================================================================
--  PHOTOS  (evidence)
-- =====================================================================
create table job_photos (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid not null references jobs(id) on delete cascade,
  stage         photo_stage not null default 'other',
  storage_path  text,                      -- Supabase Storage path
  local_path    text,                      -- on-device path until uploaded
  url           text,
  caption       text,
  -- integrity
  sha256        text not null,
  byte_size     int,
  -- provenance stamped onto the image itself
  latitude      double precision,
  longitude     double precision,
  captured_at   timestamptz not null default now(),
  device_info   text,
  -- data-cost control
  uploaded      boolean not null default false,
  upload_state  sync_state not null default 'pending',
  created_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create index idx_photos_job on job_photos(job_id);

-- =====================================================================
--  MATERIALS
-- =====================================================================
create table job_materials (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references jobs(id) on delete cascade,
  description text not null,
  quantity    numeric(10,2) not null default 1,
  unit        text default 'pcs',
  unit_cost   numeric(12,2) default 0,
  unit_price  numeric(12,2) default 0,
  -- feeds the parts price index (a later product in its own right)
  part_key    text,
  local_id    text,
  sync_state  sync_state not null default 'synced',
  created_at  timestamptz not null default now()
);
create index idx_materials_job on job_materials(job_id);
create index idx_materials_key on job_materials(part_key);

-- =====================================================================
--  SIGNATURES · EVIDENCE PACKS · REPORTS
-- =====================================================================
create table signatures (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references jobs(id) on delete cascade,
  role        text not null check (role in ('customer','technician','supervisor')),
  signer_name text not null,
  image_url   text,
  signed_at   timestamptz not null default now(),
  ip_address  inet,
  device_info text
);
create index idx_signatures_job on signatures(job_id);

create table evidence_packs (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid not null references jobs(id) on delete cascade,
  issued_at     timestamptz not null default now(),
  -- hash chain: sha256(job content + prev pack hash) → tamper-evident
  chain_hash    text not null,
  prev_hash     text,
  photo_count   int not null default 0,
  verify_token  text unique not null default encode(gen_random_bytes(9),'hex'),
  created_at    timestamptz not null default now()
);
create index idx_evidence_token on evidence_packs(verify_token);

create table reports (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid not null references jobs(id) on delete cascade,
  number        text unique not null,      -- RF-2026-00184
  pdf_url       text,
  sha256        text,
  share_token   text unique not null default encode(gen_random_bytes(9),'hex'),
  template_version text not null default '1.0',
  sent_via      text check (sent_via in ('whatsapp','sms','email','link','print','download')),
  sent_at       timestamptz,
  view_count    int not null default 0,
  created_at    timestamptz not null default now()
);
create index idx_reports_job   on reports(job_id);
create index idx_reports_token on reports(share_token);

-- =====================================================================
--  QUOTATIONS
-- =====================================================================
create table quotations (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid references organisations(id) on delete cascade,
  created_by    uuid not null references users(id) on delete cascade,
  job_id        uuid references jobs(id) on delete set null,
  customer_id   uuid references customers(id) on delete set null,
  number        text unique not null,      -- QT-2026-00184
  status        quote_status not null default 'draft',
  line_items    jsonb not null default '[]',   -- [{desc, qty, unit, unit_price}]
  labour        numeric(12,2) not null default 0,
  subtotal      numeric(12,2) not null default 0,
  tax_rate      numeric(5,4) not null default 0,
  tax_amount    numeric(12,2) not null default 0,
  total         numeric(12,2) not null default 0,
  currency      text not null default 'NGN',
  notes         text,
  terms         text,
  valid_until   date,
  pdf_url       text,
  share_token   text unique not null default encode(gen_random_bytes(9),'hex'),
  accepted_at   timestamptz,
  local_id      text,
  sync_state    sync_state not null default 'synced',
  created_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create index idx_quotations_cust on quotations(customer_id);

-- =====================================================================
--  SOLAR PASSPORT  (V1.5 — was RehoSolar Care)
-- =====================================================================
create table warranties (
  id            uuid primary key default gen_random_uuid(),
  equipment_id  uuid not null references equipment(id) on delete cascade,
  customer_id   uuid not null references customers(id) on delete cascade,
  installer_org uuid references organisations(id),
  start_date    date not null,
  months        int not null,
  expires_at    date generated always as (start_date + (months || ' months')::interval) stored,
  coverage      text,
  status        text not null default 'active' check (status in ('active','expired','void')),
  created_at    timestamptz not null default now()
);

create table passport_events (
  id            uuid primary key default gen_random_uuid(),
  equipment_id  uuid not null references equipment(id) on delete cascade,
  event_type    text not null,             -- installed | serviced | fault | part_replaced | inspected
  job_id        uuid references jobs(id) on delete set null,
  summary       text,
  performed_by  text,
  occurred_at   timestamptz not null default now(),
  next_due_at   date,
  created_at    timestamptz not null default now()
);
create index idx_passport_events on passport_events(equipment_id, occurred_at desc);

-- =====================================================================
--  TROUBLESHOOTING LIBRARY  (V1's "AI" — curated, deterministic, offline)
-- =====================================================================
create table troubleshooting_library (
  id            uuid primary key default gen_random_uuid(),
  trade         trade_type not null,
  equipment_category text not null,        -- "hybrid_inverter", "lithium_battery"
  brand         text,                      -- null = generic
  symptom       text not null,
  error_code    text,                      -- "E03"
  likely_causes jsonb not null default '[]',   -- [{cause, probability, why}]
  checks        jsonb not null default '[]',   -- [{order, action, expected, if_failed}]
  safety_notes  text not null,             -- MANDATORY, non-empty
  parts_typical jsonb not null default '[]',   -- [{part_key, description}]
  escalate      boolean not null default false,
  source        text,                      -- "REHOTEQ field data 2026-09" | OEM manual
  verified_by   uuid references users(id),
  usage_count   int not null default 0,
  helpful_count int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint safety_required check (length(trim(safety_notes)) > 0)
);
create index idx_lib_trade   on troubleshooting_library(trade);
create index idx_lib_symptom on troubleshooting_library using gin(to_tsvector('english', symptom));

-- V3 RAG: embeddings over the library + anonymised job cards
create table knowledge_chunks (
  id          uuid primary key default gen_random_uuid(),
  source_type text not null check (source_type in ('library','job_card','manual','catalogue')),
  source_id   uuid,
  trade       trade_type,
  content     text not null,
  metadata    jsonb not null default '{}',
  embedding   vector(1536),
  created_at  timestamptz not null default now()
);
create index on knowledge_chunks using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- =====================================================================
--  AI REQUESTS  (the data flywheel — log from day one)
-- =====================================================================
create table ai_requests (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references users(id) on delete set null,
  job_id        uuid references jobs(id) on delete set null,
  request_type  text not null check (request_type in ('diagnosis','equipment_id','voice','copilot')),
  input_text    text,
  input_image_url text,
  model         text,
  response      jsonb,
  latency_ms    int,
  cost_usd      numeric(10,6),
  tokens_in     int,
  tokens_out    int,
  cached        boolean not null default false,
  -- technician feedback → this is what makes V3 better over time
  feedback      text check (feedback in ('helpful','unhelpful','wrong','unsafe')),
  correction    text,
  created_at    timestamptz not null default now()
);
create index idx_ai_user on ai_requests(user_id, created_at desc);
create index idx_ai_type on ai_requests(request_type, created_at desc);

-- =====================================================================
--  BILLING & USAGE
-- =====================================================================
create table subscriptions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references users(id) on delete cascade,
  org_id        uuid references organisations(id) on delete cascade,
  plan          plan_tier not null,
  status        text not null default 'active'
                  check (status in ('active','trialing','past_due','cancelled','expired')),
  provider      text check (provider in ('paystack','flutterwave','manual')),
  provider_ref  text,
  period_start  timestamptz not null default now(),
  period_end    timestamptz,
  trial_ends_at timestamptz,
  seats         int not null default 1,
  created_at    timestamptz not null default now(),
  cancelled_at  timestamptz
);

create table usage_counters (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  period        text not null,             -- "2026-10"
  reports_used  int not null default 0,
  quotes_used   int not null default 0,
  library_used  int not null default 0,
  ai_credits_used int not null default 0,
  passports_issued int not null default 0,
  updated_at    timestamptz not null default now(),
  unique (user_id, period)
);

create table audit_log (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid references users(id) on delete set null,
  entity      text not null,
  entity_id   uuid,
  action      text not null,               -- created | updated | signed | locked | sent | deleted
  before      jsonb,
  after       jsonb,
  device_info text,
  ip_address  inet,
  created_at  timestamptz not null default now()
);
create index idx_audit_entity on audit_log(entity, entity_id, created_at desc);

-- =====================================================================
--  ROW LEVEL SECURITY
--  · solo technician: own rows only
--  · business: all rows in own org
-- =====================================================================
alter table organisations enable row level security;
alter table users          enable row level security;
alter table customers      enable row level security;
alter table sites          enable row level security;
alter table equipment      enable row level security;
alter table jobs           enable row level security;
alter table job_photos     enable row level security;
alter table job_materials  enable row level security;
alter table quotations     enable row level security;
alter table reports        enable row level security;
alter table evidence_packs enable row level security;
alter table ai_requests    enable row level security;
alter table subscriptions  enable row level security;

create or replace function public.user_org_id()
returns uuid language sql stable as $$
  select org_id from public.users where id = auth.uid()
$$;

-- customers / sites / equipment follow their owner chain
create policy "own rows" on customers
  for all using (owner_id = auth.uid()
                 or org_id = public.user_org_id());

create policy "own rows" on jobs
  for all using (technician_id = auth.uid()
                 or org_id = public.user_org_id());

create policy "own rows" on quotations
  for all using (created_by = auth.uid()
                 or org_id = public.user_org_id());

create policy "via job" on job_photos
  for all using (exists (
    select 1 from jobs j
    where j.id = job_photos.job_id
      and (j.technician_id = auth.uid() or j.org_id = public.user_org_id())));

create policy "via job" on job_materials
  for all using (exists (
    select 1 from jobs j
    where j.id = job_materials.job_id
      and (j.technician_id = auth.uid() or j.org_id = public.user_org_id())));

create policy "via job" on reports
  for all using (exists (
    select 1 from jobs j
    where j.id = reports.job_id
      and (j.technician_id = auth.uid() or j.org_id = public.user_org_id())));

create policy "own requests" on ai_requests
  for all using (user_id = auth.uid());

create policy "own subscription" on subscriptions
  for all using (user_id = auth.uid() or org_id = public.user_org_id());

-- public, read-only verification + passport views (no auth)
create policy "public verify" on reports
  for select using (share_token is not null);

-- =====================================================================
--  TRIGGERS
-- =====================================================================
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

create trigger trg_customers  before update on customers
  for each row execute function public.touch_updated_at();
create trigger trg_jobs       before update on jobs
  for each row execute function public.touch_updated_at();
create trigger trg_library    before update on troubleshooting_library
  for each row execute function public.touch_updated_at();

-- job reference: RF-YYYY-NNNNN
create sequence if not exists job_ref_seq;
create or replace function public.set_job_reference()
returns trigger language plpgsql as $$
begin
  if new.reference is null then
    new.reference := 'RF-' || to_char(now(),'YYYY') || '-'
                     || lpad(nextval('job_ref_seq')::text, 5, '0');
  end if;
  return new;
end; $$;
create trigger trg_job_ref before insert on jobs
  for each row execute function public.set_job_reference();

-- lock the job once both signatures exist (note → evidence)
create or replace function public.lock_job_on_signoff()
returns trigger language plpgsql as $$
declare n int;
begin
  select count(distinct role) into n
    from signatures where job_id = new.job_id and role in ('customer','technician');
  if n >= 2 then
    update jobs set locked_at = now(), status = 'completed'
     where id = new.job_id and locked_at is null;
  end if;
  return new;
end; $$;
create trigger trg_lock_job after insert on signatures
  for each row execute function public.lock_job_on_signoff();

-- increment technician reputation counters on completion
create or replace function public.bump_job_counts()
returns trigger language plpgsql as $$
begin
  if new.locked_at is not null and old.locked_at is null then
    update users set jobs_completed = jobs_completed + 1
     where id = new.technician_id;
  end if;
  return new;
end; $$;
create trigger trg_job_counts after update on jobs
  for each row execute function public.bump_job_counts();

-- =====================================================================
--  STORAGE BUCKETS
-- =====================================================================
--  job-photos     (private, compressed ≤350 KB, Wi-Fi-preferred upload)
--  signatures     (private)
--  reports        (public-read, PDFs served via share_token)
--  passports      (public-read, QR assets)
--  brand-assets   (private, logos)

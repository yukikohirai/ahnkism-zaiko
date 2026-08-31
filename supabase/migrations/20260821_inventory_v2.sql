-- 在庫管理 v2 の土台。既存の試作テーブルは削除しない。
-- Supabase SQL Editor で一度だけ実行する。

create table if not exists public.store_products (
  store_id bigint not null references public.stores(id) on delete cascade,
  product_id bigint not null references public.products(id) on delete cascade,
  is_active boolean not null default true,
  required_qty integer not null default 0 check (required_qty >= 0),
  opening_stock integer not null default 0,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (store_id, product_id)
);

alter table public.products
  add column if not exists manufacturer text,
  add column if not exists product_code text,
  add column if not exists purchase_route text,
  add column if not exists is_active boolean not null default true,
  add column if not exists image_path text;

create table if not exists public.inventory_sessions (
  id uuid primary key default gen_random_uuid(),
  store_id bigint not null references public.stores(id) on delete cascade,
  entry_date date not null default current_date,
  status text not null default 'draft' check (status in ('draft', 'completed')),
  completed_at timestamptz,
  completed_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists inventory_sessions_one_draft_per_store
  on public.inventory_sessions (store_id)
  where status = 'draft';

create table if not exists public.inventory_session_categories (
  session_id uuid not null references public.inventory_sessions(id) on delete cascade,
  category_id bigint not null references public.categories(id) on delete cascade,
  confirmed_at timestamptz not null default now(),
  primary key (session_id, category_id)
);

create table if not exists public.inventory_session_items (
  session_id uuid not null references public.inventory_sessions(id) on delete cascade,
  product_id bigint not null references public.products(id) on delete cascade,
  quantity integer not null default 0 check (quantity >= 0),
  updated_at timestamptz not null default now(),
  primary key (session_id, product_id)
);

create table if not exists public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  store_id bigint not null references public.stores(id) on delete restrict,
  product_id bigint not null references public.products(id) on delete restrict,
  occurred_on date not null default current_date,
  quantity integer not null check (quantity <> 0),
  movement_type text not null check (movement_type in (
    'opening_balance', 'usage', 'purchase_order', 'transfer_out', 'transfer_in',
    'retail_sale', 'personal_sale', 'adjustment'
  )),
  session_id uuid references public.inventory_sessions(id) on delete set null,
  note text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists inventory_movements_store_product_date_idx
  on public.inventory_movements (store_id, product_id, occurred_on);

create table if not exists public.stock_transfers (
  id uuid primary key default gen_random_uuid(),
  occurred_on date not null default current_date,
  from_store_id bigint not null references public.stores(id) on delete restrict,
  to_store_id bigint not null references public.stores(id) on delete restrict,
  product_id bigint not null references public.products(id) on delete restrict,
  quantity integer not null check (quantity > 0),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  check (from_store_id <> to_store_id)
);

create table if not exists public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  store_id bigint not null references public.stores(id) on delete restrict,
  ordered_on date not null default current_date,
  purchase_route text not null,
  status text not null default 'ordered' check (status in ('ordered', 'delayed', 'partial', 'cancelled', 'confirmed')),
  confirmation_due_on date,
  note text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.purchase_order_items (
  purchase_order_id uuid not null references public.purchase_orders(id) on delete cascade,
  product_id bigint not null references public.products(id) on delete restrict,
  quantity integer not null check (quantity > 0),
  primary key (purchase_order_id, product_id)
);

create table if not exists public.monthly_inventory_snapshots (
  store_id bigint not null references public.stores(id) on delete cascade,
  product_id bigint not null references public.products(id) on delete cascade,
  year_month date not null,
  closing_stock integer not null,
  created_at timestamptz not null default now(),
  primary key (store_id, product_id, year_month)
);

create or replace view public.current_store_stock as
select
  sp.store_id,
  sp.product_id,
  sp.required_qty,
  sp.is_active,
  sp.opening_stock + coalesce(sum(im.quantity), 0) as current_stock
from public.store_products sp
left join public.inventory_movements im
  on im.store_id = sp.store_id and im.product_id = sp.product_id
group by sp.store_id, sp.product_id, sp.required_qty, sp.is_active, sp.opening_stock;

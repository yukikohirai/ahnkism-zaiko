-- 先行予約（年2回の割引店販販売）
-- 企画 → 対象商品と割引 → 店舗での予約 → 先行分として確保した在庫 → お渡しで在庫を減らす

-- スタッフ名簿（担当スタイリスト・登録スタッフの選択肢）
create table if not exists public.staff (
  id bigint generated always as identity primary key,
  store_id bigint not null references public.stores(id),
  name text not null,
  sort_order integer not null default 0,
  is_active boolean not null default true
);
comment on table public.staff is '店舗スタッフ名簿。先行予約の担当スタイリスト・登録スタッフに使う';

-- 企画（例：2026年 冬）
create table if not exists public.presale_campaigns (
  id bigint generated always as identity primary key,
  name text not null,
  reception_start date,
  reception_end date,
  delivery_month text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
comment on table public.presale_campaigns is '先行予約の企画。is_active の間は店舗画面に予約ページが出る';

-- 対象商品と割引（割引は税込価格に対して。percent=%オフ／yen=円引き）
create table if not exists public.presale_items (
  campaign_id bigint not null references public.presale_campaigns(id) on delete cascade,
  product_id bigint not null references public.products(id),
  discount_type text not null default 'percent' check (discount_type in ('percent', 'yen')),
  discount_value numeric not null default 0 check (discount_value >= 0),
  primary key (campaign_id, product_id)
);

-- 予約。金額は予約時点の税込価格を控えておく（あとで割引を変えても予約済みの金額は変わらない）
create table if not exists public.presale_reservations (
  id uuid primary key default gen_random_uuid(),
  campaign_id bigint not null references public.presale_campaigns(id) on delete cascade,
  store_id bigint not null references public.stores(id),
  reserved_on date not null default ((now() at time zone 'Asia/Tokyo')::date),
  customer_name text not null,
  stylist_id bigint references public.staff(id),
  staff_id bigint references public.staff(id),
  product_id bigint not null references public.products(id),
  quantity integer not null check (quantity > 0),
  regular_price integer,
  unit_price integer,
  delivered_at timestamptz,
  delivered_movement_id uuid,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists presale_reservations_campaign_store_idx on public.presale_reservations (campaign_id, store_id);

-- 先行分として確保した数（木村さんが入荷後に入力）
create table if not exists public.presale_allocations (
  campaign_id bigint not null references public.presale_campaigns(id) on delete cascade,
  store_id bigint not null references public.stores(id),
  product_id bigint not null references public.products(id),
  allocated_qty integer not null default 0 check (allocated_qty >= 0),
  primary key (campaign_id, store_id, product_id)
);

-- 権限：本部は全部、店舗は自店の予約だけ読み書き
alter table public.staff enable row level security;
alter table public.presale_campaigns enable row level security;
alter table public.presale_items enable row level security;
alter table public.presale_reservations enable row level security;
alter table public.presale_allocations enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['staff', 'presale_campaigns', 'presale_items', 'presale_allocations'] loop
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I for select using (auth.uid() is not null)', t || '_read', t);
    execute format('drop policy if exists %I on public.%I', t || '_hq_write', t);
    execute format($p$create policy %I on public.%I for all
      using (exists (select 1 from public.user_profiles p where p.user_id = auth.uid() and p.role = 'hq'))
      with check (exists (select 1 from public.user_profiles p where p.user_id = auth.uid() and p.role = 'hq'))$p$, t || '_hq_write', t);
  end loop;
end $$;

drop policy if exists presale_reservations_scoped on public.presale_reservations;
create policy presale_reservations_scoped on public.presale_reservations for all
using (exists (select 1 from public.user_profiles p where p.user_id = auth.uid()
  and (p.role = 'hq' or p.store_id = presale_reservations.store_id)))
with check (exists (select 1 from public.user_profiles p where p.user_id = auth.uid()
  and (p.role = 'hq' or p.store_id = presale_reservations.store_id)));

-- お渡し済みの切り替え。お渡しで「店販販売」として在庫を減らし、取り消しで戻す
-- 店舗ユーザーは inventory_movements に直接書けないので、ここでまとめて行う
create or replace function public.set_presale_delivered(p_id uuid, p_delivered boolean)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_row public.presale_reservations;
  v_movement uuid;
begin
  select * into v_row from public.presale_reservations where id = p_id for update;
  if not found then
    raise exception '予約が見つかりません';
  end if;
  if not exists (select 1 from public.user_profiles p where p.user_id = auth.uid()
    and (p.role = 'hq' or p.store_id = v_row.store_id)) then
    raise exception 'この予約を変更する権限がありません';
  end if;
  if v_row.cancelled_at is not null then
    raise exception 'キャンセル済みの予約です';
  end if;

  if p_delivered then
    if v_row.delivered_at is not null then
      return;
    end if;
    insert into public.inventory_movements (store_id, product_id, occurred_on, quantity, movement_type, note, created_by)
    values (v_row.store_id, v_row.product_id, (now() at time zone 'Asia/Tokyo')::date, -v_row.quantity, 'retail_sale',
            '先行予約お渡し ' || v_row.id, auth.uid())
    returning id into v_movement;
    update public.presale_reservations
    set delivered_at = now(), delivered_movement_id = v_movement, updated_at = now()
    where id = p_id;
  else
    if v_row.delivered_at is null then
      return;
    end if;
    if v_row.delivered_movement_id is not null then
      delete from public.inventory_movements where id = v_row.delivered_movement_id;
    end if;
    update public.presale_reservations
    set delivered_at = null, delivered_movement_id = null, updated_at = now()
    where id = p_id;
  end if;
end;
$$;
revoke all on function public.set_presale_delivered(uuid, boolean) from public;
grant execute on function public.set_presale_delivered(uuid, boolean) to authenticated;

-- お渡し済みの予約は、在庫の記録と食い違わないよう商品・数量・店舗を変えられない（先にお渡しを取り消す）
create or replace function public.guard_presale_delivered()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if old.delivered_at is not null then
      raise exception 'お渡し済みの予約は削除できません。先にお渡し済みを外してください';
    end if;
    return old;
  end if;
  if old.delivered_at is not null and new.delivered_at is not null
     and (new.quantity <> old.quantity or new.product_id <> old.product_id or new.store_id <> old.store_id or new.cancelled_at is not null) then
    raise exception 'お渡し済みの予約は変更できません。先にお渡し済みを外してください';
  end if;
  return new;
end;
$$;
drop trigger if exists presale_reservations_guard on public.presale_reservations;
create trigger presale_reservations_guard before update or delete on public.presale_reservations
for each row execute function public.guard_presale_delivered();

-- スタッフ購入（個人購入・個人発注）と集金・預かり金の管理（本部だけ）
-- ・金額はすべて税込
-- ・「店舗在庫から」は個人（personal_sale）として在庫を減らす。「個人発注」は在庫を動かさない
-- ・預かり箱は会社で1つずつ：金庫（店舗在庫からの集金 → オーナーへ）、ディーラー支払い用（個人発注の集金 → ディーラーへ）

create table if not exists public.staff_purchases (
  id uuid primary key default gen_random_uuid(),
  purchased_on date not null,
  staff_id bigint not null references public.staff(id),
  store_id bigint not null references public.stores(id),
  product_id bigint not null references public.products(id),
  quantity integer not null check (quantity > 0),
  unit_price integer not null check (unit_price >= 0),
  kind text not null check (kind in ('store_stock', 'personal_order')),
  movement_id uuid references public.inventory_movements(id),
  collected_on date,
  note text,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists staff_purchases_date_idx on public.staff_purchases (purchased_on);
create index if not exists staff_purchases_staff_idx on public.staff_purchases (staff_id, purchased_on);
comment on table public.staff_purchases is 'スタッフ購入。金額は税込。店舗在庫からの分は movement_id の個人（personal_sale）で在庫を減らす';

create table if not exists public.cash_payouts (
  id uuid primary key default gen_random_uuid(),
  box text not null check (box in ('safe', 'dealer')),
  paid_at timestamptz not null,
  amount integer not null check (amount > 0),
  note text,
  created_by uuid,
  created_at timestamptz not null default now()
);
comment on table public.cash_payouts is '預かり金から渡したお金。safe=金庫からオーナーへ、dealer=ディーラー支払い用からディーラーへ';

create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
insert into public.app_settings (key, value) values ('safe_threshold', '100000') on conflict (key) do nothing;

alter table public.staff_purchases enable row level security;
alter table public.cash_payouts enable row level security;
alter table public.app_settings enable row level security;

drop policy if exists staff_purchases_hq_read on public.staff_purchases;
create policy staff_purchases_hq_read on public.staff_purchases for select
  using (exists (select 1 from public.user_profiles p where p.user_id = auth.uid() and p.role = 'hq'));
drop policy if exists cash_payouts_hq_all on public.cash_payouts;
create policy cash_payouts_hq_all on public.cash_payouts for all
  using (exists (select 1 from public.user_profiles p where p.user_id = auth.uid() and p.role = 'hq'))
  with check (exists (select 1 from public.user_profiles p where p.user_id = auth.uid() and p.role = 'hq'));
drop policy if exists app_settings_hq_all on public.app_settings;
create policy app_settings_hq_all on public.app_settings for all
  using (exists (select 1 from public.user_profiles p where p.user_id = auth.uid() and p.role = 'hq'))
  with check (exists (select 1 from public.user_profiles p where p.user_id = auth.uid() and p.role = 'hq'));

-- スタッフ購入とつながった在庫の記録は、入出庫の履歴からは直せない（金額とずれるため）
create or replace function public.guard_staff_purchase_movement()
returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('app.staff_purchase_op', true), '') <> '1'
     and exists (select 1 from public.staff_purchases sp where sp.movement_id = old.id) then
    raise exception 'この記録はスタッフ購入の画面から修正・取り消ししてください';
  end if;
  return coalesce(new, old);
end;
$$;
drop trigger if exists inventory_movements_staff_purchase_guard on public.inventory_movements;
create trigger inventory_movements_staff_purchase_guard before update or delete on public.inventory_movements
for each row execute function public.guard_staff_purchase_movement();

create or replace function public.require_hq()
returns void
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if not exists (select 1 from public.user_profiles p where p.user_id = auth.uid() and p.role = 'hq') then
    raise exception '本部だけが操作できます';
  end if;
end;
$$;

create or replace function public.add_staff_purchase(
  p_purchased_on date, p_staff_id bigint, p_store_id bigint, p_product_id bigint,
  p_quantity integer, p_unit_price integer, p_kind text, p_collected boolean default false, p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid;
  v_movement uuid;
  v_staff text;
begin
  perform public.require_hq();
  if p_quantity is null or p_quantity <= 0 then raise exception '数は1以上で入力してください'; end if;
  if p_unit_price is null or p_unit_price < 0 then raise exception '単価を入力してください'; end if;
  if p_kind not in ('store_stock', 'personal_order') then raise exception '種類を選んでください'; end if;
  select name into v_staff from public.staff where id = p_staff_id;
  if v_staff is null then raise exception 'スタッフを選んでください'; end if;

  if p_kind = 'store_stock' then
    if not exists (select 1 from public.store_products where store_id = p_store_id and product_id = p_product_id) then
      raise exception 'この店舗で取り扱っていない商品です。店舗在庫から売る場合は、取扱店舗の商品を選んでください';
    end if;
    perform set_config('app.staff_purchase_op', '1', true);
    insert into public.inventory_movements (store_id, product_id, occurred_on, quantity, movement_type, note, created_by)
    values (p_store_id, p_product_id, p_purchased_on, -p_quantity, 'personal_sale', 'スタッフ購入 ' || v_staff, auth.uid())
    returning id into v_movement;
    perform set_config('app.staff_purchase_op', '', true);
  end if;

  insert into public.staff_purchases (purchased_on, staff_id, store_id, product_id, quantity, unit_price, kind, movement_id, collected_on, note, created_by)
  values (p_purchased_on, p_staff_id, p_store_id, p_product_id, p_quantity, p_unit_price, p_kind, v_movement,
          case when p_collected then (now() at time zone 'Asia/Tokyo')::date end, nullif(trim(p_note), ''), auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

-- 数・単価・メモの修正（店舗在庫からの分は在庫の数も合わせて直す）
create or replace function public.update_staff_purchase(p_id uuid, p_quantity integer, p_unit_price integer, p_note text default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_row public.staff_purchases;
begin
  perform public.require_hq();
  if p_quantity is null or p_quantity <= 0 then raise exception '数は1以上で入力してください'; end if;
  if p_unit_price is null or p_unit_price < 0 then raise exception '単価を入力してください'; end if;
  select * into v_row from public.staff_purchases where id = p_id;
  if v_row.id is null then raise exception '記録が見つかりません'; end if;
  if v_row.movement_id is not null and v_row.quantity <> p_quantity then
    perform set_config('app.staff_purchase_op', '1', true);
    update public.inventory_movements set quantity = -p_quantity where id = v_row.movement_id;
    perform set_config('app.staff_purchase_op', '', true);
  end if;
  update public.staff_purchases set quantity = p_quantity, unit_price = p_unit_price, note = nullif(trim(p_note), '') where id = p_id;
end;
$$;

-- 取り消し（店舗在庫からの分は在庫も戻す。締めた月の分は取り消せない）
create or replace function public.cancel_staff_purchase(p_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_row public.staff_purchases;
begin
  perform public.require_hq();
  select * into v_row from public.staff_purchases where id = p_id;
  if v_row.id is null then raise exception '記録が見つかりません'; end if;
  if v_row.collected_on is not null then
    raise exception '集金済みの記録は取り消せません。先に集金済みを外してください';
  end if;
  delete from public.staff_purchases where id = p_id;
  if v_row.movement_id is not null then
    perform set_config('app.staff_purchase_op', '1', true);
    delete from public.inventory_movements where id = v_row.movement_id;
    perform set_config('app.staff_purchase_op', '', true);
  end if;
end;
$$;

-- 集金済みにする／外す（まとめて）
create or replace function public.set_staff_purchase_collected(p_ids uuid[], p_collected boolean)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_count integer;
begin
  perform public.require_hq();
  update public.staff_purchases
     set collected_on = case when p_collected then coalesce(collected_on, (now() at time zone 'Asia/Tokyo')::date) end
   where id = any(p_ids);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.add_staff_purchase(date, bigint, bigint, bigint, integer, integer, text, boolean, text) from public;
revoke all on function public.update_staff_purchase(uuid, integer, integer, text) from public;
revoke all on function public.cancel_staff_purchase(uuid) from public;
revoke all on function public.set_staff_purchase_collected(uuid[], boolean) from public;
grant execute on function public.add_staff_purchase(date, bigint, bigint, bigint, integer, integer, text, boolean, text) to authenticated;
grant execute on function public.update_staff_purchase(uuid, integer, integer, text) to authenticated;
grant execute on function public.cancel_staff_purchase(uuid) to authenticated;
grant execute on function public.set_staff_purchase_collected(uuid[], boolean) to authenticated;

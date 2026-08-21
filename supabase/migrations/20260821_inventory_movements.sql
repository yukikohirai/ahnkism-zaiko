-- 店舗別の在庫増減・店舗間移動・完了入力の在庫反映

create unique index if not exists inventory_sessions_one_completed_per_store_date
  on public.inventory_sessions (store_id, entry_date)
  where status = 'completed';

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
create unique index if not exists inventory_movements_one_usage_per_session_product
  on public.inventory_movements (session_id, product_id)
  where session_id is not null and movement_type = 'usage';

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

alter table public.inventory_movements enable row level security;
alter table public.stock_transfers enable row level security;

drop policy if exists "inventory movements scoped read" on public.inventory_movements;
create policy "inventory movements scoped read"
on public.inventory_movements for select to authenticated
using (exists (
  select 1 from public.user_profiles profile
  where profile.user_id = auth.uid()
    and (profile.role = 'hq' or profile.store_id = inventory_movements.store_id)
));

drop policy if exists "hq manages inventory movements" on public.inventory_movements;
create policy "hq manages inventory movements"
on public.inventory_movements for all to authenticated
using (exists (
  select 1 from public.user_profiles profile
  where profile.user_id = auth.uid() and profile.role = 'hq'
))
with check (exists (
  select 1 from public.user_profiles profile
  where profile.user_id = auth.uid() and profile.role = 'hq'
));

drop policy if exists "stock transfers scoped read" on public.stock_transfers;
create policy "stock transfers scoped read"
on public.stock_transfers for select to authenticated
using (exists (
  select 1 from public.user_profiles profile
  where profile.user_id = auth.uid()
    and (profile.role = 'hq' or profile.store_id in (stock_transfers.from_store_id, stock_transfers.to_store_id))
));

drop policy if exists "hq manages stock transfers" on public.stock_transfers;
create policy "hq manages stock transfers"
on public.stock_transfers for all to authenticated
using (exists (
  select 1 from public.user_profiles profile
  where profile.user_id = auth.uid() and profile.role = 'hq'
))
with check (exists (
  select 1 from public.user_profiles profile
  where profile.user_id = auth.uid() and profile.role = 'hq'
));

create or replace view public.current_store_stock
with (security_invoker = true)
as
select
  store_product.store_id,
  store_product.product_id,
  store_product.required_qty,
  store_product.is_active,
  store_product.opening_stock + coalesce(sum(movement.quantity), 0)::integer as current_stock
from public.store_products store_product
left join public.inventory_movements movement
  on movement.store_id = store_product.store_id
 and movement.product_id = store_product.product_id
group by
  store_product.store_id,
  store_product.product_id,
  store_product.required_qty,
  store_product.is_active,
  store_product.opening_stock;

grant select on public.current_store_stock to authenticated;

create or replace function public.complete_inventory_session(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store_id bigint;
  v_entry_date date;
  v_status text;
  v_required_categories integer;
  v_confirmed_categories integer;
begin
  select store_id, entry_date, status
    into v_store_id, v_entry_date, v_status
  from public.inventory_sessions
  where id = p_session_id
  for update;

  if not found then
    raise exception '入力下書きが見つかりません';
  end if;
  if v_status <> 'draft' then
    raise exception 'この入力はすでに完了しています';
  end if;

  if not exists (
    select 1 from public.user_profiles profile
    where profile.user_id = auth.uid()
      and (profile.role = 'hq' or (profile.role = 'store' and profile.store_id = v_store_id))
  ) then
    raise exception 'この店舗を完了する権限がありません';
  end if;

  select count(distinct product.category_id)
    into v_required_categories
  from public.store_products store_product
  join public.products product on product.id = store_product.product_id
  where store_product.store_id = v_store_id
    and store_product.is_active = true
    and product.is_active = true;

  select count(*)
    into v_confirmed_categories
  from public.inventory_session_categories confirmation
  where confirmation.session_id = p_session_id
    and exists (
      select 1
      from public.store_products store_product
      join public.products product on product.id = store_product.product_id
      where store_product.store_id = v_store_id
        and store_product.is_active = true
        and product.is_active = true
        and product.category_id = confirmation.category_id
    );

  if v_required_categories = 0 or v_confirmed_categories <> v_required_categories then
    raise exception '全カテゴリを確認してから完了してください';
  end if;

  insert into public.usage_logs (store_id, product_id, date, quantity, updated_at)
  select v_store_id, item.product_id, v_entry_date, item.quantity, now()
  from public.inventory_session_items item
  where item.session_id = p_session_id and item.quantity > 0
  on conflict (store_id, product_id, date)
  do update set quantity = excluded.quantity, updated_at = now();

  insert into public.inventory_movements (
    store_id, product_id, occurred_on, quantity, movement_type, session_id, created_by
  )
  select v_store_id, item.product_id, v_entry_date, -item.quantity, 'usage', p_session_id, auth.uid()
  from public.inventory_session_items item
  where item.session_id = p_session_id and item.quantity > 0
  on conflict (session_id, product_id)
    where session_id is not null and movement_type = 'usage'
  do nothing;

  update public.inventory_sessions
  set status = 'completed', completed_at = now(), completed_by = auth.uid(), updated_at = now()
  where id = p_session_id;
end;
$$;

grant execute on function public.complete_inventory_session(uuid) to authenticated;

create or replace function public.record_stock_transfer(
  p_occurred_on date,
  p_from_store_id bigint,
  p_to_store_id bigint,
  p_product_id bigint,
  p_quantity integer
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_transfer_id uuid;
  v_current_stock integer;
begin
  if not exists (
    select 1 from public.user_profiles profile
    where profile.user_id = auth.uid() and profile.role = 'hq'
  ) then
    raise exception '本部だけが店舗間移動を登録できます';
  end if;
  if p_from_store_id = p_to_store_id then
    raise exception '移動元と移動先は別の店舗を選んでください';
  end if;
  if p_quantity <= 0 then
    raise exception '数量は1以上で入力してください';
  end if;
  if not exists (
    select 1 from public.store_products
    where store_id = p_from_store_id and product_id = p_product_id and is_active = true
  ) or not exists (
    select 1 from public.store_products
    where store_id = p_to_store_id and product_id = p_product_id and is_active = true
  ) then
    raise exception '両店舗で取扱中の商品だけ移動できます';
  end if;

  select current_stock into v_current_stock
  from public.current_store_stock
  where store_id = p_from_store_id and product_id = p_product_id;
  if coalesce(v_current_stock, 0) < p_quantity then
    raise exception '移動元の在庫が不足しています（現在庫: %）', coalesce(v_current_stock, 0);
  end if;

  insert into public.stock_transfers (
    occurred_on, from_store_id, to_store_id, product_id, quantity, created_by
  ) values (
    p_occurred_on, p_from_store_id, p_to_store_id, p_product_id, p_quantity, auth.uid()
  ) returning id into v_transfer_id;

  insert into public.inventory_movements (
    store_id, product_id, occurred_on, quantity, movement_type, note, created_by
  ) values
    (p_from_store_id, p_product_id, p_occurred_on, -p_quantity, 'transfer_out', '店舗間移動 ' || v_transfer_id, auth.uid()),
    (p_to_store_id, p_product_id, p_occurred_on, p_quantity, 'transfer_in', '店舗間移動 ' || v_transfer_id, auth.uid());

  return v_transfer_id;
end;
$$;

grant execute on function public.record_stock_transfer(date, bigint, bigint, bigint, integer) to authenticated;

create or replace function public.record_inventory_operation(
  p_occurred_on date,
  p_store_id bigint,
  p_product_id bigint,
  p_quantity integer,
  p_movement_type text,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_movement_id uuid;
  v_signed_quantity integer;
  v_current_stock integer;
begin
  if not exists (
    select 1 from public.user_profiles profile
    where profile.user_id = auth.uid() and profile.role = 'hq'
  ) then
    raise exception '本部だけが在庫増減を登録できます';
  end if;
  if p_quantity <= 0 then
    raise exception '数量は1以上で入力してください';
  end if;
  if p_movement_type not in ('purchase_order', 'usage', 'retail_sale', 'personal_sale', 'adjustment') then
    raise exception '指定できない在庫区分です';
  end if;
  if not exists (
    select 1 from public.store_products
    where store_id = p_store_id and product_id = p_product_id and is_active = true
  ) then
    raise exception 'この店舗では取扱中でない商品です';
  end if;

  v_signed_quantity := case
    when p_movement_type in ('purchase_order', 'adjustment') then p_quantity
    else -p_quantity
  end;

  if v_signed_quantity < 0 then
    select current_stock into v_current_stock
    from public.current_store_stock
    where store_id = p_store_id and product_id = p_product_id;
    if coalesce(v_current_stock, 0) < p_quantity then
      raise exception '在庫が不足しています（現在庫: %）', coalesce(v_current_stock, 0);
    end if;
  end if;

  insert into public.inventory_movements (
    store_id, product_id, occurred_on, quantity, movement_type, note, created_by
  ) values (
    p_store_id, p_product_id, p_occurred_on, v_signed_quantity, p_movement_type, p_note, auth.uid()
  ) returning id into v_movement_id;

  return v_movement_id;
end;
$$;

grant execute on function public.record_inventory_operation(date, bigint, bigint, integer, text, text) to authenticated;

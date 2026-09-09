-- 在庫がマイナスになる打ち込みを許可する（本部・入出庫画面）
-- ・record_inventory_operation / record_stock_transfer から在庫不足の raise を削除
-- ・adjustment（誤差調整）は p_quantity の符号をそのまま採用し、マイナスも許可

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
begin
  if not exists (
    select 1 from public.user_profiles profile
    where profile.user_id = auth.uid() and profile.role = 'hq'
  ) then
    raise exception '本部だけが在庫増減を登録できます';
  end if;
  if p_movement_type not in ('purchase_order', 'usage', 'retail_sale', 'personal_sale', 'adjustment') then
    raise exception '指定できない在庫区分です';
  end if;
  if p_movement_type = 'adjustment' then
    if p_quantity = 0 then
      raise exception '差分が0のときは登録できません';
    end if;
  elsif p_quantity <= 0 then
    raise exception '数量は1以上で入力してください';
  end if;
  if not exists (
    select 1 from public.store_products
    where store_id = p_store_id and product_id = p_product_id and is_active = true
  ) then
    raise exception 'この店舗では取扱中でない商品です';
  end if;

  v_signed_quantity := case
    when p_movement_type = 'adjustment' then p_quantity
    when p_movement_type = 'purchase_order' then p_quantity
    else -p_quantity
  end;

  insert into public.inventory_movements (
    store_id, product_id, occurred_on, quantity, movement_type, note, created_by
  ) values (
    p_store_id, p_product_id, p_occurred_on, v_signed_quantity, p_movement_type, p_note, auth.uid()
  ) returning id into v_movement_id;

  return v_movement_id;
end;
$$;

grant execute on function public.record_inventory_operation(date, bigint, bigint, integer, text, text) to authenticated;

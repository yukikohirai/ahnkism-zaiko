-- 商品「その他」は在庫を持たないので、スタッフ購入では在庫から引かない（「引く」を選んでも引かない）
create or replace function public.add_staff_purchase(
  p_purchased_on date, p_staff_id bigint, p_store_id bigint, p_product_id bigint,
  p_quantity integer, p_unit_price integer, p_kind text, p_collected boolean default false, p_note text default null,
  p_item_name text default null, p_dealer text default null, p_item_detail text default null, p_deduct_stock boolean default null
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
  v_item text := nullif(trim(p_item_name), '');
  v_dealer text := nullif(trim(p_dealer), '');
  v_detail text := nullif(trim(p_item_detail), '');
  -- 指定がなければ、金庫行きは在庫から引く・ディーラー行きは引かない（以前の動き）
  v_deduct boolean := coalesce(p_deduct_stock, p_kind = 'store_stock');
begin
  -- 「その他」は在庫を持たないので、いつも在庫から引かない
  if exists (select 1 from public.products where id = p_product_id and trim(name) = 'その他') then
    v_deduct := false;
  end if;
  perform public.require_hq();
  if p_quantity is null or p_quantity <= 0 then raise exception '数は1以上で入力してください'; end if;
  if p_unit_price is null or p_unit_price < 0 then raise exception '単価を入力してください'; end if;
  if p_kind not in ('store_stock', 'personal_order') then raise exception '集金先を選んでください'; end if;
  select name into v_staff from public.staff where id = p_staff_id;
  if v_staff is null then raise exception 'スタッフを選んでください'; end if;
  if p_store_id is null then raise exception '店舗を選んでください'; end if;
  if p_product_id is null and v_item is null then raise exception '商品を選ぶか、商品名を入力してください'; end if;
  if p_product_id is not null and v_item is not null then raise exception '商品の選択と商品名の入力は、どちらか一方にしてください'; end if;
  if v_item is not null and v_deduct then raise exception '一覧にない商品は、在庫から引かないときだけ登録できます'; end if;
  if p_kind = 'personal_order' and v_dealer is null then raise exception 'ディーラー支払いのときは、ディーラーを選んでください'; end if;
  if p_kind = 'store_stock' then v_dealer := null; end if;
  if v_detail is null and exists (select 1 from public.products where id = p_product_id and trim(name) = 'その他') then
    raise exception '「その他」は中身（例：ヘアオイル試供品）を入力してください';
  end if;

  if v_deduct then
    if not exists (select 1 from public.store_products where store_id = p_store_id and product_id = p_product_id) then
      raise exception 'この店舗で取り扱っていない商品です。在庫から引く場合は、その店舗の取扱商品を選んでください';
    end if;
    perform set_config('app.staff_purchase_op', '1', true);
    insert into public.inventory_movements (store_id, product_id, occurred_on, quantity, movement_type, note, created_by)
    values (p_store_id, p_product_id, p_purchased_on, -p_quantity, 'personal_sale',
            'スタッフ購入 ' || v_staff || coalesce('（' || v_detail || '）', ''), auth.uid())
    returning id into v_movement;
    perform set_config('app.staff_purchase_op', '', true);
  end if;

  insert into public.staff_purchases (purchased_on, staff_id, store_id, product_id, item_name, item_detail, dealer, quantity, unit_price, kind, deduct_stock, movement_id, collected_on, note, created_by)
  values (p_purchased_on, p_staff_id, p_store_id, p_product_id, v_item, v_detail, v_dealer, p_quantity, p_unit_price, p_kind, v_deduct, v_movement,
          case when p_collected then (now() at time zone 'Asia/Tokyo')::date end, nullif(trim(p_note), ''), auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;


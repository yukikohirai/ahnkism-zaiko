-- 個人発注はディーラーごとに集計する。ディーラーに渡した記録もディーラー名を残す
alter table public.staff_purchases add column if not exists dealer text;
alter table public.staff_purchases drop constraint if exists staff_purchases_dealer_check;
alter table public.staff_purchases add constraint staff_purchases_dealer_check check (
  (kind = 'personal_order' and dealer is not null) or (kind = 'store_stock' and dealer is null)
);

alter table public.cash_payouts add column if not exists dealer text;
alter table public.cash_payouts drop constraint if exists cash_payouts_dealer_check;
alter table public.cash_payouts add constraint cash_payouts_dealer_check check (
  (box = 'dealer' and dealer is not null) or (box = 'safe' and dealer is null)
);

drop function if exists public.add_staff_purchase(date, bigint, bigint, bigint, integer, integer, text, boolean, text, text);

create or replace function public.add_staff_purchase(
  p_purchased_on date, p_staff_id bigint, p_store_id bigint, p_product_id bigint,
  p_quantity integer, p_unit_price integer, p_kind text, p_collected boolean default false, p_note text default null,
  p_item_name text default null, p_dealer text default null
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
begin
  perform public.require_hq();
  if p_quantity is null or p_quantity <= 0 then raise exception '数は1以上で入力してください'; end if;
  if p_unit_price is null or p_unit_price < 0 then raise exception '単価を入力してください'; end if;
  if p_kind not in ('store_stock', 'personal_order') then raise exception '種類を選んでください'; end if;
  select name into v_staff from public.staff where id = p_staff_id;
  if v_staff is null then raise exception 'スタッフを選んでください'; end if;
  if p_product_id is null and v_item is null then raise exception '商品を選ぶか、商品名を入力してください'; end if;
  if p_product_id is not null and v_item is not null then raise exception '商品の選択と商品名の入力は、どちらか一方にしてください'; end if;
  if v_item is not null and p_kind <> 'personal_order' then raise exception '一覧にない商品は、個人発注のときだけ登録できます'; end if;
  if p_kind = 'personal_order' and v_dealer is null then raise exception '個人発注はディーラーを選んでください'; end if;
  if p_kind = 'store_stock' then v_dealer := null; end if;

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

  insert into public.staff_purchases (purchased_on, staff_id, store_id, product_id, item_name, dealer, quantity, unit_price, kind, movement_id, collected_on, note, created_by)
  values (p_purchased_on, p_staff_id, p_store_id, p_product_id, v_item, v_dealer, p_quantity, p_unit_price, p_kind, v_movement,
          case when p_collected then (now() at time zone 'Asia/Tokyo')::date end, nullif(trim(p_note), ''), auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

drop function if exists public.update_staff_purchase(uuid, integer, integer, text);

create or replace function public.update_staff_purchase(p_id uuid, p_quantity integer, p_unit_price integer, p_note text default null, p_dealer text default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_row public.staff_purchases;
  v_dealer text := nullif(trim(p_dealer), '');
begin
  perform public.require_hq();
  if p_quantity is null or p_quantity <= 0 then raise exception '数は1以上で入力してください'; end if;
  if p_unit_price is null or p_unit_price < 0 then raise exception '単価を入力してください'; end if;
  select * into v_row from public.staff_purchases where id = p_id;
  if v_row.id is null then raise exception '記録が見つかりません'; end if;
  if v_row.kind = 'personal_order' and v_dealer is null then raise exception '個人発注はディーラーを選んでください'; end if;
  if v_row.movement_id is not null and v_row.quantity <> p_quantity then
    perform set_config('app.staff_purchase_op', '1', true);
    update public.inventory_movements set quantity = -p_quantity where id = v_row.movement_id;
    perform set_config('app.staff_purchase_op', '', true);
  end if;
  update public.staff_purchases
     set quantity = p_quantity, unit_price = p_unit_price, note = nullif(trim(p_note), ''),
         dealer = case when v_row.kind = 'personal_order' then v_dealer end
   where id = p_id;
end;
$$;

revoke all on function public.add_staff_purchase(date, bigint, bigint, bigint, integer, integer, text, boolean, text, text, text) from public;
grant execute on function public.add_staff_purchase(date, bigint, bigint, bigint, integer, integer, text, boolean, text, text, text) to authenticated;
revoke all on function public.update_staff_purchase(uuid, integer, integer, text, text) from public;
grant execute on function public.update_staff_purchase(uuid, integer, integer, text, text) to authenticated;

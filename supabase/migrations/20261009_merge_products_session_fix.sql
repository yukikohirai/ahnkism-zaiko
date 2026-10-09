-- 商品の統合の修正：同じ店舗報告に両方の使用数があると統合できなかった問題を直す
-- ・統合中は締めた月の記録のまとめ（数の合算・重複行の削除）も許す

create or replace function public.guard_closed_month()
returns trigger
language plpgsql
as $$
declare
  v_closed date;
  v_cut date;
begin
  -- 商品の統合中（merge_products の中だけ）は、締めた月の記録の付け替え・まとめを許す
  if coalesce(current_setting('app.product_merge', true), '') = '1' then
    return coalesce(new, old);
  end if;
  -- 本部の編集モード中は、締めた月でもそのまま入力・修正・取り消しできる（翌月1日への付け替えもしない）
  if public.hq_edit_active() then
    return coalesce(new, old);
  end if;
  select month_end, cut_date into v_closed, v_cut from public.month_closings order by month_end desc limit 1;
  if v_closed is null then
    return coalesce(new, old);
  end if;
  if tg_op in ('UPDATE', 'DELETE') and old.occurred_on <= v_closed then
    raise exception '%月は締めたため、この記録は変更できません。本部の「編集モード」で直してください', extract(month from v_closed);
  end if;
  if tg_op in ('INSERT', 'UPDATE') and new.occurred_on <= v_closed then
    if new.occurred_on > v_cut then
      new.note := concat_ws(' ', new.note, '（実際の日付 ' || to_char(new.occurred_on, 'MM/DD') || '・締め後のため翌月分）');
      new.occurred_on := v_closed + 1;
    else
      raise exception '%月は締めたため、%以前の日付では入力できません', extract(month from v_closed), to_char(v_cut, 'MM/DD');
    end if;
  end if;
  return coalesce(new, old);
end;
$$;

create or replace function public.merge_products(p_keep_id bigint, p_remove_id bigint)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_remove public.products;
begin
  perform public.require_hq();
  if p_keep_id is null or p_remove_id is null or p_keep_id = p_remove_id then
    raise exception '残す商品と、まとめて消す商品を別々に選んでください';
  end if;
  if not exists (select 1 from public.products where id = p_keep_id) then raise exception '残す商品が見つかりません'; end if;
  select * into v_remove from public.products where id = p_remove_id;
  if v_remove.id is null then raise exception 'まとめて消す商品が見つかりません'; end if;

  perform set_config('app.product_merge', '1', true);
  perform set_config('app.staff_purchase_op', '1', true);

  -- 店舗の取扱：両方ある店舗は繰越を足して1行に
  update public.store_products k
     set opening_stock = k.opening_stock + r.opening_stock,
         is_active = k.is_active or r.is_active,
         updated_at = now()
    from public.store_products r
   where k.product_id = p_keep_id and r.product_id = p_remove_id and k.store_id = r.store_id;
  delete from public.store_products r
   where r.product_id = p_remove_id
     and exists (select 1 from public.store_products k where k.product_id = p_keep_id and k.store_id = r.store_id);
  update public.store_products set product_id = p_keep_id where product_id = p_remove_id;

  -- 入出庫の履歴・店舗間移動・スタッフ購入・先行予約の明細は付け替えるだけ
  -- 同じ店舗報告に両方の使用数があれば、1行にまとめる（1つの報告に同じ商品の使用は1行だけのため）
  update public.inventory_movements k
     set quantity = k.quantity + r.quantity
    from public.inventory_movements r
   where k.product_id = p_keep_id and r.product_id = p_remove_id
     and k.session_id = r.session_id and k.movement_type = 'usage' and r.movement_type = 'usage';
  delete from public.inventory_movements r
   where r.product_id = p_remove_id and r.movement_type = 'usage' and r.session_id is not null
     and exists (select 1 from public.inventory_movements k
                 where k.product_id = p_keep_id and k.session_id = r.session_id and k.movement_type = 'usage');
  update public.inventory_movements set product_id = p_keep_id where product_id = p_remove_id;
  update public.stock_transfers set product_id = p_keep_id where product_id = p_remove_id;
  update public.staff_purchases set product_id = p_keep_id where product_id = p_remove_id;
  update public.presale_reservations set product_id = p_keep_id where product_id = p_remove_id;
  update public.presale_order_lines set product_id = p_keep_id where product_id = p_remove_id;

  -- 店舗入力の下書き：同じ報告に両方あれば数を足す
  update public.inventory_session_items k
     set quantity = k.quantity + r.quantity, updated_at = now()
    from public.inventory_session_items r
   where k.product_id = p_keep_id and r.product_id = p_remove_id and k.session_id = r.session_id;
  delete from public.inventory_session_items r
   where r.product_id = p_remove_id
     and exists (select 1 from public.inventory_session_items k where k.product_id = p_keep_id and k.session_id = r.session_id);
  update public.inventory_session_items set product_id = p_keep_id where product_id = p_remove_id;

  -- 先行予約の対象商品：両方あれば残す方の設定を使う
  delete from public.presale_items r
   where r.product_id = p_remove_id
     and exists (select 1 from public.presale_items k where k.product_id = p_keep_id and k.campaign_id = r.campaign_id);
  update public.presale_items set product_id = p_keep_id where product_id = p_remove_id;

  -- 先行分の確保数：両方あれば足す
  update public.presale_allocations k
     set allocated_qty = k.allocated_qty + r.allocated_qty
    from public.presale_allocations r
   where k.product_id = p_keep_id and r.product_id = p_remove_id and k.campaign_id = r.campaign_id and k.store_id = r.store_id;
  delete from public.presale_allocations r
   where r.product_id = p_remove_id
     and exists (select 1 from public.presale_allocations k where k.product_id = p_keep_id and k.campaign_id = r.campaign_id and k.store_id = r.store_id);
  update public.presale_allocations set product_id = p_keep_id where product_id = p_remove_id;

  -- 締めた月の月末在庫：付け替えたあと、残す方を履歴から計算し直す（足し算すると二重になるため）
  delete from public.monthly_closing_stock r
   where r.product_id = p_remove_id
     and exists (select 1 from public.monthly_closing_stock k where k.product_id = p_keep_id and k.year_month = r.year_month and k.store_id = r.store_id);
  update public.monthly_closing_stock set product_id = p_keep_id where product_id = p_remove_id;
  perform public.recalc_closing_stock(s.store_id, p_keep_id) from (select distinct store_id from public.monthly_closing_stock where product_id = p_keep_id) s;

  -- 以前の試作の記録（usage_logs など）も付け替え。同じ日があれば数を足す
  update public.usage_logs k
     set quantity = k.quantity + r.quantity
    from public.usage_logs r
   where k.product_id = p_keep_id and r.product_id = p_remove_id and k.store_id = r.store_id and k.date = r.date;
  delete from public.usage_logs r
   where r.product_id = p_remove_id
     and exists (select 1 from public.usage_logs k where k.product_id = p_keep_id and k.store_id = r.store_id and k.date = r.date);
  update public.usage_logs set product_id = p_keep_id where product_id = p_remove_id;
  update public.stock_receipts set product_id = p_keep_id where product_id = p_remove_id;
  update public.monthly_balance set product_id = p_keep_id where product_id = p_remove_id;

  perform set_config('app.product_merge', '', true);
  perform set_config('app.staff_purchase_op', '', true);

  insert into public.product_merges (kept_product_id, removed_product_id, removed_brand, removed_name, merged_by)
  values (p_keep_id, p_remove_id, v_remove.brand, v_remove.name, auth.uid());

  delete from public.products where id = p_remove_id;
end;
$$;
revoke all on function public.merge_products(bigint, bigint) from public;
grant execute on function public.merge_products(bigint, bigint) to authenticated;

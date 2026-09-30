-- 停止中の商品の削除（本部だけ）
-- ・入出庫の履歴・スタッフ購入・先行予約の注文がある商品は、過去の集計が変わるので削除しない（「統合」を使う）
-- ・残っている繰越在庫（opening_stock）や締めた月の月末在庫の記録は、商品と一緒に消える（画面で事前に知らせる）
create or replace function public.delete_stopped_product(p_id bigint)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_product public.products;
begin
  perform public.require_hq();
  select * into v_product from public.products where id = p_id;
  if v_product.id is null then raise exception '商品が見つかりません'; end if;
  if v_product.is_active then raise exception '削除できるのは停止中の商品だけです'; end if;
  if exists (select 1 from public.inventory_movements where product_id = p_id)
     or exists (select 1 from public.stock_transfers where product_id = p_id) then
    raise exception '「%」は入出庫の履歴があるため削除できません。重複した商品なら「統合」を使ってください', v_product.name;
  end if;
  if exists (select 1 from public.staff_purchases where product_id = p_id)
     or exists (select 1 from public.presale_order_lines where product_id = p_id)
     or exists (select 1 from public.presale_reservations where product_id = p_id) then
    raise exception '「%」はスタッフ購入や先行予約の記録があるため削除できません', v_product.name;
  end if;

  delete from public.presale_items where product_id = p_id;
  delete from public.presale_allocations where product_id = p_id;
  delete from public.monthly_closing_stock where product_id = p_id;
  delete from public.usage_logs where product_id = p_id;
  delete from public.stock_receipts where product_id = p_id;
  delete from public.monthly_balance where product_id = p_id;
  -- store_products と下書きの入力（inventory_session_items）は商品と一緒に消える（on delete cascade）
  delete from public.products where id = p_id;
end;
$$;
revoke all on function public.delete_stopped_product(bigint) from public;
grant execute on function public.delete_stopped_product(bigint) to authenticated;

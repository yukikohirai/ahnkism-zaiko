-- 先行予約：ヘルプで来た他店のスタッフも「担当」「お勧めしたスタッフ」に選べるようにする
-- ・other_staff：他店の在籍スタッフ（店舗名つき）。店舗ページで「他店のスタッフも選ぶ」を押したときだけ出す
-- ・help_orders：この店舗のスタッフが他店で取った予約（目標の実績に入れるため。金額と状態だけ）
-- ・在庫は今までどおり、予約を入れた店舗（presale_orders.store_id）の在庫から引く
create or replace function public.presale_portal_data(p_token text, p_pin text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_store bigint;
begin
  select store_id into v_store from public.presale_store_access where url_token = p_token;
  if v_store is null then
    raise exception 'このページのURLは使えません';
  end if;
  perform public.presale_authorize(v_store, p_token, p_pin);
  return jsonb_build_object(
    'store', (select jsonb_build_object('id', s.id, 'name', s.name) from public.stores s where s.id = v_store),
    'campaigns', coalesce((select jsonb_agg(to_jsonb(c) order by c.id desc) from public.presale_campaigns c where c.is_active), '[]'::jsonb),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'campaign_id', i.campaign_id, 'product_id', i.product_id, 'discount_type', i.discount_type,
        'discount_value', i.discount_value, 'bulk_excluded', i.bulk_excluded, 'hidden_store_ids', i.hidden_store_ids,
        'brand', p.brand, 'name', p.name, 'sale_price', p.sale_price))
      from public.presale_items i join public.products p on p.id = i.product_id
      join public.presale_campaigns c on c.id = i.campaign_id and c.is_active), '[]'::jsonb),
    'tiers', coalesce((select jsonb_agg(to_jsonb(t) order by t.min_qty) from public.presale_bulk_tiers t
      join public.presale_campaigns c on c.id = t.campaign_id and c.is_active), '[]'::jsonb),
    'staff', coalesce((select jsonb_agg(to_jsonb(s) order by s.sort_order, s.id) from public.staff s where s.store_id = v_store), '[]'::jsonb),
    'other_staff', coalesce((select jsonb_agg(to_jsonb(s) || jsonb_build_object('store_name', st.name) order by st.sort_order, s.sort_order, s.id)
      from public.staff s join public.stores st on st.id = s.store_id
      where s.store_id <> v_store and s.is_active), '[]'::jsonb),
    'goals', coalesce((select jsonb_agg(to_jsonb(g)) from public.presale_staff_goals g
      join public.staff s on s.id = g.staff_id and s.store_id = v_store), '[]'::jsonb),
    'orders', coalesce((select jsonb_agg(to_jsonb(o) || jsonb_build_object('lines',
        coalesce((select jsonb_agg(to_jsonb(l)) from public.presale_order_lines l where l.order_id = o.id), '[]'::jsonb)))
      from public.presale_orders o join public.presale_campaigns c on c.id = o.campaign_id and c.is_active
      where o.store_id = v_store), '[]'::jsonb),
    'help_orders', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'campaign_id', o.campaign_id, 'store_id', o.store_id,
        'staff_id', o.staff_id, 'total_amount', o.total_amount, 'delivered_at', o.delivered_at, 'cancelled_at', o.cancelled_at))
      from public.presale_orders o join public.presale_campaigns c on c.id = o.campaign_id and c.is_active
      join public.staff s on s.id = o.staff_id and s.store_id = v_store
      where o.store_id <> v_store), '[]'::jsonb),
    'item_sort', coalesce((select jsonb_agg(jsonb_build_object('store_id', x.store_id, 'product_id', x.product_id, 'sort_order', x.sort_order))
      from public.presale_store_item_sort x where x.store_id = v_store), '[]'::jsonb)
  );
end;
$$;

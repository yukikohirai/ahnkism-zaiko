-- 先行予約：対象商品を店舗ごとに非表示にできる（例：LABOでは売るが nit では出さない）
-- 非表示の店舗では、予約の「商品を選ぶ」に出ない。すでにある予約の明細はそのまま表示する
alter table public.presale_items add column if not exists hidden_store_ids bigint[] not null default '{}';

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
    'goals', coalesce((select jsonb_agg(to_jsonb(g)) from public.presale_staff_goals g
      join public.staff s on s.id = g.staff_id and s.store_id = v_store), '[]'::jsonb),
    'orders', coalesce((select jsonb_agg(to_jsonb(o) || jsonb_build_object('lines',
        coalesce((select jsonb_agg(to_jsonb(l)) from public.presale_order_lines l where l.order_id = o.id), '[]'::jsonb)))
      from public.presale_orders o join public.presale_campaigns c on c.id = o.campaign_id and c.is_active
      where o.store_id = v_store), '[]'::jsonb),
    'item_sort', coalesce((select jsonb_agg(jsonb_build_object('store_id', x.store_id, 'product_id', x.product_id, 'sort_order', x.sort_order))
      from public.presale_store_item_sort x where x.store_id = v_store), '[]'::jsonb)
  );
end;
$$;

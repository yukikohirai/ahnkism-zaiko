-- 見るだけページ：お渡しで数を変えた分（もとの予約数）も出す
create or replace function public.presale_view_data(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if not exists (select 1 from public.presale_view_access where url_token = p_token) then
    raise exception 'このページのURLは使えません';
  end if;
  return jsonb_build_object(
    'campaigns', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'is_active', c.is_active,
        'reception_start', c.reception_start, 'reception_end', c.reception_end) order by c.id desc)
      from public.presale_campaigns c where not coalesce(c.is_test, false)), '[]'::jsonb),
    'stores', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name) order by s.sort_order) from public.stores s), '[]'::jsonb),
    'staff', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'store_id', s.store_id, 'name', s.name, 'sort_order', s.sort_order, 'is_active', s.is_active) order by s.sort_order, s.id)
      from public.staff s), '[]'::jsonb),
    'goals', coalesce((select jsonb_agg(jsonb_build_object('campaign_id', g.campaign_id, 'staff_id', g.staff_id, 'goal_amount', g.goal_amount))
      from public.presale_staff_goals g join public.presale_campaigns c on c.id = g.campaign_id and not coalesce(c.is_test, false)), '[]'::jsonb),
    'products', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'brand', p.brand, 'name', p.name))
      from public.products p where exists (select 1 from public.presale_items i where i.product_id = p.id)), '[]'::jsonb),
    'orders', coalesce((select jsonb_agg(jsonb_build_object(
        'id', o.id, 'campaign_id', o.campaign_id, 'store_id', o.store_id, 'reserved_on', o.reserved_on, 'customer_name', o.customer_name,
        'stylist_id', o.stylist_id, 'staff_id', o.staff_id, 'total_amount', o.total_amount, 'delivered_at', o.delivered_at,
        'cancelled_at', o.cancelled_at, 'note', o.note,
        'lines', coalesce((select jsonb_agg(jsonb_build_object('product_id', l.product_id, 'quantity', l.quantity, 'reserved_qty', l.reserved_qty)) from public.presale_order_lines l where l.order_id = o.id), '[]'::jsonb)))
      from public.presale_orders o join public.presale_campaigns c on c.id = o.campaign_id and not coalesce(c.is_test, false)), '[]'::jsonb)
  );
end;
$$;
grant execute on function public.presale_view_data(text) to anon, authenticated;

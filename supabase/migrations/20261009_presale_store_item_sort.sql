-- 先行予約：店舗ごとの商品の並び（本部が設定。店舗の予約ページの商品選びはこの順に出る）
-- 並びは商品単位で持つので、次の企画でも同じ商品は同じ順に出る。設定していない商品は後ろに名前順
create table if not exists public.presale_store_item_sort (
  store_id bigint not null references public.stores(id) on delete cascade,
  product_id bigint not null references public.products(id) on delete cascade,
  sort_order integer not null,
  primary key (store_id, product_id)
);
alter table public.presale_store_item_sort enable row level security;
drop policy if exists presale_store_item_sort_hq_all on public.presale_store_item_sort;
create policy presale_store_item_sort_hq_all on public.presale_store_item_sort for all
  using (exists (select 1 from public.user_profiles p where p.user_id = auth.uid() and p.role = 'hq'))
  with check (exists (select 1 from public.user_profiles p where p.user_id = auth.uid() and p.role = 'hq'));

-- 店舗の予約ページ用のデータに、その店舗の並び（item_sort）を足す
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
        'discount_value', i.discount_value, 'bulk_excluded', i.bulk_excluded,
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

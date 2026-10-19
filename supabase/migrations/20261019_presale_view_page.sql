-- 先行予約の「見るだけ」ページ（スタッフ全員用・URLだけで開ける・入力や修正はできない）
-- ・URLはずっと1つ。企画を増やすと自動でページの選択肢に増える（お試しの企画は出さない）
-- ・本部がURLを作り直すと、今のURLは使えなくなる
create table if not exists public.presale_view_access (
  id integer primary key default 1 check (id = 1),
  url_token text not null unique
);
insert into public.presale_view_access (id, url_token) values (1, replace(gen_random_uuid()::text, '-', ''))
on conflict (id) do nothing;
alter table public.presale_view_access enable row level security;
drop policy if exists presale_view_access_hq_read on public.presale_view_access;
create policy presale_view_access_hq_read on public.presale_view_access for select
  using (exists (select 1 from public.user_profiles p where p.user_id = auth.uid() and p.role = 'hq'));

create or replace function public.reset_presale_view_url()
returns text
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_token text := replace(gen_random_uuid()::text, '-', '');
begin
  perform public.require_hq();
  update public.presale_view_access set url_token = v_token where id = 1;
  return v_token;
end;
$$;
revoke all on function public.reset_presale_view_url() from public;
grant execute on function public.reset_presale_view_url() to authenticated;

-- 見るだけページのデータ（読み取りだけ）
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
        'lines', coalesce((select jsonb_agg(jsonb_build_object('product_id', l.product_id, 'quantity', l.quantity)) from public.presale_order_lines l where l.order_id = o.id), '[]'::jsonb)))
      from public.presale_orders o join public.presale_campaigns c on c.id = o.campaign_id and not coalesce(c.is_test, false)), '[]'::jsonb)
  );
end;
$$;
grant execute on function public.presale_view_data(text) to anon, authenticated;

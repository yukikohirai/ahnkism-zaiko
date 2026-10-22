-- 先行予約：予約の商品ごとの「発注が必要」チェックと、発注済みの区切り（店舗ごと）
-- ・区切り（presale_order_checkpoints）を入れた時刻より後に登録された予約のうち、チェックが付いた商品が次の発注リストに入る
alter table public.presale_order_lines add column if not exists needs_order boolean not null default false;

create table if not exists public.presale_order_checkpoints (
  id uuid primary key default gen_random_uuid(),
  campaign_id bigint not null references public.presale_campaigns(id) on delete cascade,
  store_id bigint not null references public.stores(id),
  note text not null,
  created_by uuid,
  created_at timestamptz not null default now()
);
alter table public.presale_order_checkpoints enable row level security;
drop policy if exists presale_order_checkpoints_hq_all on public.presale_order_checkpoints;
create policy presale_order_checkpoints_hq_all on public.presale_order_checkpoints for all
  using (exists (select 1 from public.user_profiles p where p.user_id = auth.uid() and p.role = 'hq'))
  with check (exists (select 1 from public.user_profiles p where p.user_id = auth.uid() and p.role = 'hq'));

-- 「発注が必要」チェックの付け外し（店舗の予約ページ・本部とも）
create or replace function public.set_presale_line_needs_order(p_store_id bigint, p_token text, p_pin text, p_line_id uuid, p_value boolean)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  perform public.presale_authorize(p_store_id, p_token, p_pin);
  update public.presale_order_lines l set needs_order = p_value
    from public.presale_orders o
   where l.id = p_line_id and o.id = l.order_id and o.store_id = p_store_id;
  if not found then raise exception '予約の商品が見つかりません'; end if;
end;
$$;
grant execute on function public.set_presale_line_needs_order(bigint, text, text, uuid, boolean) to anon, authenticated;

create or replace function public.save_presale_order(p_store_id bigint, p_token text, p_pin text, p_order jsonb)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid := nullif(p_order->>'id', '')::uuid;
  v_campaign bigint := (p_order->>'campaign_id')::bigint;
  v_existing public.presale_orders;
  v_line jsonb;
  v_note text := nullif(trim(coalesce(p_order->>'note', '')), '');
begin
  perform public.presale_authorize(p_store_id, p_token, p_pin);
  if not exists (select 1 from public.presale_campaigns where id = v_campaign) then
    raise exception '企画が見つかりません';
  end if;
  if coalesce(trim(p_order->>'customer_name'), '') = '' then
    raise exception 'お客様の氏名を入力してください';
  end if;
  if jsonb_array_length(coalesce(p_order->'lines', '[]'::jsonb)) = 0 then
    raise exception '商品を1つ以上入れてください';
  end if;
  for v_line in select * from jsonb_array_elements(p_order->'lines') loop
    if coalesce((v_line->>'quantity')::integer, 0) < 1 then
      raise exception '数量は1以上で入力してください';
    end if;
    if not exists (select 1 from public.presale_items i where i.campaign_id = v_campaign and i.product_id = (v_line->>'product_id')::bigint) then
      raise exception '先行予約の対象ではない商品が含まれています';
    end if;
    if nullif(v_line->>'discount_type', '') is not null then
      if v_line->>'discount_type' not in ('percent', 'yen') or coalesce((v_line->>'discount_value')::numeric, -1) < 0 then
        raise exception '割引の入力が正しくありません';
      end if;
      if v_line->>'discount_type' = 'percent' and (v_line->>'discount_value')::numeric > 100 then
        raise exception '％オフは100以下で入力してください';
      end if;
    end if;
  end loop;

  if v_id is null then
    insert into public.presale_orders (campaign_id, store_id, reserved_on, customer_name, stylist_id, staff_id, note)
    values (v_campaign, p_store_id, coalesce((p_order->>'reserved_on')::date, (now() at time zone 'Asia/Tokyo')::date),
            trim(p_order->>'customer_name'), nullif(p_order->>'stylist_id', '')::bigint, nullif(p_order->>'staff_id', '')::bigint, v_note)
    returning id into v_id;
  else
    select * into v_existing from public.presale_orders where id = v_id for update;
    if not found or v_existing.store_id <> p_store_id then
      raise exception '予約が見つかりません';
    end if;
    if v_existing.delivered_at is not null then
      raise exception 'お渡し済みの予約は修正できません。先にお渡し済みを外してください';
    end if;
    update public.presale_orders
    set reserved_on = coalesce((p_order->>'reserved_on')::date, reserved_on),
        customer_name = trim(p_order->>'customer_name'),
        stylist_id = nullif(p_order->>'stylist_id', '')::bigint,
        staff_id = nullif(p_order->>'staff_id', '')::bigint,
        note = v_note
    where id = v_id;
    delete from public.presale_order_lines where order_id = v_id;
  end if;

  -- 同じ商品でも割引が違えば別の行として残す
  insert into public.presale_order_lines (order_id, product_id, quantity, line_discount_type, line_discount_value, needs_order)
  select v_id, (l->>'product_id')::bigint, (l->>'quantity')::integer,
         nullif(l->>'discount_type', ''), case when nullif(l->>'discount_type', '') is null then null else (l->>'discount_value')::numeric end,
         coalesce((l->>'needs_order')::boolean, false)
  from jsonb_array_elements(p_order->'lines') l;

  perform public.presale_price_order(v_id);
  return v_id;
end;
$$;

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
      from public.presale_store_item_sort x where x.store_id = v_store), '[]'::jsonb),
    'checkpoints', coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'campaign_id', k.campaign_id, 'store_id', k.store_id, 'note', k.note, 'created_at', k.created_at) order by k.created_at)
      from public.presale_order_checkpoints k join public.presale_campaigns c on c.id = k.campaign_id and c.is_active
      where k.store_id = v_store), '[]'::jsonb)
  );
end;
$$;

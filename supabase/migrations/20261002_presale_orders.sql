-- 先行予約の作り直し：1お客様＝1件（複数商品）、まとめ買い割引、スタッフ目標、店舗の予約専用ページ（URL＋暗証番号）
-- 旧 presale_reservations は予約0件のまま使わなくなる（削除はしない）

-- まとめ買いの対象外（美容機器など）。個数に数えず、まとめ買いの％も適用しない
alter table public.presale_items add column if not exists bulk_excluded boolean not null default false;

-- まとめ買いの段階（例：3個以上で20%）。企画全体で共通
create table if not exists public.presale_bulk_tiers (
  campaign_id bigint not null references public.presale_campaigns(id) on delete cascade,
  min_qty integer not null check (min_qty >= 2),
  percent numeric not null check (percent >= 0 and percent <= 100),
  primary key (campaign_id, min_qty)
);

-- スタッフの目標金額（企画ごと・税込）
create table if not exists public.presale_staff_goals (
  campaign_id bigint not null references public.presale_campaigns(id) on delete cascade,
  staff_id bigint not null references public.staff(id) on delete cascade,
  goal_amount integer not null default 0 check (goal_amount >= 0),
  primary key (campaign_id, staff_id)
);

-- 予約（1お客様＝1件）。staff_id は「お勧めしたスタッフ」
create table if not exists public.presale_orders (
  id uuid primary key default gen_random_uuid(),
  campaign_id bigint not null references public.presale_campaigns(id) on delete cascade,
  store_id bigint not null references public.stores(id),
  reserved_on date not null default ((now() at time zone 'Asia/Tokyo')::date),
  customer_name text not null,
  stylist_id bigint references public.staff(id),
  staff_id bigint references public.staff(id),
  total_qty integer not null default 0,
  applied_percent numeric,
  total_amount integer not null default 0,
  delivered_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists presale_orders_campaign_store_idx on public.presale_orders (campaign_id, store_id);

-- 予約の商品行。金額は保存時点の税込価格を控える
create table if not exists public.presale_order_lines (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.presale_orders(id) on delete cascade,
  product_id bigint not null references public.products(id),
  quantity integer not null check (quantity > 0),
  regular_price integer,
  unit_price integer,
  delivered_movement_id uuid
);
create index if not exists presale_order_lines_order_idx on public.presale_order_lines (order_id);

-- 店舗の予約専用ページ：URLの合言葉（推測できない文字列）と暗証番号（ハッシュで保存）
create table if not exists public.presale_store_access (
  store_id bigint primary key references public.stores(id),
  url_token text not null unique default replace(gen_random_uuid()::text, '-', ''),
  pin_hash text
);
insert into public.presale_store_access (store_id) select id from public.stores on conflict do nothing;

create table if not exists public.presale_pin_failures (
  url_token text not null,
  failed_at timestamptz not null default now()
);

alter table public.presale_bulk_tiers enable row level security;
alter table public.presale_staff_goals enable row level security;
alter table public.presale_orders enable row level security;
alter table public.presale_order_lines enable row level security;
alter table public.presale_store_access enable row level security;
alter table public.presale_pin_failures enable row level security;

do $$
declare
  t text;
begin
  -- 本部だけが直接読み書き。店舗の予約ページは下の関数（暗証番号の確認つき）だけを通す
  foreach t in array array['presale_bulk_tiers', 'presale_staff_goals', 'presale_orders', 'presale_order_lines', 'presale_store_access'] loop
    execute format('drop policy if exists %I on public.%I', t || '_hq', t);
    execute format($p$create policy %I on public.%I for all
      using (exists (select 1 from public.user_profiles p where p.user_id = auth.uid() and p.role = 'hq'))
      with check (exists (select 1 from public.user_profiles p where p.user_id = auth.uid() and p.role = 'hq'))$p$, t || '_hq', t);
  end loop;
end $$;

-- 呼び出し元がこの店舗を操作してよいか。本部ログイン、または店舗ページの合言葉＋暗証番号
create or replace function public.presale_authorize(p_store_id bigint, p_token text, p_pin text)
returns void
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $$
begin
  if exists (select 1 from public.user_profiles p where p.user_id = auth.uid() and p.role = 'hq') then
    return;
  end if;
  if p_token is null or p_pin is null or not exists (
    select 1 from public.presale_store_access a
    where a.store_id = p_store_id and a.url_token = p_token and a.pin_hash is not null and a.pin_hash = crypt(p_pin, a.pin_hash)
  ) then
    raise exception '暗証番号が違うか、ページのURLが正しくありません';
  end if;
end;
$$;

-- 本部：店舗ページの暗証番号を設定（4桁以上の数字）
create or replace function public.set_presale_pin(p_store_id bigint, p_pin text)
returns void
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $$
begin
  if not exists (select 1 from public.user_profiles p where p.user_id = auth.uid() and p.role = 'hq') then
    raise exception '本部だけが設定できます';
  end if;
  if p_pin !~ '^[0-9]{4,8}$' then
    raise exception '暗証番号は4〜8桁の数字にしてください';
  end if;
  update public.presale_store_access set pin_hash = crypt(p_pin, gen_salt('bf')) where store_id = p_store_id;
end;
$$;

-- 本部：店舗ページのURLを作り直す（前のURLは使えなくなる）
create or replace function public.reset_presale_url(p_store_id bigint)
returns text
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_token text := replace(gen_random_uuid()::text, '-', '');
begin
  if not exists (select 1 from public.user_profiles p where p.user_id = auth.uid() and p.role = 'hq') then
    raise exception '本部だけが設定できます';
  end if;
  update public.presale_store_access set url_token = v_token where store_id = p_store_id;
  return v_token;
end;
$$;

-- 予約の金額計算：まとめ買い対象の合計個数で段階を決め、到達していれば対象商品は全部その％、
-- そうでなければ商品ごとの割引。割引は税込価格に対して、1円未満は四捨五入
create or replace function public.presale_price_order(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_campaign bigint;
  v_count integer;
  v_percent numeric;
begin
  select campaign_id into v_campaign from public.presale_orders where id = p_order_id;

  select coalesce(sum(l.quantity), 0) into v_count
  from public.presale_order_lines l
  join public.presale_items i on i.campaign_id = v_campaign and i.product_id = l.product_id
  where l.order_id = p_order_id and not i.bulk_excluded;

  select percent into v_percent from public.presale_bulk_tiers
  where campaign_id = v_campaign and min_qty <= v_count order by min_qty desc limit 1;

  update public.presale_order_lines l
  set regular_price = round(p.sale_price * 1.1),
      unit_price = case
        when p.sale_price is null then null
        when v_percent is not null and not i.bulk_excluded then round(round(p.sale_price * 1.1) * (1 - v_percent / 100))
        when i.discount_type = 'percent' then round(round(p.sale_price * 1.1) * (1 - i.discount_value / 100))
        else greatest(0, round(p.sale_price * 1.1) - i.discount_value)
      end
  from public.products p, public.presale_items i
  where l.order_id = p_order_id and p.id = l.product_id and i.campaign_id = v_campaign and i.product_id = l.product_id;

  update public.presale_orders o
  set total_qty = v_count,
      applied_percent = v_percent,
      total_amount = coalesce((select sum(coalesce(l.unit_price, 0) * l.quantity) from public.presale_order_lines l where l.order_id = o.id), 0),
      updated_at = now()
  where o.id = p_order_id;
end;
$$;

-- 予約の保存（新規・修正）。p_order: {id?, campaign_id, reserved_on, customer_name, stylist_id, staff_id, lines:[{product_id, quantity}]}
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
  end loop;

  if v_id is null then
    insert into public.presale_orders (campaign_id, store_id, reserved_on, customer_name, stylist_id, staff_id)
    values (v_campaign, p_store_id, coalesce((p_order->>'reserved_on')::date, (now() at time zone 'Asia/Tokyo')::date),
            trim(p_order->>'customer_name'), nullif(p_order->>'stylist_id', '')::bigint, nullif(p_order->>'staff_id', '')::bigint)
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
        staff_id = nullif(p_order->>'staff_id', '')::bigint
    where id = v_id;
    delete from public.presale_order_lines where order_id = v_id;
  end if;

  insert into public.presale_order_lines (order_id, product_id, quantity)
  select v_id, (l->>'product_id')::bigint, sum((l->>'quantity')::integer)
  from jsonb_array_elements(p_order->'lines') l
  group by (l->>'product_id')::bigint;

  perform public.presale_price_order(v_id);
  return v_id;
end;
$$;

-- お渡し済みの切り替え。お渡しで商品ごとに「店販販売」として在庫を減らし、取り消しで戻す
create or replace function public.set_presale_order_delivered(p_store_id bigint, p_token text, p_pin text, p_order_id uuid, p_delivered boolean)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_order public.presale_orders;
  v_line public.presale_order_lines;
  v_movement uuid;
begin
  perform public.presale_authorize(p_store_id, p_token, p_pin);
  select * into v_order from public.presale_orders where id = p_order_id for update;
  if not found or v_order.store_id <> p_store_id then
    raise exception '予約が見つかりません';
  end if;
  if v_order.cancelled_at is not null then
    raise exception 'キャンセル済みの予約です';
  end if;

  if p_delivered and v_order.delivered_at is null then
    for v_line in select * from public.presale_order_lines where order_id = p_order_id loop
      insert into public.inventory_movements (store_id, product_id, occurred_on, quantity, movement_type, note, created_by)
      values (v_order.store_id, v_line.product_id, (now() at time zone 'Asia/Tokyo')::date, -v_line.quantity, 'retail_sale',
              '先行予約お渡し ' || v_order.id, auth.uid())
      returning id into v_movement;
      update public.presale_order_lines set delivered_movement_id = v_movement where id = v_line.id;
    end loop;
    update public.presale_orders set delivered_at = now(), updated_at = now() where id = p_order_id;
  elsif not p_delivered and v_order.delivered_at is not null then
    delete from public.inventory_movements m
    using public.presale_order_lines l
    where l.order_id = p_order_id and m.id = l.delivered_movement_id;
    update public.presale_order_lines set delivered_movement_id = null where order_id = p_order_id;
    update public.presale_orders set delivered_at = null, updated_at = now() where id = p_order_id;
  end if;
end;
$$;

create or replace function public.set_presale_order_cancelled(p_store_id bigint, p_token text, p_pin text, p_order_id uuid, p_cancelled boolean)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_order public.presale_orders;
begin
  perform public.presale_authorize(p_store_id, p_token, p_pin);
  select * into v_order from public.presale_orders where id = p_order_id for update;
  if not found or v_order.store_id <> p_store_id then
    raise exception '予約が見つかりません';
  end if;
  if v_order.delivered_at is not null then
    raise exception 'お渡し済みの予約はキャンセルできません。先にお渡し済みを外してください';
  end if;
  update public.presale_orders
  set cancelled_at = case when p_cancelled then now() else null end, updated_at = now()
  where id = p_order_id;
end;
$$;

-- 店舗の予約ページ：暗証番号の確認（失敗は記録し、15分で10回失敗したら一時的に受け付けない）
create or replace function public.presale_portal_login(p_token text, p_pin text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $$
declare
  v_access public.presale_store_access;
begin
  if (select count(*) from public.presale_pin_failures where url_token = p_token and failed_at > now() - interval '15 minutes') >= 10 then
    return jsonb_build_object('ok', false, 'message', '暗証番号を続けて間違えたため、15分ほど待ってからもう一度お試しください');
  end if;
  select * into v_access from public.presale_store_access where url_token = p_token;
  if not found then
    return jsonb_build_object('ok', false, 'message', 'このページのURLは使えません。本部に確認してください');
  end if;
  if v_access.pin_hash is null or v_access.pin_hash <> crypt(coalesce(p_pin, ''), v_access.pin_hash) then
    insert into public.presale_pin_failures (url_token) values (p_token);
    return jsonb_build_object('ok', false, 'message', '暗証番号が違います');
  end if;
  return jsonb_build_object('ok', true, 'store_id', v_access.store_id);
end;
$$;

-- 店舗の予約ページに必要なデータを一度に返す（自店の分だけ）
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
      where o.store_id = v_store), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.presale_authorize(bigint, text, text) from public;
revoke all on function public.presale_price_order(uuid) from public;
grant execute on function public.set_presale_pin(bigint, text) to authenticated;
grant execute on function public.reset_presale_url(bigint) to authenticated;
grant execute on function public.save_presale_order(bigint, text, text, jsonb) to anon, authenticated;
grant execute on function public.set_presale_order_delivered(bigint, text, text, uuid, boolean) to anon, authenticated;
grant execute on function public.set_presale_order_cancelled(bigint, text, text, uuid, boolean) to anon, authenticated;
grant execute on function public.presale_portal_login(text, text) to anon, authenticated;
grant execute on function public.presale_portal_data(text, text) to anon, authenticated;

-- まとめ買い対象外の初期値：美容機器（ReFa・ドライヤー・ワイドアイロン）
update public.presale_items i set bulk_excluded = true
from public.products p
where p.id = i.product_id and (p.name like 'ReFa%' or p.name like 'ドライヤー%' or p.name like 'パワーストレート%');

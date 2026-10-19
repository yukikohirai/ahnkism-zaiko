-- 先行予約：予約ごとのメモ
alter table public.presale_orders add column if not exists note text;

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
  insert into public.presale_order_lines (order_id, product_id, quantity, line_discount_type, line_discount_value)
  select v_id, (l->>'product_id')::bigint, (l->>'quantity')::integer,
         nullif(l->>'discount_type', ''), case when nullif(l->>'discount_type', '') is null then null else (l->>'discount_value')::numeric end
  from jsonb_array_elements(p_order->'lines') l;

  perform public.presale_price_order(v_id);
  return v_id;
end;
$$;

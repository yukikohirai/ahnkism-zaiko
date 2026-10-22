-- 先行予約：お渡しのときに渡す数を変えられる（例：予約3 → お渡し2、1個は当日キャンセル）
-- ・reserved_qty にもとの予約数を残し、quantity を実際に渡した数にする。金額は渡した数で計算し直す
-- ・在庫は渡した数だけ引く。0個の商品は在庫を動かさない
-- ・お渡し済みを外すと、もとの予約数と金額に戻る
alter table public.presale_order_lines add column if not exists reserved_qty integer;
alter table public.presale_order_lines drop constraint if exists presale_order_lines_quantity_check;
alter table public.presale_order_lines add constraint presale_order_lines_quantity_check
  check (quantity > 0 or (quantity = 0 and reserved_qty is not null));

drop function if exists public.set_presale_order_delivered(bigint, text, text, uuid, boolean);

create or replace function public.set_presale_order_delivered(
  p_store_id bigint, p_token text, p_pin text, p_order_id uuid, p_delivered boolean, p_quantities jsonb default null
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_order public.presale_orders;
  v_line public.presale_order_lines;
  v_movement uuid;
  v_test boolean;
  v_qty integer;
  v_changed boolean := false;
begin
  perform public.presale_authorize(p_store_id, p_token, p_pin);
  select * into v_order from public.presale_orders where id = p_order_id for update;
  if not found or v_order.store_id <> p_store_id then
    raise exception '予約が見つかりません';
  end if;
  if v_order.cancelled_at is not null then
    raise exception 'キャンセル済みの予約です';
  end if;
  select is_test into v_test from public.presale_campaigns where id = v_order.campaign_id;

  if p_delivered and v_order.delivered_at is null then
    -- 渡す数の指定があれば、その数に変える（もとの予約数は reserved_qty に残す）
    if p_quantities is not null then
      for v_line in select * from public.presale_order_lines where order_id = p_order_id loop
        v_qty := coalesce((p_quantities->>v_line.id::text)::integer, v_line.quantity);
        if v_qty < 0 or v_qty > v_line.quantity then
          raise exception '渡す数は0〜予約の数（%）の間で入れてください', v_line.quantity;
        end if;
        if v_qty <> v_line.quantity then
          update public.presale_order_lines set reserved_qty = quantity, quantity = v_qty where id = v_line.id;
          v_changed := true;
        end if;
      end loop;
      if not exists (select 1 from public.presale_order_lines where order_id = p_order_id and quantity > 0) then
        raise exception '渡す数がすべて0です。渡さない場合は予約をキャンセルにしてください';
      end if;
      if v_changed then
        perform public.presale_price_order(p_order_id);
      end if;
    end if;
    -- お試しの企画では在庫を動かさない
    if not coalesce(v_test, false) then
      for v_line in select * from public.presale_order_lines where order_id = p_order_id and quantity > 0 loop
        insert into public.inventory_movements (store_id, product_id, occurred_on, quantity, movement_type, note, created_by)
        values (v_order.store_id, v_line.product_id, (now() at time zone 'Asia/Tokyo')::date, -v_line.quantity, 'retail_sale',
                '先行予約お渡し ' || v_order.id, auth.uid())
        returning id into v_movement;
        update public.presale_order_lines set delivered_movement_id = v_movement where id = v_line.id;
      end loop;
    end if;
    update public.presale_orders set delivered_at = now(), updated_at = now() where id = p_order_id;
  elsif not p_delivered and v_order.delivered_at is not null then
    delete from public.inventory_movements m
    using public.presale_order_lines l
    where l.order_id = p_order_id and m.id = l.delivered_movement_id;
    update public.presale_order_lines set delivered_movement_id = null where order_id = p_order_id;
    -- 渡す数を変えていた分は、もとの予約数と金額に戻す
    if exists (select 1 from public.presale_order_lines where order_id = p_order_id and reserved_qty is not null) then
      update public.presale_order_lines set quantity = reserved_qty, reserved_qty = null where order_id = p_order_id and reserved_qty is not null;
      perform public.presale_price_order(p_order_id);
    end if;
    update public.presale_orders set delivered_at = null, updated_at = now() where id = p_order_id;
  end if;
end;
$$;
grant execute on function public.set_presale_order_delivered(bigint, text, text, uuid, boolean, jsonb) to anon, authenticated;

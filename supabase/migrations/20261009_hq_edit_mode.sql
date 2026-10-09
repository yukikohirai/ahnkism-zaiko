-- 本部の編集モード：締めた月の入出庫を、本部だけが一時的に入力・修正・取り消しできる
-- ・ONにした本部の人だけが対象。30分で自動的にOFFに戻る（店舗はいつでも締めた月を触れない）
-- ・締めた月の記録を変えたら、その店舗・商品の月末在庫の記録（monthly_closing_stock）を自動で計算し直す

create table if not exists public.hq_edit_sessions (
  user_id uuid primary key,
  until timestamptz not null,
  started_at timestamptz not null default now()
);
alter table public.hq_edit_sessions enable row level security;
drop policy if exists hq_edit_sessions_read on public.hq_edit_sessions;
create policy hq_edit_sessions_read on public.hq_edit_sessions for select using (user_id = auth.uid());

-- ONにする（30分）／OFFにする
create or replace function public.set_hq_edit_mode(p_on boolean)
returns timestamptz
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_until timestamptz;
begin
  perform public.require_hq();
  if p_on then
    v_until := now() + interval '30 minutes';
    insert into public.hq_edit_sessions (user_id, until) values (auth.uid(), v_until)
    on conflict (user_id) do update set until = excluded.until, started_at = now();
    return v_until;
  end if;
  delete from public.hq_edit_sessions where user_id = auth.uid();
  return null;
end;
$$;
revoke all on function public.set_hq_edit_mode(boolean) from public;
grant execute on function public.set_hq_edit_mode(boolean) to authenticated;

-- 今の人が編集モード中か（本部で、期限内）
create or replace function public.hq_edit_active()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
    select 1 from public.hq_edit_sessions e
    join public.user_profiles p on p.user_id = e.user_id and p.role = 'hq'
    where e.user_id = auth.uid() and e.until > now()
  )
$$;
grant execute on function public.hq_edit_active() to authenticated;

create or replace function public.guard_closed_month()
returns trigger
language plpgsql
as $$
declare
  v_closed date;
  v_cut date;
begin
  if tg_op = 'UPDATE' and coalesce(current_setting('app.product_merge', true), '') = '1'
     and new.occurred_on = old.occurred_on and new.quantity = old.quantity and new.store_id = old.store_id
     and new.movement_type = old.movement_type then
    return new;
  end if;
  -- 本部の編集モード中は、締めた月でもそのまま入力・修正・取り消しできる（翌月1日への付け替えもしない）
  if public.hq_edit_active() then
    return coalesce(new, old);
  end if;
  select month_end, cut_date into v_closed, v_cut from public.month_closings order by month_end desc limit 1;
  if v_closed is null then
    return coalesce(new, old);
  end if;
  if tg_op in ('UPDATE', 'DELETE') and old.occurred_on <= v_closed then
    raise exception '%月は締めたため、この記録は変更できません。本部の「編集モード」で直してください', extract(month from v_closed);
  end if;
  if tg_op in ('INSERT', 'UPDATE') and new.occurred_on <= v_closed then
    if new.occurred_on > v_cut then
      new.note := concat_ws(' ', new.note, '（実際の日付 ' || to_char(new.occurred_on, 'MM/DD') || '・締め後のため翌月分）');
      new.occurred_on := v_closed + 1;
    else
      raise exception '%月は締めたため、%以前の日付では入力できません', extract(month from v_closed), to_char(v_cut, 'MM/DD');
    end if;
  end if;
  return coalesce(new, old);
end;
$$;

-- 締めた月の記録が変わったら、その店舗・商品の月末在庫の記録を計算し直す
create or replace function public.recalc_closing_stock(p_store_id bigint, p_product_id bigint)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  update public.monthly_closing_stock c
     set closing_stock = coalesce((select sp.opening_stock from public.store_products sp
                                    where sp.store_id = c.store_id and sp.product_id = c.product_id), 0)
                       + coalesce((select sum(m.quantity) from public.inventory_movements m
                                    join public.month_closings mc on mc.year_month = c.year_month
                                    where m.store_id = c.store_id and m.product_id = c.product_id and m.occurred_on <= mc.month_end), 0)
   where c.store_id = p_store_id and c.product_id = p_product_id;
end;
$$;

create or replace function public.after_movement_recalc_closing()
returns trigger
language plpgsql
as $$
declare
  v_closed date := public.closed_through();
begin
  if v_closed is null then return null; end if;
  if tg_op in ('UPDATE', 'DELETE') and old.occurred_on <= v_closed then
    perform public.recalc_closing_stock(old.store_id, old.product_id);
  end if;
  if tg_op in ('INSERT', 'UPDATE') and new.occurred_on <= v_closed
     and (tg_op = 'INSERT' or new.store_id <> old.store_id or new.product_id <> old.product_id or old.occurred_on > v_closed or new.quantity <> old.quantity or new.occurred_on <> old.occurred_on) then
    perform public.recalc_closing_stock(new.store_id, new.product_id);
  end if;
  return null;
end;
$$;
drop trigger if exists inventory_movements_recalc_closing on public.inventory_movements;
create trigger inventory_movements_recalc_closing after insert or update or delete on public.inventory_movements
for each row execute function public.after_movement_recalc_closing();

-- 商品の統合：締めた月の月末在庫は足し算ではなく計算し直しにする（自動の計算し直しと二重にならないように）
create or replace function public.merge_products(p_keep_id bigint, p_remove_id bigint)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_remove public.products;
begin
  perform public.require_hq();
  if p_keep_id is null or p_remove_id is null or p_keep_id = p_remove_id then
    raise exception '残す商品と、まとめて消す商品を別々に選んでください';
  end if;
  if not exists (select 1 from public.products where id = p_keep_id) then raise exception '残す商品が見つかりません'; end if;
  select * into v_remove from public.products where id = p_remove_id;
  if v_remove.id is null then raise exception 'まとめて消す商品が見つかりません'; end if;

  perform set_config('app.product_merge', '1', true);
  perform set_config('app.staff_purchase_op', '1', true);

  -- 店舗の取扱：両方ある店舗は繰越を足して1行に
  update public.store_products k
     set opening_stock = k.opening_stock + r.opening_stock,
         is_active = k.is_active or r.is_active,
         updated_at = now()
    from public.store_products r
   where k.product_id = p_keep_id and r.product_id = p_remove_id and k.store_id = r.store_id;
  delete from public.store_products r
   where r.product_id = p_remove_id
     and exists (select 1 from public.store_products k where k.product_id = p_keep_id and k.store_id = r.store_id);
  update public.store_products set product_id = p_keep_id where product_id = p_remove_id;

  -- 入出庫の履歴・店舗間移動・スタッフ購入・先行予約の明細は付け替えるだけ
  update public.inventory_movements set product_id = p_keep_id where product_id = p_remove_id;
  update public.stock_transfers set product_id = p_keep_id where product_id = p_remove_id;
  update public.staff_purchases set product_id = p_keep_id where product_id = p_remove_id;
  update public.presale_reservations set product_id = p_keep_id where product_id = p_remove_id;
  update public.presale_order_lines set product_id = p_keep_id where product_id = p_remove_id;

  -- 店舗入力の下書き：同じ報告に両方あれば数を足す
  update public.inventory_session_items k
     set quantity = k.quantity + r.quantity, updated_at = now()
    from public.inventory_session_items r
   where k.product_id = p_keep_id and r.product_id = p_remove_id and k.session_id = r.session_id;
  delete from public.inventory_session_items r
   where r.product_id = p_remove_id
     and exists (select 1 from public.inventory_session_items k where k.product_id = p_keep_id and k.session_id = r.session_id);
  update public.inventory_session_items set product_id = p_keep_id where product_id = p_remove_id;

  -- 先行予約の対象商品：両方あれば残す方の設定を使う
  delete from public.presale_items r
   where r.product_id = p_remove_id
     and exists (select 1 from public.presale_items k where k.product_id = p_keep_id and k.campaign_id = r.campaign_id);
  update public.presale_items set product_id = p_keep_id where product_id = p_remove_id;

  -- 先行分の確保数：両方あれば足す
  update public.presale_allocations k
     set allocated_qty = k.allocated_qty + r.allocated_qty
    from public.presale_allocations r
   where k.product_id = p_keep_id and r.product_id = p_remove_id and k.campaign_id = r.campaign_id and k.store_id = r.store_id;
  delete from public.presale_allocations r
   where r.product_id = p_remove_id
     and exists (select 1 from public.presale_allocations k where k.product_id = p_keep_id and k.campaign_id = r.campaign_id and k.store_id = r.store_id);
  update public.presale_allocations set product_id = p_keep_id where product_id = p_remove_id;

  -- 締めた月の月末在庫：付け替えたあと、残す方を履歴から計算し直す（足し算すると二重になるため）
  delete from public.monthly_closing_stock r
   where r.product_id = p_remove_id
     and exists (select 1 from public.monthly_closing_stock k where k.product_id = p_keep_id and k.year_month = r.year_month and k.store_id = r.store_id);
  update public.monthly_closing_stock set product_id = p_keep_id where product_id = p_remove_id;
  perform public.recalc_closing_stock(s.store_id, p_keep_id) from (select distinct store_id from public.monthly_closing_stock where product_id = p_keep_id) s;

  -- 以前の試作の記録（usage_logs など）も付け替え。同じ日があれば数を足す
  update public.usage_logs k
     set quantity = k.quantity + r.quantity
    from public.usage_logs r
   where k.product_id = p_keep_id and r.product_id = p_remove_id and k.store_id = r.store_id and k.date = r.date;
  delete from public.usage_logs r
   where r.product_id = p_remove_id
     and exists (select 1 from public.usage_logs k where k.product_id = p_keep_id and k.store_id = r.store_id and k.date = r.date);
  update public.usage_logs set product_id = p_keep_id where product_id = p_remove_id;
  update public.stock_receipts set product_id = p_keep_id where product_id = p_remove_id;
  update public.monthly_balance set product_id = p_keep_id where product_id = p_remove_id;

  perform set_config('app.product_merge', '', true);
  perform set_config('app.staff_purchase_op', '', true);

  insert into public.product_merges (kept_product_id, removed_product_id, removed_brand, removed_name, merged_by)
  values (p_keep_id, p_remove_id, v_remove.brand, v_remove.name, auth.uid());

  delete from public.products where id = p_remove_id;
end;
$$;

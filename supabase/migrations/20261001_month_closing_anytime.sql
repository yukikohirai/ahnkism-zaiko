-- 月締めはいつでも（その月に入っていれば）押せる。押した日を「締め日」とし、
-- 締め日の翌日〜月末に入った記録は、自動で翌月1日の記録にする（実際の日付はメモに残す）

alter table public.month_closings add column if not exists cut_date date;
update public.month_closings set cut_date = month_end where cut_date is null;
alter table public.month_closings alter column cut_date set not null;

-- 入力できる最初の日（最後に締めた日の翌日）。締めていなければ null
create or replace function public.open_from()
returns date
language sql
stable
security definer
set search_path to 'public'
as $$ select max(cut_date) + 1 from public.month_closings $$;
grant execute on function public.open_from() to anon, authenticated;

create or replace function public.guard_closed_month()
returns trigger
language plpgsql
as $$
declare
  v_closed date;
  v_cut date;
begin
  select month_end, cut_date into v_closed, v_cut from public.month_closings order by month_end desc limit 1;
  if v_closed is null then
    return coalesce(new, old);
  end if;
  if tg_op in ('UPDATE', 'DELETE') and old.occurred_on <= v_closed then
    raise exception '%月は締めたため、この記録は変更できません。違いは誤差調整で直してください', extract(month from v_closed);
  end if;
  if tg_op in ('INSERT', 'UPDATE') and new.occurred_on <= v_closed then
    if new.occurred_on > v_cut then
      -- 締め日の翌日〜月末の分は翌月1日の記録にする
      new.note := concat_ws(' ', new.note, '（実際の日付 ' || to_char(new.occurred_on, 'MM/DD') || '・締め後のため翌月分）');
      new.occurred_on := v_closed + 1;
    else
      raise exception '%月は締めたため、%以前の日付では入力できません', extract(month from v_closed), to_char(v_cut, 'MM/DD');
    end if;
  end if;
  return coalesce(new, old);
end;
$$;

create or replace function public.close_month(p_year_month text)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_month_start date := to_date(p_year_month || '-01', 'YYYY-MM-DD');
  v_month_end date := (to_date(p_year_month || '-01', 'YYYY-MM-DD') + interval '1 month' - interval '1 day')::date;
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_cut date;
  v_last date := public.closed_through();
  v_rows integer;
begin
  if not exists (select 1 from public.user_profiles p where p.user_id = auth.uid() and p.role = 'hq') then
    raise exception '本部だけが月締めできます';
  end if;
  if exists (select 1 from public.month_closings where year_month = p_year_month) then
    raise exception '%はすでに締めています', p_year_month;
  end if;
  if v_last is not null and v_month_start <> v_last + 1 then
    raise exception '月締めは1か月ずつ順番に行ってください（次は%）', to_char(v_last + 1, 'YYYY-MM');
  end if;
  if v_today < v_month_start then
    raise exception '%月になってから締めてください', extract(month from v_month_start);
  end if;
  v_cut := least(v_today, v_month_end);
  if exists (select 1 from public.inventory_sessions s where s.status = 'draft' and s.entry_date <= v_cut
             and exists (select 1 from public.inventory_session_items i where i.session_id = s.id and i.quantity > 0)) then
    raise exception 'まだ送信されていない店舗の使用報告（%以前の日付）があります。送信してから締めてください', to_char(v_cut, 'MM/DD');
  end if;

  -- すでに入っている「締め日の翌日〜月末」の記録（先の日付で入れた入荷など）も翌月1日に移す
  perform set_config('app.staff_purchase_op', '1', true);
  update public.inventory_movements
     set note = concat_ws(' ', note, '（実際の日付 ' || to_char(occurred_on, 'MM/DD') || '・締め後のため翌月分）'),
         occurred_on = v_month_end + 1
   where occurred_on > v_cut and occurred_on <= v_month_end;
  perform set_config('app.staff_purchase_op', '', true);

  insert into public.month_closings (year_month, month_end, cut_date, closed_by) values (p_year_month, v_month_end, v_cut, auth.uid());

  insert into public.monthly_closing_stock (year_month, store_id, product_id, closing_stock)
  select p_year_month, sp.store_id, sp.product_id,
         sp.opening_stock + coalesce((select sum(m.quantity) from public.inventory_movements m
                                      where m.store_id = sp.store_id and m.product_id = sp.product_id and m.occurred_on <= v_month_end), 0)
  from public.store_products sp;
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

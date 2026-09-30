-- 月締め：押した時点でその月末の在庫を翌月の繰越として保存し、締めた月の記録をロックする（解除はしない）

create table if not exists public.month_closings (
  year_month text primary key check (year_month ~ '^\d{4}-\d{2}$'),
  month_end date not null,
  closed_at timestamptz not null default now(),
  closed_by uuid
);
comment on table public.month_closings is '締めた月。この月末以前の入出庫は追加・修正・取り消しできない';

create table if not exists public.monthly_closing_stock (
  year_month text not null references public.month_closings(year_month),
  store_id bigint not null references public.stores(id),
  product_id bigint not null references public.products(id),
  closing_stock integer not null,
  primary key (year_month, store_id, product_id)
);
comment on table public.monthly_closing_stock is '締めた月の月末在庫（＝翌月の繰越）の記録';

alter table public.month_closings enable row level security;
alter table public.monthly_closing_stock enable row level security;
drop policy if exists month_closings_read on public.month_closings;
create policy month_closings_read on public.month_closings for select using (auth.uid() is not null);
drop policy if exists monthly_closing_stock_read on public.monthly_closing_stock;
create policy monthly_closing_stock_read on public.monthly_closing_stock for select using (auth.uid() is not null);

-- 締めた月の最終日（締めていなければ null）
create or replace function public.closed_through()
returns date
language sql
stable
security definer
set search_path to 'public'
as $$ select max(month_end) from public.month_closings $$;
grant execute on function public.closed_through() to anon, authenticated;

-- 締めた期間の入出庫は、誰であっても追加・修正・取り消しできない
create or replace function public.guard_closed_month()
returns trigger
language plpgsql
as $$
declare
  v_closed date := public.closed_through();
begin
  if v_closed is null then
    return coalesce(new, old);
  end if;
  if tg_op in ('UPDATE', 'DELETE') and old.occurred_on <= v_closed then
    raise exception '%月は締めたため、この記録は変更できません。違いは誤差調整で直してください', extract(month from v_closed);
  end if;
  if tg_op in ('INSERT', 'UPDATE') and new.occurred_on <= v_closed then
    raise exception '%月は締めたため、%以前の日付では入力できません', extract(month from v_closed), to_char(v_closed, 'MM/DD');
  end if;
  return coalesce(new, old);
end;
$$;
drop trigger if exists inventory_movements_closed_guard on public.inventory_movements;
create trigger inventory_movements_closed_guard before insert or update or delete on public.inventory_movements
for each row execute function public.guard_closed_month();

-- 月締めの実行（本部だけ）。順番に1か月ずつ、月末（日本時間）を迎えてから
create or replace function public.close_month(p_year_month text)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_month_start date := to_date(p_year_month || '-01', 'YYYY-MM-DD');
  v_month_end date := (to_date(p_year_month || '-01', 'YYYY-MM-DD') + interval '1 month' - interval '1 day')::date;
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
  if (now() at time zone 'Asia/Tokyo')::date < v_month_end then
    raise exception '%月末（%）になってから締めてください', extract(month from v_month_end), to_char(v_month_end, 'MM/DD');
  end if;
  if exists (select 1 from public.inventory_sessions s where s.status = 'draft' and s.entry_date <= v_month_end
             and exists (select 1 from public.inventory_session_items i where i.session_id = s.id and i.quantity > 0)) then
    raise exception 'まだ送信されていない店舗の使用報告（%以前の日付）があります。送信してから締めてください', to_char(v_month_end, 'MM/DD');
  end if;

  insert into public.month_closings (year_month, month_end, closed_by) values (p_year_month, v_month_end, auth.uid());

  -- 月末在庫 ＝ 8月末の繰越（opening_stock）＋ 月末までの入出庫すべて
  insert into public.monthly_closing_stock (year_month, store_id, product_id, closing_stock)
  select p_year_month, sp.store_id, sp.product_id,
         sp.opening_stock + coalesce((select sum(m.quantity) from public.inventory_movements m
                                      where m.store_id = sp.store_id and m.product_id = sp.product_id and m.occurred_on <= v_month_end), 0)
  from public.store_products sp;
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;
revoke all on function public.close_month(text) from public;
grant execute on function public.close_month(text) to authenticated;

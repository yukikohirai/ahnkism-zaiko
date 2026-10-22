-- 月次レポート：材料費以外の経費（修繕費など）を店舗ごとに1件ずつ記録する。金額は税抜で保存
create table if not exists public.expense_categories (
  id bigint generated always as identity primary key,
  name text not null unique,
  sort_order integer not null default 0
);
insert into public.expense_categories (name, sort_order) values ('修繕費', 1) on conflict (name) do nothing;

create table if not exists public.monthly_expenses (
  id uuid primary key default gen_random_uuid(),
  store_id bigint not null references public.stores(id),
  spent_on date not null,
  category_id bigint not null references public.expense_categories(id),
  amount integer not null check (amount >= 0),
  note text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists monthly_expenses_spent_on_idx on public.monthly_expenses (spent_on);

alter table public.expense_categories enable row level security;
alter table public.monthly_expenses enable row level security;
drop policy if exists expense_categories_hq_all on public.expense_categories;
create policy expense_categories_hq_all on public.expense_categories for all
  using (exists (select 1 from public.user_profiles p where p.user_id = auth.uid() and p.role = 'hq'))
  with check (exists (select 1 from public.user_profiles p where p.user_id = auth.uid() and p.role = 'hq'));
drop policy if exists monthly_expenses_hq_all on public.monthly_expenses;
create policy monthly_expenses_hq_all on public.monthly_expenses for all
  using (exists (select 1 from public.user_profiles p where p.user_id = auth.uid() and p.role = 'hq'))
  with check (exists (select 1 from public.user_profiles p where p.user_id = auth.uid() and p.role = 'hq'));

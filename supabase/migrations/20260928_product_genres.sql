-- 材料費のジャンル分け（カラー・ストレート…）。ジャンル自体を後から追加・名称変更・削除できる
create table if not exists public.product_genres (
  id bigint generated always as identity primary key,
  name text not null unique,
  sort_order integer not null default 0
);
comment on table public.product_genres is '月次レポートの材料費をジャンル別に集計するための分類';
alter table public.product_genres enable row level security;
drop policy if exists product_genres_read on public.product_genres;
create policy product_genres_read on public.product_genres for select using (auth.uid() is not null);
drop policy if exists product_genres_hq_write on public.product_genres;
create policy product_genres_hq_write on public.product_genres for all
using (exists (select 1 from public.user_profiles p where p.user_id = auth.uid() and p.role = 'hq'))
with check (exists (select 1 from public.user_profiles p where p.user_id = auth.uid() and p.role = 'hq'));

-- ジャンルを削除すると、その商品は未分類（null）に戻る
alter table public.products add column if not exists genre_id bigint references public.product_genres(id) on delete set null;
comment on column public.products.genre_id is '材料費のジャンル。null は未分類';

insert into public.product_genres (name, sort_order) values
  ('カラー', 1), ('ストレート', 2), ('トリートメント', 3), ('備品', 4)
on conflict (name) do nothing;

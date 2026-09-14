-- 発注リスト専用の並び順（店舗ごと）
alter table public.store_products add column if not exists order_sort integer;
comment on column public.store_products.order_sort is '発注リスト専用の並び順（店舗ごと・発注先の中での順番）';

create table if not exists public.order_supplier_sort (
  store_id bigint not null references public.stores(id),
  supplier text not null,
  sort_order integer not null,
  primary key (store_id, supplier)
);
comment on table public.order_supplier_sort is '発注リストでの発注先ブロックの並び順（店舗ごと）';
alter table public.order_supplier_sort enable row level security;
drop policy if exists order_supplier_sort_hq_all on public.order_supplier_sort;
create policy order_supplier_sort_hq_all on public.order_supplier_sort
for all
using (exists (select 1 from public.user_profiles p where p.user_id = auth.uid() and p.role = 'hq'))
with check (exists (select 1 from public.user_profiles p where p.user_id = auth.uid() and p.role = 'hq'));

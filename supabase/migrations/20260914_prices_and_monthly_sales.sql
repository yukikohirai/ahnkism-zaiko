-- 仕入れ値・販売価格（税抜・円）と、業務用／店販用の区分、月の売上

alter table public.products add column if not exists cost_price integer check (cost_price is null or cost_price >= 0);
alter table public.products add column if not exists sale_price integer check (sale_price is null or sale_price >= 0);
alter table public.products add column if not exists product_type text not null default 'material'
  check (product_type in ('material', 'retail'));
comment on column public.products.cost_price is '仕入れ値（税抜・円）';
comment on column public.products.sale_price is '販売価格（税抜・円）';
comment on column public.products.product_type is 'material=業務用（入荷を材料費に計上）／retail=店販用（販売は店販原価、業務利用は材料費）';

-- 初期値：店販・店販②・店販オージュアは店販用
update public.products p set product_type = 'retail'
from public.categories c
where c.id = p.category_id and c.name in ('店販', '店販②', '店販オージュア');

-- 全店在庫のうち販売する物（ルヴニール・95SENSE・AHNKISMオイル・ReFa系・ドライヤー）
update public.products p set product_type = 'retail'
from public.categories c
where c.id = p.category_id and c.name = '全店在庫'
  and (p.name like 'ルヴニール%' or p.name like '95SENSE%' or p.name like 'AHNKISMオイル%'
       or p.name like 'ReFa%' or p.name like 'パワーストレート%' or p.name like 'ドライヤー%');

create table if not exists public.monthly_sales (
  store_id bigint not null references public.stores(id),
  year_month text not null check (year_month ~ '^\d{4}-\d{2}$'),
  treatment_sales integer check (treatment_sales is null or treatment_sales >= 0),
  retail_sales integer check (retail_sales is null or retail_sales >= 0),
  updated_at timestamptz not null default now(),
  primary key (store_id, year_month)
);
comment on table public.monthly_sales is '店舗×月の売上（税抜・円）。施術売上と店販売上';
alter table public.monthly_sales enable row level security;
drop policy if exists monthly_sales_hq_all on public.monthly_sales;
create policy monthly_sales_hq_all on public.monthly_sales
for all
using (exists (select 1 from public.user_profiles p where p.user_id = auth.uid() and p.role = 'hq'))
with check (exists (select 1 from public.user_profiles p where p.user_id = auth.uid() and p.role = 'hq'));

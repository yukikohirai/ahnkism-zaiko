-- 発注しない商品（店舗別在庫では今月の使用数だけ表示）
alter table public.products add column if not exists usage_only boolean not null default false;
comment on column public.products.usage_only is '発注しない商品。店舗別在庫では在庫・必要数を出さず今月の使用数だけ表示する';
-- LABO ユーショー／ケラチン系
update public.products set usage_only = true where id in (585, 586, 590, 591, 592, 593);

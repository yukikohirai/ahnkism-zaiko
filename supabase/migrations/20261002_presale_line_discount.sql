-- 予約の商品行ごとの割引（空ならいつもの割引・まとめ買い）。
-- 本番には apply_migration で適用済み。関数 presale_price_order / save_presale_order を行ごとの割引に対応させた。
alter table public.presale_order_lines add column if not exists line_discount_type text check (line_discount_type in ('percent', 'yen'));
alter table public.presale_order_lines add column if not exists line_discount_value numeric check (line_discount_value is null or line_discount_value >= 0);
-- 関数本体は 20261002_presale_orders.sql の同名関数を置き換え（優先順：行の割引 → まとめ買い → 商品ごとの割引）

-- お試しの企画（is_test）：お渡し済みにしても在庫を減らさず、先行分も発注リストに反映しない
alter table public.presale_campaigns add column if not exists is_test boolean not null default false;
-- set_presale_order_delivered は is_test の企画では inventory_movements を作らないように置き換え済み

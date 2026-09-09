-- 発注先は「商品ごとに1つ」に統一する。
-- 店舗別の上書き（store_products.dealer_override）は使わないため中身を空にする。
-- 列自体は履歴確認のため残す（削除しない）。
update public.store_products
set dealer_override = null,
    updated_at = now()
where dealer_override is not null;

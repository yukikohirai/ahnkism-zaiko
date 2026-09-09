-- 全店在庫カテゴリ（id=9）と29商品、3店舗分の store_products を追加
-- LABO(store_id=1) のみ8月末繰越を opening_stock に設定。nit/elu は 0。
-- 「モノ」はスプレッドシートが -1 のため 0 に補正。

insert into categories (id, name, sort_order)
values (9, '全店在庫', 9)
on conflict (id) do nothing;

select setval('categories_id_seq', (select max(id) from categories));

insert into products (category_id, brand, name, manufacturer, dealer, required_qty, sort_order, is_active)
select 9, null, v.name, v.manufacturer, null, 0, v.sort_order, true
from (values
  (1,  null::text,        'アマテラス6.0銀'),
  (2,  null,              'アマテラス9.0緑'),
  (3,  null,              'ルヴニール シャンプー'),
  (4,  null,              'ラポール00'),
  (5,  null,              'ラポール01'),
  (6,  null,              'ラポール02'),
  (7,  'センス',          '95SENSE シャンプー500ml'),
  (8,  'センス',          '95SENSE トリートメント500g'),
  (9,  'センス',          '95SENSE シャンプー詰替'),
  (10, 'センス',          '95SENSE トリートメント詰替'),
  (11, 'きくや（ムコタ）', 'AHNKISMオイル SS'),
  (12, 'きくや（ムコタ）', 'AHNKISMオイル EM'),
  (13, 'きくや（ムコタ）', 'AHNKISMオイル EMレフィル'),
  (14, 'きくや（ムコタ）', 'AHNKISMオイル 緑'),
  (15, 'リファ',          'ReFa ストレートアイロンプロ'),
  (16, 'リファ',          'ReFa カールアイロンプロ32'),
  (17, 'リファ',          'ReFa カールアイロンプロ38'),
  (18, 'リファ',          'パワーストレート（ワイドアイロン）'),
  (19, 'リファ',          'ドライヤー W'),
  (20, 'リファ',          'ドライヤー スマートS＋'),
  (21, 'リファ',          'ドライヤー SE'),
  (22, null,              'スピカ'),
  (23, null,              'モノ'),
  (24, null,              'ツガミ'),
  (25, null,              'リュクス ケラチンブースター250g'),
  (26, null,              'Cインナーボンド'),
  (27, null,              'シチリン ピリン'),
  (28, null,              'Dルネート'),
  (29, null,              'Fルネート')
) as v(sort_order, manufacturer, name)
where not exists (select 1 from products where category_id = 9);

insert into store_products (store_id, product_id, opening_stock, required_qty, sort_order, is_active)
select s.id,
       p.id,
       case when s.id = 1 then v.opening_stock else 0 end,
       0,
       p.sort_order,
       true
from products p
join (values
  ('アマテラス6.0銀', 2),
  ('アマテラス9.0緑', 0),
  ('ルヴニール シャンプー', 8),
  ('ラポール00', 8),
  ('ラポール01', 8),
  ('ラポール02', 8),
  ('95SENSE シャンプー500ml', 19),
  ('95SENSE トリートメント500g', 25),
  ('95SENSE シャンプー詰替', 0),
  ('95SENSE トリートメント詰替', 7),
  ('AHNKISMオイル SS', 5),
  ('AHNKISMオイル EM', 4),
  ('AHNKISMオイル EMレフィル', 0),
  ('AHNKISMオイル 緑', 2),
  ('ReFa ストレートアイロンプロ', 1),
  ('ReFa カールアイロンプロ32', 0),
  ('ReFa カールアイロンプロ38', 8),
  ('パワーストレート（ワイドアイロン）', 0),
  ('ドライヤー W', 5),
  ('ドライヤー スマートS＋', 0),
  ('ドライヤー SE', 1),
  ('スピカ', 2),
  ('モノ', 0),
  ('ツガミ', 0),
  ('リュクス ケラチンブースター250g', 0),
  ('Cインナーボンド', 0),
  ('シチリン ピリン', 0),
  ('Dルネート', 0),
  ('Fルネート', 0)
) as v(name, opening_stock) on v.name = p.name
cross join stores s
where p.category_id = 9
on conflict (store_id, product_id) do nothing;

-- タスク②: LABO の att シルク系10商品の繰越（8月末在庫）を修正。必要数は 0 のまま。
update store_products sp
set opening_stock = v.opening_stock, updated_at = now()
from (values
  (634, 15), (636, 18), (633, 27), (638, 20), (632, 20),
  (630, 17), (639, 20), (631, 17), (635, 25), (637, 44)
) as v(product_id, opening_stock)
where sp.store_id = 1 and sp.product_id = v.product_id;

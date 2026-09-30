-- 木村さんの集金シート（2025/3〜2026/9）を「過去分」として取り込むための準備
-- ・過去分（kind = legacy）は在庫を動かさず、金庫・ディーラー支払い用の残高にも入れない（残高は「開始残高」で合わせる）
-- ・シートの名前・商品名・金額は書かれたまま残す（マイナスや名前なしの行も入れる。あとで画面から修正・削除する）

-- 名簿にいない過去の人は、店舗なし・選択肢に出さない（is_active = false）形で名簿に入れる
alter table public.staff alter column store_id drop not null;

alter table public.staff_purchases alter column staff_id drop not null;
alter table public.staff_purchases alter column store_id drop not null;
alter table public.staff_purchases add column if not exists legacy_name text;
alter table public.staff_purchases add column if not exists source_ref text;

alter table public.staff_purchases drop constraint if exists staff_purchases_kind_check;
alter table public.staff_purchases add constraint staff_purchases_kind_check check (kind in ('store_stock', 'personal_order', 'legacy'));

alter table public.staff_purchases drop constraint if exists staff_purchases_unit_price_check;
alter table public.staff_purchases add constraint staff_purchases_unit_price_check check (unit_price >= 0 or kind = 'legacy');

alter table public.staff_purchases drop constraint if exists staff_purchases_item_check;
alter table public.staff_purchases add constraint staff_purchases_item_check check (
  kind = 'legacy'
  or (product_id is not null and item_name is null)
  or (product_id is null and item_name is not null and kind = 'personal_order')
);

alter table public.staff_purchases drop constraint if exists staff_purchases_dealer_check;
alter table public.staff_purchases add constraint staff_purchases_dealer_check check (
  (kind = 'personal_order' and dealer is not null) or (kind in ('store_stock', 'legacy') and dealer is null)
);

alter table public.staff_purchases drop constraint if exists staff_purchases_required_check;
alter table public.staff_purchases add constraint staff_purchases_required_check check (
  kind = 'legacy' or (staff_id is not null and store_id is not null)
);

alter table public.staff_purchases drop constraint if exists staff_purchases_legacy_check;
alter table public.staff_purchases add constraint staff_purchases_legacy_check check (
  kind <> 'legacy' or (movement_id is null and product_id is null and collected_on is null)
);

-- 開始残高（「今の残高」を1回だけ入れる。ディーラー支払い用はディーラーごと）
create table if not exists public.cash_openings (
  id uuid primary key default gen_random_uuid(),
  box text not null check (box in ('safe', 'dealer')),
  dealer text,
  amount integer not null,
  as_of date not null,
  note text,
  created_by uuid,
  created_at timestamptz not null default now(),
  check ((box = 'dealer' and dealer is not null) or (box = 'safe' and dealer is null))
);
alter table public.cash_openings enable row level security;
drop policy if exists cash_openings_hq_all on public.cash_openings;
create policy cash_openings_hq_all on public.cash_openings for all
  using (exists (select 1 from public.user_profiles p where p.user_id = auth.uid() and p.role = 'hq'))
  with check (exists (select 1 from public.user_profiles p where p.user_id = auth.uid() and p.role = 'hq'));

-- 過去分の修正（日付・スタッフ・商品名・金額・メモ）
create or replace function public.update_legacy_purchase(
  p_id uuid, p_purchased_on date, p_staff_id bigint, p_item_name text, p_amount integer, p_note text default null
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  perform public.require_hq();
  if p_purchased_on is null then raise exception '日付を入力してください'; end if;
  if p_amount is null then raise exception '金額を入力してください'; end if;
  update public.staff_purchases
     set purchased_on = p_purchased_on,
         staff_id = p_staff_id,
         item_name = nullif(trim(p_item_name), ''),
         quantity = 1,
         unit_price = p_amount,
         note = nullif(trim(p_note), '')
   where id = p_id and kind = 'legacy';
  if not found then raise exception '過去分の記録が見つかりません'; end if;
end;
$$;
revoke all on function public.update_legacy_purchase(uuid, date, bigint, text, integer, text) from public;
grant execute on function public.update_legacy_purchase(uuid, date, bigint, text, integer, text) to authenticated;

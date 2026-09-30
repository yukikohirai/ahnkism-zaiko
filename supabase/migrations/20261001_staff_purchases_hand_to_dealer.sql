-- 個人発注は「未集金 → 集金済み → ディーラーに渡した」の3段階。渡すときは行を選んで、渡した記録（cash_payouts）を自動で作る
alter table public.staff_purchases add column if not exists handed_on date;
alter table public.staff_purchases add column if not exists payout_id uuid references public.cash_payouts(id);

alter table public.staff_purchases drop constraint if exists staff_purchases_handed_check;
alter table public.staff_purchases add constraint staff_purchases_handed_check check (
  (handed_on is null and payout_id is null)
  or (handed_on is not null and payout_id is not null and kind = 'personal_order' and collected_on is not null)
);

-- 選んだ行をディーラーに渡す（1回に1ディーラー分）
create or replace function public.hand_to_dealer(p_ids uuid[], p_paid_at timestamptz, p_note text default null)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_dealers text[];
  v_amount integer;
  v_count integer;
  v_payout uuid;
begin
  perform public.require_hq();
  if p_ids is null or array_length(p_ids, 1) is null then raise exception '渡す行を選んでください'; end if;
  select count(*), array_agg(distinct dealer), sum(quantity * unit_price)
    into v_count, v_dealers, v_amount
    from public.staff_purchases where id = any(p_ids);
  if v_count <> array_length(p_ids, 1) then raise exception '選んだ行が見つかりません。開き直してください'; end if;
  if exists (select 1 from public.staff_purchases where id = any(p_ids) and (kind <> 'personal_order' or collected_on is null or handed_on is not null)) then
    raise exception '渡せるのは、集金済みでまだ渡していない個人発注だけです';
  end if;
  if array_length(v_dealers, 1) <> 1 then raise exception '1回に渡せるのは1つのディーラー分だけです'; end if;
  if v_amount <= 0 then raise exception '金額が0円のため渡せません'; end if;

  insert into public.cash_payouts (box, dealer, paid_at, amount, note, created_by)
  values ('dealer', v_dealers[1], p_paid_at, v_amount, nullif(trim(p_note), ''), auth.uid())
  returning id into v_payout;

  update public.staff_purchases
     set handed_on = (p_paid_at at time zone 'Asia/Tokyo')::date, payout_id = v_payout
   where id = any(p_ids);
  return v_payout;
end;
$$;

-- 1行だけ「渡した」を取り消す（渡した記録の金額も減らし、0円になったら記録ごと消す）
create or replace function public.unhand_purchase(p_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_row public.staff_purchases;
begin
  perform public.require_hq();
  select * into v_row from public.staff_purchases where id = p_id;
  if v_row.id is null or v_row.payout_id is null then raise exception 'ディーラーに渡した記録がありません'; end if;
  update public.staff_purchases set handed_on = null, payout_id = null where id = p_id;
  update public.cash_payouts set amount = amount - v_row.quantity * v_row.unit_price
   where id = v_row.payout_id and amount - v_row.quantity * v_row.unit_price > 0;
  if not found then
    delete from public.cash_payouts where id = v_row.payout_id
      and not exists (select 1 from public.staff_purchases where payout_id = v_row.payout_id);
  end if;
end;
$$;

-- ディーラーに渡した記録を丸ごと取り消す（つながった行は「集金済み・未渡し」に戻る）
create or replace function public.cancel_dealer_payout(p_payout_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  perform public.require_hq();
  update public.staff_purchases set handed_on = null, payout_id = null where payout_id = p_payout_id;
  delete from public.cash_payouts where id = p_payout_id;
end;
$$;

-- 渡した行は、集金済みを外せない（先に「渡した」を取り消す）
create or replace function public.set_staff_purchase_collected(p_ids uuid[], p_collected boolean)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_count integer;
begin
  perform public.require_hq();
  if not p_collected and exists (select 1 from public.staff_purchases where id = any(p_ids) and handed_on is not null) then
    raise exception 'ディーラーに渡した行は集金済みを外せません。先に「渡した」を取り消してください';
  end if;
  update public.staff_purchases
     set collected_on = case when p_collected then coalesce(collected_on, (now() at time zone 'Asia/Tokyo')::date) end
   where id = any(p_ids) and kind <> 'legacy';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.hand_to_dealer(uuid[], timestamptz, text) from public;
revoke all on function public.unhand_purchase(uuid) from public;
revoke all on function public.cancel_dealer_payout(uuid) from public;
grant execute on function public.hand_to_dealer(uuid[], timestamptz, text) to authenticated;
grant execute on function public.unhand_purchase(uuid) to authenticated;
grant execute on function public.cancel_dealer_payout(uuid) to authenticated;

-- スタッフ名簿から人を削除する（本部だけ）
-- ・購入や先行予約の記録がある人は、記録の名前が分からなくならないよう「名簿から外す」（選択肢に出さない）だけにする
-- ・記録が何もない人は、名簿から完全に削除する
create or replace function public.remove_staff(p_id bigint)
returns text
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_name text;
begin
  perform public.require_hq();
  select name into v_name from public.staff where id = p_id;
  if v_name is null then raise exception 'スタッフが見つかりません'; end if;
  if exists (select 1 from public.staff_purchases where staff_id = p_id)
     or exists (select 1 from public.presale_orders where staff_id = p_id or stylist_id = p_id)
     or exists (select 1 from public.presale_reservations where staff_id = p_id or stylist_id = p_id) then
    update public.staff set is_active = false where id = p_id;
    return 'hidden';
  end if;
  delete from public.presale_staff_goals where staff_id = p_id;
  delete from public.staff where id = p_id;
  return 'deleted';
end;
$$;
revoke all on function public.remove_staff(bigint) from public;
grant execute on function public.remove_staff(bigint) to authenticated;

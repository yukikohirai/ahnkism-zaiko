-- カテゴリ削除：入っている商品を別カテゴリへ移してから削除する（1回の処理で行う）
create or replace function public.delete_category(p_category_id bigint, p_move_to bigint default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_count integer;
begin
  if not exists (select 1 from public.user_profiles p where p.user_id = auth.uid() and p.role = 'hq') then
    raise exception '本部だけがカテゴリを削除できます';
  end if;
  if not exists (select 1 from public.categories where id = p_category_id) then
    raise exception 'カテゴリが見つかりません';
  end if;
  select count(*) into v_count from public.products where category_id = p_category_id;
  if v_count > 0 then
    if p_move_to is null or p_move_to = p_category_id then
      raise exception '商品の移動先カテゴリを選んでください';
    end if;
    if not exists (select 1 from public.categories where id = p_move_to) then
      raise exception '移動先のカテゴリが見つかりません';
    end if;
    update public.products set category_id = p_move_to where category_id = p_category_id;
  end if;
  delete from public.categories where id = p_category_id;
end;
$$;
revoke all on function public.delete_category(bigint, bigint) from public;
grant execute on function public.delete_category(bigint, bigint) to authenticated;

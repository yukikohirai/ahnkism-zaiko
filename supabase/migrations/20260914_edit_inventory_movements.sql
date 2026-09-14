-- 本部が入出庫履歴を修正・取り消しできるようにする（元の値は inventory_movement_edits に残す）

create table if not exists public.inventory_movement_edits (
  id bigint generated always as identity primary key,
  movement_id uuid not null,
  action text not null check (action in ('update', 'delete')),
  old_row jsonb not null,
  new_row jsonb,
  edited_by uuid,
  edited_at timestamptz not null default now()
);
alter table public.inventory_movement_edits enable row level security;
drop policy if exists inventory_movement_edits_hq_read on public.inventory_movement_edits;
create policy inventory_movement_edits_hq_read on public.inventory_movement_edits
for select using (exists (select 1 from public.user_profiles p where p.user_id = auth.uid() and p.role = 'hq'));

create or replace function public.update_inventory_movement(
  p_id uuid,
  p_occurred_on date,
  p_store_id bigint,
  p_movement_type text,
  p_quantity integer,
  p_to_store_id bigint default null
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_old public.inventory_movements;
  v_pair public.inventory_movements;
  v_out_id uuid;
  v_in_id uuid;
  v_transfer_id text;
  v_signed integer;
begin
  if not exists (select 1 from public.user_profiles p where p.user_id = auth.uid() and p.role = 'hq') then
    raise exception '本部だけが履歴を修正できます';
  end if;

  select * into v_old from public.inventory_movements where id = p_id for update;
  if not found then
    raise exception '履歴が見つかりません';
  end if;

  -- 店舗間移動は出と入をセットで直す
  if v_old.movement_type in ('transfer_in', 'transfer_out') then
    if v_old.note is null then
      raise exception '店舗間移動の対応情報がないため修正できません';
    end if;
    if p_quantity <= 0 then
      raise exception '数量は1以上で入力してください';
    end if;
    if p_to_store_id is null or p_store_id = p_to_store_id then
      raise exception '移動元と移動先は別の店舗を選んでください';
    end if;
    select * into v_pair from public.inventory_movements
    where id <> v_old.id and note = v_old.note and movement_type in ('transfer_in', 'transfer_out')
    for update;
    if not found then
      raise exception '対になる移動履歴が見つかりません';
    end if;
    if not exists (select 1 from public.store_products where store_id = p_store_id and product_id = v_old.product_id and is_active)
       or not exists (select 1 from public.store_products where store_id = p_to_store_id and product_id = v_old.product_id and is_active) then
      raise exception '両店舗で取扱中の商品だけ移動できます';
    end if;

    v_out_id := case when v_old.movement_type = 'transfer_out' then v_old.id else v_pair.id end;
    v_in_id := case when v_old.movement_type = 'transfer_in' then v_old.id else v_pair.id end;

    insert into public.inventory_movement_edits (movement_id, action, old_row, new_row, edited_by)
    select m.id, 'update', to_jsonb(m), null, auth.uid() from public.inventory_movements m where m.id in (v_out_id, v_in_id);

    update public.inventory_movements set store_id = p_store_id, occurred_on = p_occurred_on, quantity = -p_quantity where id = v_out_id;
    update public.inventory_movements set store_id = p_to_store_id, occurred_on = p_occurred_on, quantity = p_quantity where id = v_in_id;

    v_transfer_id := substring(v_old.note from '店舗間移動 ([0-9a-f-]{36})');
    if v_transfer_id is not null then
      update public.stock_transfers
      set occurred_on = p_occurred_on, from_store_id = p_store_id, to_store_id = p_to_store_id, quantity = p_quantity
      where id = v_transfer_id::uuid;
    end if;

    update public.inventory_movement_edits e set new_row = to_jsonb(m)
    from public.inventory_movements m
    where m.id = e.movement_id and e.new_row is null and e.movement_id in (v_out_id, v_in_id);
    return;
  end if;

  if p_movement_type not in ('purchase_order', 'usage', 'retail_sale', 'personal_sale', 'adjustment') then
    raise exception '種類が正しくありません';
  end if;
  if p_movement_type = 'adjustment' then
    if p_quantity = 0 then
      raise exception '誤差調整の数量は0以外で入力してください';
    end if;
    v_signed := p_quantity;
  else
    if p_quantity <= 0 then
      raise exception '数量は1以上で入力してください';
    end if;
    v_signed := case when p_movement_type = 'purchase_order' then p_quantity else -p_quantity end;
  end if;
  if not exists (select 1 from public.store_products where store_id = p_store_id and product_id = v_old.product_id and is_active) then
    raise exception 'その店舗では取り扱っていない商品です';
  end if;

  insert into public.inventory_movement_edits (movement_id, action, old_row, new_row, edited_by)
  values (v_old.id, 'update', to_jsonb(v_old), null, auth.uid());

  update public.inventory_movements
  set store_id = p_store_id, occurred_on = p_occurred_on, movement_type = p_movement_type, quantity = v_signed
  where id = p_id;

  update public.inventory_movement_edits e set new_row = to_jsonb(m)
  from public.inventory_movements m
  where m.id = e.movement_id and e.new_row is null and e.movement_id = p_id;
end;
$$;

create or replace function public.delete_inventory_movement(p_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_old public.inventory_movements;
  v_transfer_id text;
begin
  if not exists (select 1 from public.user_profiles p where p.user_id = auth.uid() and p.role = 'hq') then
    raise exception '本部だけが履歴を取り消せます';
  end if;

  select * into v_old from public.inventory_movements where id = p_id for update;
  if not found then
    raise exception '履歴が見つかりません';
  end if;

  if v_old.movement_type in ('transfer_in', 'transfer_out') then
    if v_old.note is null then
      raise exception '店舗間移動の対応情報がないため修正できません';
    end if;
    insert into public.inventory_movement_edits (movement_id, action, old_row, edited_by)
    select m.id, 'delete', to_jsonb(m), auth.uid() from public.inventory_movements m
    where m.note = v_old.note and m.movement_type in ('transfer_in', 'transfer_out');
    delete from public.inventory_movements
    where note = v_old.note and movement_type in ('transfer_in', 'transfer_out');
    v_transfer_id := substring(v_old.note from '店舗間移動 ([0-9a-f-]{36})');
    if v_transfer_id is not null then
      delete from public.stock_transfers where id = v_transfer_id::uuid;
    end if;
    return;
  end if;

  insert into public.inventory_movement_edits (movement_id, action, old_row, edited_by)
  values (v_old.id, 'delete', to_jsonb(v_old), auth.uid());
  delete from public.inventory_movements where id = p_id;
end;
$$;

revoke all on function public.update_inventory_movement(uuid, date, bigint, text, integer, bigint) from public;
revoke all on function public.delete_inventory_movement(uuid) from public;
grant execute on function public.update_inventory_movement(uuid, date, bigint, text, integer, bigint) to authenticated;
grant execute on function public.delete_inventory_movement(uuid) to authenticated;

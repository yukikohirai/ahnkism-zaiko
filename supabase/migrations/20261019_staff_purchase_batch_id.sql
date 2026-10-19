-- スタッフ購入：まとめて登録した商品に同じ batch_id を付け、一覧で1つの塊（名前1回・商品を縦に・合計）として出す
alter table public.staff_purchases add column if not exists batch_id uuid;
create index if not exists staff_purchases_batch_idx on public.staff_purchases (batch_id);

-- これまでにまとめて登録した分（同じスタッフ・同じ日付・同じ登録時刻）にも batch_id を付ける
with groups as (
  select staff_id, purchased_on, created_at, gen_random_uuid() as batch
  from public.staff_purchases
  where kind <> 'legacy' and batch_id is null
  group by staff_id, purchased_on, created_at
  having count(*) > 1
)
update public.staff_purchases sp set batch_id = g.batch
  from groups g
 where sp.kind <> 'legacy' and sp.batch_id is null
   and sp.staff_id = g.staff_id and sp.purchased_on = g.purchased_on and sp.created_at = g.created_at;

create or replace function public.add_staff_purchase_batch(
  p_purchased_on date, p_staff_id bigint, p_store_id bigint, p_kind text, p_collected boolean,
  p_note text, p_dealer text, p_deduct_stock boolean, p_lines jsonb
)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_line jsonb;
  v_count integer := 0;
  v_id uuid;
  v_batch uuid := case when jsonb_array_length(coalesce(p_lines, '[]'::jsonb)) > 1 then gen_random_uuid() end;
begin
  perform public.require_hq();
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception '商品を1つ以上入れてください';
  end if;
  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_count := v_count + 1;
    begin
      v_id := public.add_staff_purchase(
        p_purchased_on, p_staff_id, p_store_id, nullif(v_line->>'product_id', '')::bigint,
        (v_line->>'quantity')::integer, (v_line->>'unit_price')::integer, p_kind, p_collected, p_note,
        v_line->>'item_name', p_dealer, v_line->>'item_detail', p_deduct_stock
      );
      if v_batch is not null then
        update public.staff_purchases set batch_id = v_batch where id = v_id;
      end if;
    exception when others then
      raise exception '%つ目の商品：%', v_count, sqlerrm;
    end;
  end loop;
  return v_count;
end;
$$;

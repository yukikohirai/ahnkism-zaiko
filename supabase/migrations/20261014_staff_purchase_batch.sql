-- スタッフ購入：複数の商品をまとめて登録する（全部登録するか、1つも登録しないか）
-- 日付・スタッフ・店舗・在庫から引くか・集金先・ディーラー・集金・メモは全行共通。行ごとに商品・中身・数・単価
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
begin
  perform public.require_hq();
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception '商品を1つ以上入れてください';
  end if;
  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_count := v_count + 1;
    begin
      perform public.add_staff_purchase(
        p_purchased_on, p_staff_id, p_store_id, nullif(v_line->>'product_id', '')::bigint,
        (v_line->>'quantity')::integer, (v_line->>'unit_price')::integer, p_kind, p_collected, p_note,
        v_line->>'item_name', p_dealer, v_line->>'item_detail', p_deduct_stock
      );
    exception when others then
      raise exception '%つ目の商品：%', v_count, sqlerrm;
    end;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.add_staff_purchase_batch(date, bigint, bigint, text, boolean, text, text, boolean, jsonb) from public;
grant execute on function public.add_staff_purchase_batch(date, bigint, bigint, text, boolean, text, text, boolean, jsonb) to authenticated;

-- 店舗の使用報告を1日に何度でも送れるようにする

-- 1店舗1日1回の完了制約を外す
drop index if exists public.inventory_sessions_one_completed_per_store_date;

-- 同じ日に複数回送った場合、usage_logs は上書きではなく加算する
do $$
declare
  v_def text := pg_get_functiondef('public.complete_inventory_session'::regproc);
begin
  if (length(v_def) - length(replace(v_def, 'do update set quantity = excluded.quantity', ''))) / length('do update set quantity = excluded.quantity') <> 1 then
    raise exception 'complete_inventory_session の置換対象が1箇所ではありません';
  end if;
  execute replace(v_def, 'do update set quantity = excluded.quantity', 'do update set quantity = usage_logs.quantity + excluded.quantity');
end $$;

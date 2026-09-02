-- 本部アカウントがカテゴリを追加できるようにする（商品管理画面の「＋ 新しく作る」用）
create policy categories_hq_write on public.categories
for all
using (exists (select 1 from public.user_profiles p where p.user_id = auth.uid() and p.role = 'hq'))
with check (exists (select 1 from public.user_profiles p where p.user_id = auth.uid() and p.role = 'hq'));

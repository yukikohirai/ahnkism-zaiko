'use client'

import Link from 'next/link'
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getCurrentProfile } from '@/lib/auth'
import { supabase } from '@/lib/supabase'
import { fetchAll } from '@/lib/fetchAll'
import { withoutTax, yen } from '@/lib/tax'
import ReservationPanel from '@/components/presale/ReservationPanel'
import {
  discountedPrice, regularPriceWithTax,
  type BulkTier, type DiscountType, type PresaleCampaign, type PresaleItem, type Staff, type StaffGoal,
} from '@/lib/presale'

type Store = { id: number; name: string }
type Category = { id: number; name: string; sort_order: number }
type RetailProduct = { id: number; category_id: number; brand: string | null; name: string; sale_price: number | null }
type Assignment = { store_id: number; product_id: number; sort_order: number }
type Tab = 'items' | 'reservations' | 'stock' | 'staff' | 'access'

const TABS: [Tab, string][] = [['items', '対象商品と割引'], ['reservations', '予約一覧'], ['stock', '集計・先行分の在庫'], ['staff', 'スタッフ名簿と目標'], ['access', '店舗の予約ページ']]

// 美容機器はまとめ買いの個数に数えない（初期値。木村さんが商品ごとに変えられる）
function looksLikeDevice(name: string) {
  return /^(ReFa|ドライヤー|パワーストレート)/.test(name)
}

function normalize(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, '')
}

export default function PresaleAdminPage() {
  const router = useRouter()
  const [authorized, setAuthorized] = useState(false)
  const [tab, setTab] = useState<Tab>('items')
  const [stores, setStores] = useState<Store[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [campaigns, setCampaigns] = useState<PresaleCampaign[]>([])
  const [campaignId, setCampaignId] = useState<number | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [form, setForm] = useState({ name: '', reception_start: '', reception_end: '', delivery_month: '', is_test: false })
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    void (async () => {
      const profile = await getCurrentProfile()
      if (!profile) { router.replace('/'); return }
      if (profile.role !== 'hq') { router.replace(`/${profile.store_id}/input`); return }
      setAuthorized(true)
    })()
  }, [router])

  const loadCampaigns = useCallback(async () => {
    const [storeResult, categoryResult, campaignResult] = await Promise.all([
      supabase.from('stores').select('id, name').order('sort_order'),
      supabase.from('categories').select('id, name, sort_order').order('sort_order'),
      supabase.from('presale_campaigns').select('*').order('id', { ascending: false }),
    ])
    setStores((storeResult.data ?? []) as Store[])
    setCategories((categoryResult.data ?? []) as Category[])
    const list = (campaignResult.data ?? []) as PresaleCampaign[]
    setCampaigns(list)
    setCampaignId((current) => current ?? list.find((item) => item.is_active)?.id ?? list[0]?.id ?? null)
  }, [])

  useEffect(() => { if (authorized) void loadCampaigns() }, [authorized, loadCampaigns])

  const campaign = campaigns.find((item) => item.id === campaignId)

  async function createCampaign() {
    if (!form.name.trim()) { setError('企画名を入力してください（例：2026年 冬）。'); return }
    setError('')
    const { data, error: insertError } = await supabase.from('presale_campaigns').insert({
      name: form.name.trim(),
      reception_start: form.reception_start || null,
      reception_end: form.reception_end || null,
      delivery_month: form.delivery_month.trim() || null,
      is_active: true,
      is_test: form.is_test,
    }).select('id').single()
    if (insertError || !data) { setError(insertError?.message ?? '作成できませんでした。'); return }
    setShowNew(false)
    setForm({ name: '', reception_start: '', reception_end: '', delivery_month: '', is_test: false })
    setCampaignId(data.id)
    setMessage('企画を作成しました。次に「対象商品と割引」で商品を選んでください。')
    await loadCampaigns()
  }

  async function updateCampaign(patch: Partial<PresaleCampaign>) {
    if (!campaign) return
    const { error: updateError } = await supabase.from('presale_campaigns').update(patch).eq('id', campaign.id)
    if (updateError) { setError(updateError.message); return }
    await loadCampaigns()
  }

  if (!authorized) return <div className="flex min-h-[100dvh] items-center justify-center text-gray-400">権限を確認しています...</div>

  return (
    <main className="min-h-[100dvh] bg-gray-50 pb-16">
      <header className="sticky top-0 z-30 border-b bg-white px-4 py-3 shadow-sm">
        <div className="mx-auto flex max-w-6xl items-center justify-between">
          <div><h1 className="font-bold text-gray-800">先行予約</h1><p className="text-xs text-gray-400">年2回の割引店販（予約・お渡し・先行分の在庫）</p></div>
          <Link href="/admin" className="rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-600">管理へ戻る</Link>
        </div>
      </header>

      <div className="mx-auto max-w-6xl space-y-3 p-4">
        <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-center gap-2">
            <select value={campaignId ?? ''} onChange={(event) => setCampaignId(Number(event.target.value))}
              className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-base font-bold">
              {campaigns.length === 0 && <option value="">企画がありません</option>}
              {campaigns.map((item) => <option key={item.id} value={item.id}>{item.name}{item.is_test ? '【お試し】' : ''}{item.is_active ? '（受付中）' : '（終了）'}</option>)}
            </select>
            <button onClick={() => setShowNew((value) => !value)} className="rounded-xl bg-pink-50 px-3 py-2 text-sm font-bold text-pink-700">{showNew ? '閉じる' : '＋ 新しい企画'}</button>
            {campaign && (
              <button onClick={() => { if (confirm(campaign.is_active ? '受付を終了します。店舗の予約ページからこの企画が消えます。よろしいですか？' : 'この企画を再開します。店舗の予約ページに出ます。よろしいですか？')) void updateCampaign({ is_active: !campaign.is_active }) }}
                className={`ml-auto rounded-xl px-3 py-2 text-sm font-bold ${campaign.is_active ? 'bg-gray-100 text-gray-600' : 'bg-green-50 text-green-700'}`}>
                {campaign.is_active ? '受付を終了する' : '再開する'}
              </button>
            )}
          </div>
          {showNew && (
            <div className="mt-3 grid gap-2 rounded-xl bg-pink-50/50 p-3 sm:grid-cols-4">
              <label className="block text-xs text-gray-500">企画名（必須）<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例：2026年 冬" className="mt-1 block w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-base" /></label>
              <label className="block text-xs text-gray-500">受付開始<input type="date" value={form.reception_start} onChange={(event) => setForm({ ...form, reception_start: event.target.value })} className="mt-1 block w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-base" /></label>
              <label className="block text-xs text-gray-500">受付終了<input type="date" value={form.reception_end} onChange={(event) => setForm({ ...form, reception_end: event.target.value })} className="mt-1 block w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-base" /></label>
              <label className="block text-xs text-gray-500">お渡し月<input value={form.delivery_month} onChange={(event) => setForm({ ...form, delivery_month: event.target.value })} placeholder="例：12月" className="mt-1 block w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-base" /></label>
              <label className="flex items-center gap-2 text-xs text-gray-600 sm:col-span-4">
                <input type="checkbox" checked={form.is_test} onChange={(event) => setForm({ ...form, is_test: event.target.checked })} className="h-4 w-4" />
                お試しの企画（お渡し済みにしても在庫を減らさず、先行分も発注リストに反映しない）
              </label>
              <button onClick={() => void createCampaign()} className="rounded-lg bg-pink-500 py-2 text-sm font-bold text-white sm:col-span-4">企画を作る</button>
            </div>
          )}
          {campaign?.is_test && (
            <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs font-bold text-amber-800">お試しの企画です。お渡し済みにしても在庫は減らず、先行分も発注リストに反映しません。</p>
          )}
          {campaign && (
            <p className="mt-2 text-xs text-gray-500">
              受付 {campaign.reception_start ?? '未設定'} 〜 {campaign.reception_end ?? '未設定'}・お渡し {campaign.delivery_month ?? '未設定'}
              {campaign.is_active ? '・店舗の予約ページで受付中' : '・受付終了（店舗の予約ページには出ていません）'}
            </p>
          )}
          {message && <p className="mt-2 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">{message}</p>}
          {error && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
        </section>

        <div className="flex gap-1 overflow-x-auto">
          {TABS.map(([key, label]) => (
            <button key={key} onClick={() => setTab(key)}
              className={`shrink-0 rounded-full px-4 py-2 text-sm font-bold ${tab === key ? 'bg-slate-700 text-white' : 'border border-gray-200 bg-white text-gray-600'}`}>{label}</button>
          ))}
        </div>

        {tab === 'staff' && <StaffRoster stores={stores} campaign={campaign} />}
        {tab === 'access' && <StoreAccess stores={stores} />}
        {(tab === 'items' || tab === 'reservations' || tab === 'stock') && !campaign && <p className="rounded-2xl bg-white py-12 text-center text-sm text-gray-400">まず「＋ 新しい企画」で企画を作ってください</p>}
        {tab === 'items' && campaign && <ItemSettings key={campaign.id} campaign={campaign} categories={categories} stores={stores} />}
        {tab === 'reservations' && campaign && <ReservationPanel key={campaign.id} campaign={campaign} storeId={null} stores={stores} access={null} />}
        {tab === 'stock' && campaign && <StockSummary key={campaign.id} campaign={campaign} stores={stores} />}
      </div>
    </main>
  )
}

// 対象商品と割引。店販用の商品を入荷・店舗入力と同じ並びで出す
function ItemSettings({ campaign, categories, stores }: { campaign: PresaleCampaign; categories: Category[]; stores: Store[] }) {
  const [products, setProducts] = useState<RetailProduct[]>([])
  const [assignments, setAssignments] = useState<Assignment[]>([])
  const [items, setItems] = useState<Map<number, PresaleItem>>(new Map())
  const [reservedIds, setReservedIds] = useState<Set<number>>(new Set())
  const [tiers, setTiers] = useState<BulkTier[]>([])
  const [tierDraft, setTierDraft] = useState({ min_qty: '', percent: '' })
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [search, setSearch] = useState('')
  const [onlyTargets, setOnlyTargets] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    const [productResult, assignmentResult, itemResult, reservationResult] = await Promise.all([
      fetchAll((start, end) => supabase.from('products').select('id, category_id, brand, name, sale_price')
        .eq('is_active', true).eq('product_type', 'retail').order('id').range(start, end)),
      fetchAll((start, end) => supabase.from('store_products').select('store_id, product_id, sort_order')
        .eq('is_active', true).order('store_id').order('product_id').range(start, end)),
      supabase.from('presale_items').select('*').eq('campaign_id', campaign.id),
      supabase.from('presale_order_lines').select('product_id, presale_orders!inner(campaign_id, cancelled_at)')
        .eq('presale_orders.campaign_id', campaign.id).is('presale_orders.cancelled_at', null),
    ])
    const tierResult = await supabase.from('presale_bulk_tiers').select('*').eq('campaign_id', campaign.id).order('min_qty')
    setTiers((tierResult.data ?? []) as BulkTier[])
    if (productResult.error || assignmentResult.error || itemResult.error) setError('データを読み込めませんでした。')
    setProducts((productResult.data ?? []) as RetailProduct[])
    setAssignments((assignmentResult.data ?? []) as Assignment[])
    setItems(new Map(((itemResult.data ?? []) as PresaleItem[]).map((item) => [item.product_id, { ...item, discount_value: Number(item.discount_value) }])))
    setReservedIds(new Set((reservationResult.data ?? []).map((row) => row.product_id as number)))
  }, [campaign.id])

  useEffect(() => { void load() }, [load])

  const categoryOrder = useMemo(() => new Map(categories.map((category) => [category.id, category.sort_order])), [categories])
  const categoryName = useMemo(() => new Map(categories.map((category) => [category.id, category.name])), [categories])
  const order = useMemo(() => {
    const storeIndex = new Map(stores.map((store, index) => [store.id, index]))
    const map = new Map<number, [number, number]>()
    assignments.forEach((row) => {
      const rank = storeIndex.get(row.store_id) ?? 999
      const current = map.get(row.product_id)
      if (!current || rank < current[0]) map.set(row.product_id, [rank, row.sort_order])
    })
    return map
  }, [assignments, stores])

  const visible = useMemo(() => {
    const keyword = normalize(search)
    return products
      .filter((product) => !onlyTargets || items.has(product.id))
      .filter((product) => !keyword || normalize(`${product.brand ?? ''}${product.name}`).includes(keyword))
      .sort((a, b) => (categoryOrder.get(a.category_id) ?? 999) - (categoryOrder.get(b.category_id) ?? 999)
        || (order.get(a.id)?.[0] ?? 999) - (order.get(b.id)?.[0] ?? 999)
        || (order.get(a.id)?.[1] ?? 1e9) - (order.get(b.id)?.[1] ?? 1e9) || a.id - b.id)
  }, [categoryOrder, items, onlyTargets, order, products, search])

  async function toggleTarget(product: RetailProduct) {
    setBusy(`t_${product.id}`)
    setError('')
    if (items.has(product.id)) {
      if (reservedIds.has(product.id)) {
        setBusy('')
        setError(`「${product.name}」はすでに予約が入っているので対象から外せません。`)
        return
      }
      const { error: deleteError } = await supabase.from('presale_items').delete().eq('campaign_id', campaign.id).eq('product_id', product.id)
      if (deleteError) setError(deleteError.message)
    } else {
      const { error: insertError } = await supabase.from('presale_items').insert({ campaign_id: campaign.id, product_id: product.id, discount_type: 'percent', discount_value: 0, bulk_excluded: looksLikeDevice(product.name) })
      if (insertError) setError(insertError.message)
    }
    setBusy('')
    await load()
  }

  async function addTier() {
    const minQty = parseInt(tierDraft.min_qty, 10)
    const percent = Number(tierDraft.percent)
    if (!Number.isFinite(minQty) || minQty < 2) { setError('まとめ買いの個数は2以上で入れてください。'); return }
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) { setError('％は0〜100で入れてください。'); return }
    setError('')
    const { error: saveError } = await supabase.from('presale_bulk_tiers').upsert({ campaign_id: campaign.id, min_qty: minQty, percent }, { onConflict: 'campaign_id,min_qty' })
    if (saveError) { setError(saveError.message); return }
    setTierDraft({ min_qty: '', percent: '' })
    await load()
  }

  async function removeTier(minQty: number) {
    if (!confirm(`「${minQty}個以上」の段階を削除します。よろしいですか？（登録済みの予約の金額は、次に修正したときに計算し直されます）`)) return
    const { error: deleteError } = await supabase.from('presale_bulk_tiers').delete().eq('campaign_id', campaign.id).eq('min_qty', minQty)
    if (deleteError) { setError(deleteError.message); return }
    await load()
  }

  async function saveDiscount(product: RetailProduct, patch: Partial<Pick<PresaleItem, 'discount_type' | 'discount_value' | 'bulk_excluded'>>) {
    const item = items.get(product.id)
    if (!item) return
    setBusy(`d_${product.id}`)
    const { error: updateError } = await supabase.from('presale_items').update(patch).eq('campaign_id', campaign.id).eq('product_id', product.id)
    setBusy('')
    if (updateError) { setError(updateError.message); return }
    setItems((previous) => new Map(previous).set(product.id, { ...item, ...patch }))
  }

  // 販売価格は税込で入力し、税抜で保存（価格表と同じ値を使う）
  async function savePrice(product: RetailProduct) {
    const key = `p_${product.id}`
    const raw = drafts[key]
    if (raw === undefined) return
    const trimmed = raw.replace(/[,，¥円\s]/g, '')
    const value = trimmed === '' ? null : withoutTax(Number(trimmed))
    if (value !== null && (!Number.isFinite(value) || value < 0)) { setError('価格は0以上の数字で入力してください。'); return }
    setBusy(key)
    const { error: updateError } = await supabase.from('products').update({ sale_price: value }).eq('id', product.id)
    setBusy('')
    if (updateError) { setError(updateError.message); return }
    setProducts((previous) => previous.map((item) => item.id === product.id ? { ...item, sale_price: value } : item))
    setDrafts((previous) => { const next = { ...previous }; delete next[key]; return next })
  }

  function commitValue(product: RetailProduct) {
    const key = `v_${product.id}`
    const raw = drafts[key]
    if (raw === undefined) return
    const value = Number(raw.replace(/[,，¥円%％\s]/g, '') || 0)
    if (!Number.isFinite(value) || value < 0) { setError('割引は0以上の数字で入力してください。'); return }
    const item = items.get(product.id)
    if (item?.discount_type === 'percent' && value > 100) { setError('％オフは100以下で入力してください。'); return }
    setDrafts((previous) => { const next = { ...previous }; delete next[key]; return next })
    void saveDiscount(product, { discount_value: value })
  }

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="mb-4 rounded-xl border border-pink-100 bg-pink-50/40 p-3">
        <div className="mb-2 text-sm font-bold text-pink-800">まとめ買い割引（お客様1人の合計個数。美容機器は数えない）</div>
        <div className="mb-2 flex flex-wrap gap-2">
          {tiers.map((tier) => (
            <span key={tier.min_qty} className="flex items-center gap-1 rounded-full bg-white px-3 py-1 text-sm shadow-sm">
              {tier.min_qty}個以上 → <b className="text-pink-700">{Number(tier.percent)}%オフ</b>
              <button onClick={() => void removeTier(tier.min_qty)} className="ml-1 text-gray-400" aria-label="削除">×</button>
            </span>
          ))}
          {tiers.length === 0 && <span className="text-xs text-gray-500">まだ設定がありません</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <input inputMode="numeric" value={tierDraft.min_qty} onChange={(event) => setTierDraft({ ...tierDraft, min_qty: event.target.value })} placeholder="3"
            className="w-16 rounded-lg border border-gray-200 px-2 py-1.5 text-center text-base" />個以上で
          <input inputMode="decimal" value={tierDraft.percent} onChange={(event) => setTierDraft({ ...tierDraft, percent: event.target.value })} placeholder="20"
            className="w-16 rounded-lg border border-gray-200 px-2 py-1.5 text-center text-base" />%オフ
          <button onClick={() => void addTier()} className="rounded-lg bg-pink-500 px-3 py-1.5 font-bold text-white">追加・変更</button>
        </div>
        <p className="mt-2 text-[11px] text-gray-500">個数に届いた予約は、対象商品が全部この％に置き換わります（商品ごとの割引より優先）。同じ個数で入れ直すと％だけ変わります。</p>
      </div>
      <p className="mb-2 text-xs text-gray-500">対象にしたい商品にチェックして、割引を入れます。割引は<b>税込価格</b>に対して計算し、1円未満は四捨五入します。販売価格（税込）はここで入れた値が価格表にも反映されます。</p>
      <div className="mb-3 grid gap-2 sm:grid-cols-2">
        <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="商品名・ブランドで検索"
          className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-base outline-none focus:border-blue-400" />
        <label className="flex items-center gap-2 rounded-xl bg-gray-50 px-3 py-2 text-sm text-gray-600">
          <input type="checkbox" checked={onlyTargets} onChange={(event) => setOnlyTargets(event.target.checked)} className="h-4 w-4" />
          対象にした商品だけ表示（{items.size}件）
        </label>
      </div>
      {error && <p className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
      <div className="max-h-[65vh] overflow-auto rounded-xl border border-gray-100">
        <table className="w-full min-w-[860px] text-xs">
          <thead className="sticky top-0 z-10 bg-gray-50 text-gray-500">
            <tr>
              <th className="w-12 px-2 py-2 text-center">対象</th>
              <th className="px-3 py-2 text-left">商品</th>
              <th className="w-28 px-2 py-2 text-center">販売価格（税込）</th>
              <th className="w-44 px-2 py-2 text-center">割引</th>
              <th className="w-28 px-2 py-2 text-center">割引後（税込）</th>
              <th className="w-20 px-2 py-2 text-center">まとめ買い対象外</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((product, index) => {
              const item = items.get(product.id)
              const regular = regularPriceWithTax(product.sale_price)
              const after = item ? discountedPrice(regular, item.discount_type, item.discount_value) : null
              return (
                <Fragment key={product.id}>
                  {product.category_id !== visible[index - 1]?.category_id && (
                    <tr><td colSpan={6} className="sticky top-8 z-[5] bg-slate-100 px-3 py-1.5 text-xs font-bold text-slate-600">{categoryName.get(product.category_id)}</td></tr>
                  )}
                  <tr className={`border-t border-gray-100 ${item ? 'bg-pink-50/40' : ''}`}>
                    <td className="px-2 py-1.5 text-center">
                      <input type="checkbox" checked={!!item} disabled={busy === `t_${product.id}`} onChange={() => void toggleTarget(product)} className="h-5 w-5 accent-pink-600" />
                    </td>
                    <td className="px-3 py-1.5">
                      <div className="text-[10px] text-gray-400">{product.brand}</div>
                      <div className="break-words font-medium text-gray-700">{product.name}</div>
                    </td>
                    <td className="px-2 py-1.5">
                      <input inputMode="numeric" placeholder="未入力" value={drafts[`p_${product.id}`] ?? (regular === null ? '' : String(regular))}
                        onChange={(event) => setDrafts((previous) => ({ ...previous, [`p_${product.id}`]: event.target.value }))}
                        onBlur={() => void savePrice(product)} onKeyDown={(event) => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur() }}
                        className={`w-full rounded-lg border px-2 py-1.5 text-right text-base ${regular === null ? 'border-amber-200 bg-amber-50/40' : 'border-gray-200'}`} />
                    </td>
                    <td className="px-2 py-1.5">
                      {item ? (
                        <div className="flex items-center gap-1">
                          <div className="flex shrink-0 rounded-lg bg-gray-100 p-0.5">
                            {(['percent', 'yen'] as DiscountType[]).map((type) => (
                              <button key={type} onClick={() => void saveDiscount(product, { discount_type: type })}
                                className={`rounded-md px-2 py-1 font-bold ${item.discount_type === type ? 'bg-white text-pink-700 shadow-sm' : 'text-gray-500'}`}>{type === 'percent' ? '%' : '円'}</button>
                            ))}
                          </div>
                          <input inputMode="decimal" value={drafts[`v_${product.id}`] ?? String(item.discount_value)}
                            onChange={(event) => setDrafts((previous) => ({ ...previous, [`v_${product.id}`]: event.target.value }))}
                            onBlur={() => commitValue(product)} onKeyDown={(event) => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur() }}
                            className="w-full min-w-0 rounded-lg border border-gray-200 px-2 py-1.5 text-right text-base" />
                          <span className="shrink-0 text-gray-500">{item.discount_type === 'percent' ? '%オフ' : '円引き'}</span>
                        </div>
                      ) : <span className="block text-center text-gray-300">−</span>}
                    </td>
                    <td className={`px-2 py-1.5 text-right text-sm font-bold ${item ? 'text-pink-700' : 'text-gray-300'}`}>{item ? yen(after) : '−'}</td>
                    <td className="px-2 py-1.5 text-center">
                      {item ? (
                        <input type="checkbox" checked={item.bulk_excluded} title="美容機器など、まとめ買いの個数に数えない商品"
                          onChange={(event) => void saveDiscount(product, { bulk_excluded: event.target.checked })} className="h-4 w-4" />
                      ) : <span className="text-gray-300">−</span>}
                    </td>
                  </tr>
                </Fragment>
              )
            })}
          </tbody>
        </table>
        {visible.length === 0 && <p className="py-8 text-center text-sm text-gray-400">該当する商品がありません</p>}
      </div>
    </section>
  )
}

// 集計と先行分の在庫。先行分の残り＝先行分として確保した数−お渡し済み、通常在庫＝今の在庫−先行分の残り
function StockSummary({ campaign, stores }: { campaign: PresaleCampaign; stores: Store[] }) {
  const [items, setItems] = useState<{ product_id: number; brand: string | null; name: string }[]>([])
  const [lines, setLines] = useState<{ store_id: number; product_id: number; quantity: number; delivered: boolean }[]>([])
  const [allocations, setAllocations] = useState<Map<string, number>>(new Map())
  const [stock, setStock] = useState<Map<string, number>>(new Map())
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    const [itemResult, lineResult, allocationResult, stockResult] = await Promise.all([
      supabase.from('presale_items').select('product_id, product:products!inner(brand, name)').eq('campaign_id', campaign.id),
      fetchAll((start, end) => supabase.from('presale_order_lines')
        .select('product_id, quantity, presale_orders!inner(store_id, campaign_id, cancelled_at, delivered_at)')
        .eq('presale_orders.campaign_id', campaign.id).is('presale_orders.cancelled_at', null).order('id').range(start, end)),
      supabase.from('presale_allocations').select('store_id, product_id, allocated_qty').eq('campaign_id', campaign.id),
      fetchAll((start, end) => supabase.from('current_store_stock').select('store_id, product_id, current_stock').order('store_id').order('product_id').range(start, end)),
    ])
    if (itemResult.error || lineResult.error || allocationResult.error || stockResult.error) setError('データを読み込めませんでした。')
    setItems((itemResult.data ?? []).map((row) => {
      const product = (Array.isArray(row.product) ? row.product[0] : row.product) as { brand: string | null; name: string }
      return { product_id: row.product_id as number, brand: product.brand, name: product.name }
    }).sort((a, b) => `${a.brand ?? ''}${a.name}`.localeCompare(`${b.brand ?? ''}${b.name}`, 'ja')))
    setLines((lineResult.data ?? []).map((row) => {
      const order = Array.isArray(row.presale_orders) ? row.presale_orders[0] : row.presale_orders
      return { store_id: order.store_id, product_id: row.product_id, quantity: row.quantity, delivered: !!order.delivered_at }
    }))
    setAllocations(new Map((allocationResult.data ?? []).map((row) => [`${row.store_id}_${row.product_id}`, row.allocated_qty as number])))
    setStock(new Map(((stockResult.data ?? []) as { store_id: number; product_id: number; current_stock: number }[]).map((row) => [`${row.store_id}_${row.product_id}`, row.current_stock])))
  }, [campaign.id])

  useEffect(() => { void load() }, [load])

  const reservedMap = useMemo(() => {
    const map = new Map<string, { reserved: number; delivered: number }>()
    lines.forEach((line) => {
      const key = `${line.store_id}_${line.product_id}`
      const current = map.get(key) ?? { reserved: 0, delivered: 0 }
      current.reserved += line.quantity
      if (line.delivered) current.delivered += line.quantity
      map.set(key, current)
    })
    return map
  }, [lines])

  async function saveAllocation(storeId: number, productId: number) {
    const key = `${storeId}_${productId}`
    const raw = drafts[key]
    if (raw === undefined) return
    const value = parseInt(raw || '0', 10)
    if (!Number.isFinite(value) || value < 0) { setError('先行分は0以上の数字で入力してください。'); return }
    setError('')
    const { error: saveError } = await supabase.from('presale_allocations')
      .upsert({ campaign_id: campaign.id, store_id: storeId, product_id: productId, allocated_qty: value }, { onConflict: 'campaign_id,store_id,product_id' })
    if (saveError) { setError(saveError.message); return }
    setAllocations((previous) => new Map(previous).set(key, value))
    setDrafts((previous) => { const next = { ...previous }; delete next[key]; return next })
  }

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <p className="mb-1 text-xs text-gray-500">入荷したあとで、各店舗の<b>「先行分」</b>に先行予約用として確保した数を入れてください。お渡し済みにすると先行分の残りと在庫が自動で減ります。</p>
      <p className="mb-3 text-[11px] text-gray-400">先行分の残り ＝ 先行分 − お渡し済み／通常在庫 ＝ 今の在庫 − 先行分の残り（発注リストもこの通常在庫で計算）。予約合計は発注数の目安です。</p>
      {error && <p className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
      <div className="max-h-[70vh] overflow-auto rounded-xl border border-gray-100">
        <table className="w-max min-w-full text-xs">
          <thead className="sticky top-0 z-10 bg-gray-50 text-gray-500">
            <tr>
              <th rowSpan={2} className="sticky left-0 z-20 w-[220px] min-w-[220px] border-b bg-gray-50 px-3 py-2 text-left">商品</th>
              <th rowSpan={2} className="border-b bg-pink-50 px-2 py-2 text-center text-pink-700">予約合計</th>
              {stores.map((store) => <th key={store.id} colSpan={5} className="border-b border-l border-gray-200 px-2 py-1.5 text-center text-sm font-bold text-gray-700">{store.name}</th>)}
            </tr>
            <tr>
              {stores.map((store) => (
                <Fragment key={store.id}>
                  <th className="border-b border-l border-gray-200 px-2 py-1 text-center">予約</th>
                  <th className="border-b px-2 py-1 text-center">渡済</th>
                  <th className="border-b bg-pink-50 px-2 py-1 text-center text-pink-700">先行分</th>
                  <th className="border-b px-2 py-1 text-center">先行分の残り</th>
                  <th className="border-b bg-blue-50 px-2 py-1 text-center text-blue-700">通常在庫</th>
                </Fragment>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const totalReserved = stores.reduce((sum, store) => sum + (reservedMap.get(`${store.id}_${item.product_id}`)?.reserved ?? 0), 0)
              return (
                <tr key={item.product_id} className="border-t border-gray-100">
                  <td className="sticky left-0 z-10 w-[220px] min-w-[220px] bg-white px-3 py-1.5">
                    <div className="text-[10px] text-gray-400">{item.brand}</div>
                    <div className="break-words font-medium text-gray-700">{item.name}</div>
                  </td>
                  <td className="bg-pink-50/50 px-2 py-1.5 text-center text-sm font-bold text-pink-700">{totalReserved || '−'}</td>
                  {stores.map((store) => {
                    const key = `${store.id}_${item.product_id}`
                    const reserved = reservedMap.get(key) ?? { reserved: 0, delivered: 0 }
                    const allocated = allocations.get(key) ?? 0
                    const remaining = allocated - reserved.delivered
                    const current = stock.get(key)
                    const normal = current === undefined ? null : current - Math.max(0, remaining)
                    return (
                      <Fragment key={store.id}>
                        <td className="border-l border-gray-200 px-2 py-1.5 text-center">{reserved.reserved || '−'}</td>
                        <td className="px-2 py-1.5 text-center text-green-700">{reserved.delivered || '−'}</td>
                        <td className="bg-pink-50/50 px-1 py-1">
                          <input inputMode="numeric" value={drafts[key] ?? (allocated ? String(allocated) : '')} placeholder="0"
                            onChange={(event) => setDrafts((previous) => ({ ...previous, [key]: event.target.value }))}
                            onBlur={() => void saveAllocation(store.id, item.product_id)} onKeyDown={(event) => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur() }}
                            className="w-14 rounded-lg border border-pink-200 bg-white px-1 py-1 text-center text-base" />
                        </td>
                        <td className={`px-2 py-1.5 text-center font-bold ${remaining < 0 ? 'text-red-600' : 'text-gray-700'}`}>{allocated || reserved.delivered ? remaining : '−'}</td>
                        <td className={`bg-blue-50/50 px-2 py-1.5 text-center font-bold ${normal !== null && normal < 0 ? 'text-red-600' : 'text-blue-700'}`}>{normal === null ? '取扱なし' : normal}</td>
                      </Fragment>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
        {items.length === 0 && <p className="py-8 text-center text-sm text-gray-400">まだ対象商品がありません。「対象商品と割引」で選んでください</p>}
      </div>
    </section>
  )
}

// スタッフ名簿と、企画ごとの目標金額（税込）
function StaffRoster({ stores, campaign }: { stores: Store[]; campaign: PresaleCampaign | undefined }) {
  const [staff, setStaff] = useState<Staff[]>([])
  const [goals, setGoals] = useState<Map<number, number>>(new Map())
  const [goalDrafts, setGoalDrafts] = useState<Record<number, string>>({})
  const [newNames, setNewNames] = useState<Record<number, string>>({})
  const [editing, setEditing] = useState<{ id: number; name: string } | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    const [staffResult, goalResult] = await Promise.all([
      supabase.from('staff').select('*').order('sort_order').order('id'),
      campaign ? supabase.from('presale_staff_goals').select('*').eq('campaign_id', campaign.id) : Promise.resolve({ data: [], error: null }),
    ])
    if (staffResult.error || goalResult.error) setError('名簿を読み込めませんでした。')
    setStaff((staffResult.data ?? []) as Staff[])
    setGoals(new Map(((goalResult.data ?? []) as StaffGoal[]).map((goal) => [goal.staff_id, goal.goal_amount])))
  }, [campaign])

  useEffect(() => { void load() }, [load])

  async function add(storeId: number) {
    const name = (newNames[storeId] ?? '').trim()
    if (!name) return
    if (staff.some((person) => person.store_id === storeId && normalize(person.name) === normalize(name))) { setError(`「${name}」はすでに登録されています。`); return }
    setError('')
    const nextSort = staff.filter((person) => person.store_id === storeId).reduce((max, person) => Math.max(max, person.sort_order), 0) + 1
    const { error: insertError } = await supabase.from('staff').insert({ store_id: storeId, name, sort_order: nextSort })
    if (insertError) { setError(insertError.message); return }
    setNewNames((previous) => ({ ...previous, [storeId]: '' }))
    await load()
  }

  async function update(id: number, patch: Partial<Staff>) {
    const { error: updateError } = await supabase.from('staff').update(patch).eq('id', id)
    if (updateError) { setError(updateError.message); return }
    setEditing(null)
    await load()
  }

  async function saveGoal(staffId: number) {
    if (!campaign) return
    const raw = goalDrafts[staffId]
    if (raw === undefined) return
    const value = parseInt(raw.replace(/[,，¥円\s]/g, '') || '0', 10)
    if (!Number.isFinite(value) || value < 0) { setError('目標は0以上の金額で入れてください。'); return }
    setError('')
    const { error: saveError } = await supabase.from('presale_staff_goals')
      .upsert({ campaign_id: campaign.id, staff_id: staffId, goal_amount: value }, { onConflict: 'campaign_id,staff_id' })
    if (saveError) { setError(saveError.message); return }
    setGoals((previous) => new Map(previous).set(staffId, value))
    setGoalDrafts((previous) => { const next = { ...previous }; delete next[staffId]; return next })
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-500">
        予約の「担当スタイリスト」「お勧めしたスタッフ」の選択肢です。辞めたスタッフは「外す」にすると選択肢から消えます（過去の予約の名前は残ります）。
        {campaign ? `目標金額（税込）は「${campaign.name}」の分です。` : '目標金額は企画を作ると入れられます。'}
      </p>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
      <div className="grid gap-3 md:grid-cols-3">
        {stores.map((store) => (
          <section key={store.id} className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
            <h3 className="mb-2 font-bold text-gray-800">{store.name}</h3>
            <div className="mb-2 flex gap-2">
              <input value={newNames[store.id] ?? ''} onChange={(event) => setNewNames((previous) => ({ ...previous, [store.id]: event.target.value }))}
                onKeyDown={(event) => { if (event.key === 'Enter') void add(store.id) }} placeholder="名前"
                className="min-w-0 flex-1 rounded-lg border border-gray-200 px-3 py-2 text-base" />
              <button onClick={() => void add(store.id)} className="shrink-0 rounded-lg bg-slate-700 px-3 py-2 text-sm font-bold text-white">追加</button>
            </div>
            <div className="divide-y divide-gray-100">
              {staff.filter((person) => person.store_id === store.id).map((person) => (
                <div key={person.id} className={`py-2 ${person.is_active ? '' : 'opacity-40'}`}>
                  <div className="flex items-center justify-between gap-2">
                    {editing?.id === person.id ? (
                      <>
                        <input value={editing.name} onChange={(event) => setEditing({ id: person.id, name: event.target.value })} autoFocus
                          className="min-w-0 flex-1 rounded-lg border border-gray-200 px-2 py-1.5 text-base" />
                        <button onClick={() => editing.name.trim() && void update(person.id, { name: editing.name.trim() })} className="rounded-lg bg-blue-500 px-2.5 py-1.5 text-xs font-bold text-white">保存</button>
                      </>
                    ) : (
                      <>
                        <span className="text-sm text-gray-800">{person.name}</span>
                        <div className="flex shrink-0 gap-1">
                          <button onClick={() => setEditing({ id: person.id, name: person.name })} className="rounded-lg bg-blue-50 px-2 py-1 text-xs text-blue-700">名前変更</button>
                          <button onClick={() => void update(person.id, { is_active: !person.is_active })} className="rounded-lg bg-gray-100 px-2 py-1 text-xs text-gray-600">{person.is_active ? '外す' : '戻す'}</button>
                        </div>
                      </>
                    )}
                  </div>
                  {campaign && person.is_active && (
                    <label className="mt-1 flex items-center gap-2 text-xs text-gray-500">
                      目標
                      <input inputMode="numeric" value={goalDrafts[person.id] ?? (goals.get(person.id) ? String(goals.get(person.id)) : '')} placeholder="未設定"
                        onChange={(event) => setGoalDrafts((previous) => ({ ...previous, [person.id]: event.target.value }))}
                        onBlur={() => void saveGoal(person.id)} onKeyDown={(event) => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur() }}
                        className="w-28 rounded-lg border border-pink-200 px-2 py-1 text-right text-base" />
                      円
                    </label>
                  )}
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}

// 店舗スタッフ用の予約ページ（URL＋暗証番号）
function StoreAccess({ stores }: { stores: Store[] }) {
  const [rows, setRows] = useState<{ store_id: number; url_token: string; pin_hash: string | null }[]>([])
  const [pins, setPins] = useState<Record<number, string>>({})
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const origin = typeof window === 'undefined' ? '' : window.location.origin

  const load = useCallback(async () => {
    const { data, error: loadError } = await supabase.from('presale_store_access').select('store_id, url_token, pin_hash')
    if (loadError) setError('読み込めませんでした。')
    setRows((data ?? []) as typeof rows)
  }, [])

  useEffect(() => { void load() }, [load])

  async function savePin(storeId: number) {
    const pin = (pins[storeId] ?? '').trim()
    setError('')
    setMessage('')
    const { error: pinError } = await supabase.rpc('set_presale_pin', { p_store_id: storeId, p_pin: pin })
    if (pinError) { setError(pinError.message); return }
    setPins((previous) => ({ ...previous, [storeId]: '' }))
    setMessage('暗証番号を設定しました。スタッフに伝えてください。')
    await load()
  }

  async function resetUrl(storeId: number) {
    if (!confirm('この店舗のページのURLを作り直します。今のURLは使えなくなり、新しいURLをスタッフに伝え直す必要があります。よろしいですか？')) return
    const { error: resetError } = await supabase.rpc('reset_presale_url', { p_store_id: storeId })
    if (resetError) { setError(resetError.message); return }
    setMessage('URLを作り直しました。')
    await load()
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setMessage('URLをコピーしました。')
    } catch {
      setError('コピーできませんでした。URLを長押し（右クリック）してコピーしてください。')
    }
  }

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <p className="mb-3 text-xs text-gray-500">
        スタッフはこのURLを開いて暗証番号を入れると、<b>その店舗の先行予約だけ</b>を操作できます（在庫の画面には入れません）。
        暗証番号は4〜8桁の数字。設定した番号はここには表示されないので、控えておいてください。
      </p>
      {message && <p className="mb-2 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">{message}</p>}
      {error && <p className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
      <div className="divide-y divide-gray-100">
        {stores.map((store) => {
          const row = rows.find((item) => item.store_id === store.id)
          const url = row ? `${origin}/yoyaku/${row.url_token}` : ''
          return (
            <div key={store.id} className="py-3">
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="font-bold text-gray-800">{store.name}</span>
                <span className={`text-xs ${row?.pin_hash ? 'text-green-700' : 'text-amber-600'}`}>{row?.pin_hash ? '暗証番号：設定済み' : '暗証番号：未設定（まだ入れません）'}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <code className="min-w-0 flex-1 break-all rounded-lg bg-gray-50 px-2 py-1.5 text-xs text-gray-700">{url}</code>
                <button onClick={() => void copy(url)} className="shrink-0 rounded-lg bg-blue-50 px-3 py-1.5 text-xs font-bold text-blue-700">コピー</button>
                <button onClick={() => void resetUrl(store.id)} className="shrink-0 rounded-lg bg-gray-100 px-3 py-1.5 text-xs text-gray-600">URLを作り直す</button>
              </div>
              <div className="mt-2 flex items-center gap-2 text-sm">
                <input type="password" inputMode="numeric" autoComplete="new-password" value={pins[store.id] ?? ''} placeholder="新しい暗証番号"
                  onChange={(event) => setPins((previous) => ({ ...previous, [store.id]: event.target.value }))}
                  className="w-40 rounded-lg border border-gray-200 px-3 py-1.5 text-base" />
                <button onClick={() => void savePin(store.id)} disabled={!(pins[store.id] ?? '').trim()} className="rounded-lg bg-pink-500 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-40">設定する</button>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

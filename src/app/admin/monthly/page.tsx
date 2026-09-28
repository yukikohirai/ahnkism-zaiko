'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getCurrentProfile } from '@/lib/auth'
import { supabase } from '@/lib/supabase'
import { fetchAll } from '@/lib/fetchAll'

type Store = { id: number; name: string }
type Category = { id: number; name: string; sort_order: number }
type Assignment = {
  store_id: number
  product_id: number
  opening_stock: number
  required_qty: number
  sort_order: number
  product: { id: number; category_id: number; brand: string | null; name: string }
}
type Movement = { store_id: number; product_id: number; occurred_on: string; quantity: number; movement_type: string }
type Totals = { start: number; incoming: number; usage: number; retail: number; personal: number; transfer: number; adjustment: number; end: number; required: number }

// 繰越（opening_stock）は2026年8月末の在庫なので、表は2026年9月から
const FIRST_YEAR = 2026
const FIRST_MONTH = 9
const ZERO: Totals = { start: 0, incoming: 0, usage: 0, retail: 0, personal: 0, transfer: 0, adjustment: 0, end: 0, required: 0 }

function monthRange(year: number, month: number) {
  const ym = `${year}-${String(month).padStart(2, '0')}`
  const last = new Date(year, month, 0).getDate()
  return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, '0')}` }
}

function normalizeSearch(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, '')
}

function add(a: Totals, b: Totals): Totals {
  return {
    start: a.start + b.start, incoming: a.incoming + b.incoming, usage: a.usage + b.usage, retail: a.retail + b.retail,
    personal: a.personal + b.personal, transfer: a.transfer + b.transfer, adjustment: a.adjustment + b.adjustment,
    end: a.end + b.end, required: a.required + b.required,
  }
}

export default function MonthlySummaryPage() {
  const router = useRouter()
  const now = new Date()
  const [authorized, setAuthorized] = useState(false)
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [stores, setStores] = useState<Store[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [assignments, setAssignments] = useState<Assignment[]>([])
  const [movements, setMovements] = useState<Movement[]>([])
  const [view, setView] = useState<string>('')
  const [categoryId, setCategoryId] = useState<number | 'all'>('all')
  const [search, setSearch] = useState('')
  const [onlyMoved, setOnlyMoved] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    void (async () => {
      const profile = await getCurrentProfile()
      if (!profile) { router.replace('/'); return }
      if (profile.role !== 'hq') { router.replace(`/${profile.store_id}/input`); return }
      setAuthorized(true)
    })()
  }, [router])

  const { from, to } = monthRange(year, month)

  const load = useCallback(async () => {
    if (!authorized) return
    setLoading(true)
    setError('')
    const [storeResult, categoryResult, assignmentResult, movementResult] = await Promise.all([
      supabase.from('stores').select('id, name').order('sort_order'),
      supabase.from('categories').select('id, name, sort_order').order('sort_order'),
      fetchAll((start, end) => supabase.from('store_products')
        .select('store_id, product_id, opening_stock, required_qty, sort_order, products!inner(id, category_id, brand, name)')
        .eq('is_active', true).eq('products.is_active', true)
        .order('store_id').order('product_id').range(start, end)),
      // 月初在庫の計算に、その月より前の入出庫も必要
      fetchAll((start, end) => supabase.from('inventory_movements')
        .select('store_id, product_id, occurred_on, quantity, movement_type')
        .lte('occurred_on', to).order('id').range(start, end)),
    ])
    if (storeResult.error || categoryResult.error || assignmentResult.error || movementResult.error) setError('データを読み込めませんでした。')
    const nextStores = (storeResult.data ?? []) as Store[]
    setStores(nextStores)
    setView((current) => current || String(nextStores[0]?.id ?? 'all'))
    setCategories((categoryResult.data ?? []) as Category[])
    setAssignments((assignmentResult.data ?? []).flatMap((row) => {
      const product = Array.isArray(row.products) ? row.products[0] : row.products
      return product ? [{ ...row, product } as Assignment] : []
    }))
    setMovements((movementResult.data ?? []) as Movement[])
    setLoading(false)
  }, [authorized, to])

  useEffect(() => { void load() }, [load])

  // 店舗×商品ごとの1か月の集計
  const totalsByKey = useMemo(() => {
    const map = new Map<string, Totals>()
    assignments.forEach((row) => map.set(`${row.store_id}_${row.product_id}`, { ...ZERO, start: row.opening_stock, required: row.required_qty }))
    movements.forEach((movement) => {
      const item = map.get(`${movement.store_id}_${movement.product_id}`)
      if (!item) return
      if (movement.occurred_on < from) { item.start += movement.quantity; return }
      const quantity = movement.quantity
      if (movement.movement_type === 'purchase_order') item.incoming += quantity
      else if (movement.movement_type === 'usage') item.usage += -quantity
      else if (movement.movement_type === 'retail_sale') item.retail += -quantity
      else if (movement.movement_type === 'personal_sale') item.personal += -quantity
      else if (movement.movement_type === 'transfer_in' || movement.movement_type === 'transfer_out') item.transfer += quantity
      else if (movement.movement_type === 'adjustment') item.adjustment += quantity
    })
    map.forEach((item) => {
      item.end = item.start + item.incoming - item.usage - item.retail - item.personal + item.transfer + item.adjustment
    })
    return map
  }, [assignments, from, movements])

  const sharedCategoryIds = useMemo(() => new Set(categories.filter((category) => category.name === '全店在庫').map((category) => category.id)), [categories])
  const categoryOrder = useMemo(() => new Map(categories.map((category) => [category.id, category.sort_order])), [categories])
  const categoryName = useMemo(() => new Map(categories.map((category) => [category.id, category.name])), [categories])

  const rows = useMemo(() => {
    const keyword = normalizeSearch(search)
    const isAll = view === 'all'
    const byProduct = new Map<number, { product: Assignment['product']; totals: Totals; sort: number }>()
    assignments.forEach((row) => {
      if (!isAll && (String(row.store_id) !== view || sharedCategoryIds.has(row.product.category_id))) return
      const totals = totalsByKey.get(`${row.store_id}_${row.product_id}`) ?? ZERO
      const current = byProduct.get(row.product_id)
      byProduct.set(row.product_id, current
        ? { ...current, totals: add(current.totals, totals), sort: Math.min(current.sort, row.sort_order) }
        : { product: row.product, totals, sort: row.sort_order })
    })
    return Array.from(byProduct.values())
      .filter((item) => categoryId === 'all' || item.product.category_id === categoryId)
      .filter((item) => !keyword || normalizeSearch(`${item.product.brand ?? ''}${item.product.name}`).includes(keyword))
      .filter((item) => !onlyMoved || item.totals.incoming || item.totals.usage || item.totals.retail || item.totals.personal || item.totals.transfer || item.totals.adjustment)
      .sort((a, b) => (categoryOrder.get(a.product.category_id) ?? 999) - (categoryOrder.get(b.product.category_id) ?? 999) || a.sort - b.sort)
  }, [assignments, categoryId, categoryOrder, onlyMoved, search, sharedCategoryIds, totalsByKey, view])

  const grandTotal = useMemo(() => rows.reduce((sum, item) => add(sum, item.totals), ZERO), [rows])

  function changeMonth(delta: number) {
    const next = new Date(year, month - 1 + delta, 1)
    if (next.getFullYear() * 12 + next.getMonth() < FIRST_YEAR * 12 + FIRST_MONTH - 1) return
    setYear(next.getFullYear())
    setMonth(next.getMonth() + 1)
  }
  const atFirstMonth = year * 12 + month <= FIRST_YEAR * 12 + FIRST_MONTH

  const cell = (value: number, color = 'text-gray-700', signed = false) => (
    <td className={`px-2 py-1.5 text-center ${value === 0 ? 'text-gray-300' : value < 0 ? 'text-red-600' : color}`}>
      {value === 0 ? '−' : signed && value > 0 ? `+${value}` : value}
    </td>
  )

  if (!authorized) return <div className="flex min-h-[100dvh] items-center justify-center text-gray-400">権限を確認しています...</div>

  const colSpan = 11

  return (
    <main className="min-h-[100dvh] bg-gray-50 pb-16">
      <header className="sticky top-0 z-30 border-b bg-white px-4 py-3 shadow-sm">
        <div className="mx-auto flex max-w-6xl items-center justify-between">
          <div><h1 className="font-bold text-gray-800">月別まとめ</h1><p className="text-xs text-gray-400">1か月の在庫の動き（月初在庫 → 月末在庫）</p></div>
          <Link href="/admin" className="rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-600">管理へ戻る</Link>
        </div>
      </header>

      <div className="mx-auto max-w-6xl space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-1">
            <button onClick={() => changeMonth(-1)} disabled={atFirstMonth} className="rounded border border-gray-200 bg-white px-3 py-1.5 disabled:opacity-30">‹</button>
            <span className="px-2 font-bold text-gray-800">{year}年{month}月</span>
            <button onClick={() => changeMonth(1)} className="rounded border border-gray-200 bg-white px-3 py-1.5">›</button>
          </div>
          <div className="flex gap-1 overflow-x-auto">
            {stores.map((store) => (
              <button key={store.id} onClick={() => setView(String(store.id))}
                className={`shrink-0 rounded-full px-4 py-2 text-sm font-bold ${view === String(store.id) ? 'bg-blue-500 text-white' : 'border border-gray-200 bg-white text-gray-600'}`}>{store.name}</button>
            ))}
            <button onClick={() => setView('all')}
              className={`shrink-0 rounded-full px-4 py-2 text-sm font-bold ${view === 'all' ? 'bg-blue-500 text-white' : 'border border-gray-200 bg-white text-gray-600'}`}>全店合計</button>
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-3">
          <select value={categoryId} onChange={(event) => setCategoryId(event.target.value === 'all' ? 'all' : Number(event.target.value))}
            className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-base">
            <option value="all">全カテゴリ</option>
            {categories.filter((category) => view === 'all' || !sharedCategoryIds.has(category.id)).map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
          </select>
          <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="商品名・ブランドで検索"
            className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-base outline-none focus:border-blue-400" />
          <label className="flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-600">
            <input type="checkbox" checked={onlyMoved} onChange={(event) => setOnlyMoved(event.target.checked)} className="h-4 w-4" />
            この月に動きがあった商品だけ
          </label>
        </div>
        <p className="text-[11px] text-gray-400">
          月末在庫 ＝ 月初在庫 ＋ 入荷 − 業務 − 店販 − 個人 ± 移動 ± 誤差。不足 ＝ 必要数 − 月末在庫。
          {view === 'all' ? '全店合計は3店舗を足した数です。' : '全店在庫の商品は「全店合計」タブに出ます。'}
        </p>
        {error && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

        {loading ? <p className="py-12 text-center text-sm text-gray-400">計算中...</p> : (
          <div className="max-h-[75vh] overflow-auto rounded-2xl border border-gray-200 bg-white shadow-sm">
            <table className="w-max min-w-full text-sm">
              <thead className="sticky top-0 z-20 bg-gray-50 text-xs text-gray-500">
                <tr>
                  <th className="sticky left-0 z-30 w-[260px] min-w-[260px] bg-gray-50 px-3 py-2 text-left">商品</th>
                  <th className="w-16 bg-yellow-50 px-2 py-2 text-center">月初在庫</th>
                  <th className="w-14 bg-emerald-50 px-2 py-2 text-center text-emerald-700">入荷</th>
                  <th className="w-14 bg-blue-50 px-2 py-2 text-center text-blue-700">業務</th>
                  <th className="w-14 bg-green-50 px-2 py-2 text-center text-green-700">店販</th>
                  <th className="w-14 bg-amber-50 px-2 py-2 text-center text-amber-700">個人</th>
                  <th className="w-14 bg-purple-50 px-2 py-2 text-center text-purple-700">移動</th>
                  <th className="w-14 bg-gray-100 px-2 py-2 text-center">誤差</th>
                  <th className="w-16 bg-yellow-50 px-2 py-2 text-center font-bold text-gray-700">月末在庫</th>
                  <th className="w-14 px-2 py-2 text-center">必要数</th>
                  <th className="w-14 px-2 py-2 text-center text-orange-600">不足</th>
                </tr>
              </thead>
              <tbody>
                {rows.flatMap((item, index) => {
                  const t = item.totals
                  const shortage = Math.max(0, t.required - t.end)
                  const isNewCategory = item.product.category_id !== rows[index - 1]?.product.category_id
                  const out: React.ReactNode[] = []
                  if (isNewCategory) {
                    out.push(
                      <tr key={`c_${item.product.category_id}`}>
                        <td colSpan={colSpan} className="sticky top-8 z-10 bg-slate-100 px-3 py-1.5 text-xs font-bold text-slate-600">{categoryName.get(item.product.category_id) ?? 'カテゴリ未設定'}</td>
                      </tr>
                    )
                  }
                  out.push(
                    <tr key={item.product.id} className="border-t border-gray-100">
                      <td className="sticky left-0 z-10 w-[260px] min-w-[260px] max-w-[260px] bg-white px-3 py-1.5">
                        <div className="text-[10px] text-gray-400">{item.product.brand}</div>
                        <div className="break-words font-medium leading-snug text-gray-800">{item.product.name}</div>
                      </td>
                      {cell(t.start)}
                      {cell(t.incoming, 'text-emerald-700')}
                      {cell(t.usage, 'text-blue-700')}
                      {cell(t.retail, 'text-green-700')}
                      {cell(t.personal, 'text-amber-700')}
                      {cell(t.transfer, 'text-purple-700', true)}
                      {cell(t.adjustment, 'text-gray-700', true)}
                      <td className={`bg-yellow-50/60 px-2 py-1.5 text-center font-bold ${t.end < 0 ? 'text-red-600' : 'text-gray-800'}`}>{t.end}</td>
                      {cell(t.required, 'text-gray-500')}
                      <td className={`px-2 py-1.5 text-center font-bold ${shortage > 0 ? 'text-orange-600' : 'text-gray-300'}`}>{shortage > 0 ? shortage : '−'}</td>
                    </tr>
                  )
                  return out
                })}
                {rows.length > 0 && (
                  <tr className="border-t-2 border-gray-300 bg-gray-50 font-bold">
                    <td className="sticky left-0 z-10 bg-gray-50 px-3 py-2 text-gray-800">合計（{rows.length}品目）</td>
                    <td className="px-2 py-2 text-center">{grandTotal.start}</td>
                    <td className="px-2 py-2 text-center text-emerald-700">{grandTotal.incoming}</td>
                    <td className="px-2 py-2 text-center text-blue-700">{grandTotal.usage}</td>
                    <td className="px-2 py-2 text-center text-green-700">{grandTotal.retail}</td>
                    <td className="px-2 py-2 text-center text-amber-700">{grandTotal.personal}</td>
                    <td className="px-2 py-2 text-center text-purple-700">{grandTotal.transfer}</td>
                    <td className="px-2 py-2 text-center">{grandTotal.adjustment}</td>
                    <td className="px-2 py-2 text-center">{grandTotal.end}</td>
                    <td className="px-2 py-2 text-center text-gray-500">{grandTotal.required}</td>
                    <td className="px-2 py-2 text-center" />
                  </tr>
                )}
              </tbody>
            </table>
            {rows.length === 0 && <p className="py-12 text-center text-sm text-gray-400">該当する商品がありません</p>}
          </div>
        )}
      </div>
    </main>
  )
}

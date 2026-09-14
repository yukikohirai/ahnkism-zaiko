'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getCurrentProfile } from '@/lib/auth'
import { supabase } from '@/lib/supabase'
import { fetchAll } from '@/lib/fetchAll'
import { withTax, withoutTax, yen } from '@/lib/tax'

type Store = { id: number; name: string }
type ReportProduct = {
  id: number
  name: string
  brand: string | null
  cost_price: number | null
  product_type: 'material' | 'retail'
  usage_only: boolean
}
type Movement = { store_id: number; product_id: number; quantity: number; movement_type: string }
type Sales = { store_id: number; treatment_sales: number | null; retail_sales: number | null }
type Breakdown = {
  purchase: number
  transfer: number
  usageOnly: number
  retailBusiness: number
  material: number
  retailCost: number
  personal: number
}

const EMPTY: Breakdown = { purchase: 0, transfer: 0, usageOnly: 0, retailBusiness: 0, material: 0, retailCost: 0, personal: 0 }

function monthRange(year: number, month: number) {
  const ym = `${year}-${String(month).padStart(2, '0')}`
  const last = new Date(year, month, 0).getDate()
  return { ym, from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, '0')}` }
}

function rate(numerator: number, denominator: number | null) {
  if (!denominator) return '−'
  return `${((numerator / denominator) * 100).toFixed(1)}%`
}

export default function ReportPage() {
  const router = useRouter()
  const now = new Date()
  const [authorized, setAuthorized] = useState(false)
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [taxIncluded, setTaxIncluded] = useState(false)
  const [stores, setStores] = useState<Store[]>([])
  const [products, setProducts] = useState<ReportProduct[]>([])
  const [movements, setMovements] = useState<Movement[]>([])
  const [sales, setSales] = useState<Sales[]>([])
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showMissing, setShowMissing] = useState(false)

  useEffect(() => {
    void (async () => {
      const profile = await getCurrentProfile()
      if (!profile) { router.replace('/'); return }
      if (profile.role !== 'hq') { router.replace(`/${profile.store_id}/input`); return }
      setAuthorized(true)
    })()
  }, [router])

  const { ym, from, to } = monthRange(year, month)

  const load = useCallback(async () => {
    if (!authorized) return
    setLoading(true)
    setError('')
    const [storeResult, productResult, movementResult, salesResult] = await Promise.all([
      supabase.from('stores').select('id, name').order('sort_order'),
      // 停止中の商品にも今月の履歴が残っていることがあるので全件取る
      fetchAll((start, end) => supabase.from('products').select('id, name, brand, cost_price, product_type, usage_only')
        .order('id').range(start, end)),
      fetchAll((start, end) => supabase.from('inventory_movements').select('store_id, product_id, quantity, movement_type')
        .gte('occurred_on', from).lte('occurred_on', to).order('id').range(start, end)),
      supabase.from('monthly_sales').select('store_id, treatment_sales, retail_sales').eq('year_month', ym),
    ])
    if (storeResult.error || productResult.error || movementResult.error || salesResult.error) {
      setError('データを読み込めませんでした。')
    }
    setStores((storeResult.data ?? []) as Store[])
    setProducts((productResult.data ?? []) as ReportProduct[])
    setMovements((movementResult.data ?? []) as Movement[])
    setSales((salesResult.data ?? []) as Sales[])
    setDrafts({})
    setLoading(false)
  }, [authorized, from, to, ym])

  useEffect(() => { void load() }, [load])

  const productMap = useMemo(() => new Map(products.map((product) => [product.id, product])), [products])

  // 材料費：業務用は入荷（＋店舗間移動の付け替え）、発注しない商品と店販用は使った分
  const { byStore, missing } = useMemo(() => {
    const result = new Map<number, Breakdown>()
    const missingIds = new Set<number>()
    movements.forEach((movement) => {
      const product = productMap.get(movement.product_id)
      if (!product) return
      const counted = product.usage_only
        ? movement.movement_type === 'usage'
        : product.product_type === 'retail'
          ? ['usage', 'retail_sale', 'personal_sale'].includes(movement.movement_type)
          : ['purchase_order', 'transfer_in', 'transfer_out', 'personal_sale'].includes(movement.movement_type)
      if (!counted) return
      if (product.cost_price === null) {
        missingIds.add(product.id)
        return
      }
      const cost = product.cost_price
      const row = { ...(result.get(movement.store_id) ?? EMPTY) }
      if (product.usage_only) {
        row.usageOnly += -movement.quantity * cost
      } else if (product.product_type === 'retail') {
        if (movement.movement_type === 'usage') row.retailBusiness += -movement.quantity * cost
        if (movement.movement_type === 'retail_sale') row.retailCost += -movement.quantity * cost
        if (movement.movement_type === 'personal_sale') row.personal += -movement.quantity * cost
      } else {
        if (movement.movement_type === 'purchase_order') row.purchase += movement.quantity * cost
        if (movement.movement_type === 'transfer_in' || movement.movement_type === 'transfer_out') row.transfer += movement.quantity * cost
        if (movement.movement_type === 'personal_sale') row.personal += -movement.quantity * cost
      }
      row.material = row.purchase + row.transfer + row.usageOnly + row.retailBusiness
      result.set(movement.store_id, row)
    })
    return { byStore: result, missing: Array.from(missingIds).map((id) => productMap.get(id)!).filter(Boolean) }
  }, [movements, productMap])

  const salesMap = useMemo(() => new Map(sales.map((row) => [row.store_id, row])), [sales])
  const total = useMemo(() => {
    const sum = { ...EMPTY, treatment: 0, retail: 0, hasTreatment: false, hasRetail: false }
    stores.forEach((store) => {
      const row = byStore.get(store.id) ?? EMPTY
      ;(Object.keys(EMPTY) as (keyof Breakdown)[]).forEach((key) => { sum[key] += row[key] })
      const storeSales = salesMap.get(store.id)
      if (storeSales?.treatment_sales != null) { sum.treatment += storeSales.treatment_sales; sum.hasTreatment = true }
      if (storeSales?.retail_sales != null) { sum.retail += storeSales.retail_sales; sum.hasRetail = true }
    })
    return sum
  }, [byStore, salesMap, stores])

  const money = (amount: number) => yen(taxIncluded ? withTax(amount) : amount)

  async function saveSales(storeId: number, field: 'treatment_sales' | 'retail_sales') {
    const key = `${storeId}_${field}`
    const raw = drafts[key]
    if (raw === undefined) return
    const trimmed = raw.replace(/[,，¥円\s]/g, '')
    let value: number | null = null
    if (trimmed !== '') {
      const parsed = Number(trimmed)
      if (!Number.isFinite(parsed) || parsed < 0) { setError('売上は0以上の数字で入力してください。'); return }
      value = taxIncluded ? withoutTax(parsed) : Math.round(parsed)
    }
    const current = salesMap.get(storeId)
    const { error: saveError } = await supabase.from('monthly_sales').upsert({
      store_id: storeId,
      year_month: ym,
      treatment_sales: field === 'treatment_sales' ? value : current?.treatment_sales ?? null,
      retail_sales: field === 'retail_sales' ? value : current?.retail_sales ?? null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'store_id,year_month' })
    if (saveError) { setError(`保存できませんでした：${saveError.message}`); return }
    setSales((previous) => {
      const others = previous.filter((row) => row.store_id !== storeId)
      return [...others, {
        store_id: storeId,
        treatment_sales: field === 'treatment_sales' ? value : current?.treatment_sales ?? null,
        retail_sales: field === 'retail_sales' ? value : current?.retail_sales ?? null,
      }]
    })
    setDrafts((previous) => { const next = { ...previous }; delete next[key]; return next })
  }

  function salesInput(storeId: number, field: 'treatment_sales' | 'retail_sales') {
    const key = `${storeId}_${field}`
    const stored = salesMap.get(storeId)?.[field] ?? null
    const shown = stored === null ? '' : String(taxIncluded ? withTax(stored) : stored)
    return (
      <input inputMode="numeric" value={drafts[key] ?? shown} placeholder="未入力"
        onChange={(event) => setDrafts((previous) => ({ ...previous, [key]: event.target.value }))}
        onBlur={() => void saveSales(storeId, field)}
        onKeyDown={(event) => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur() }}
        className={`w-28 rounded-lg border px-2 py-1.5 text-right text-base outline-none focus:border-blue-400 ${stored === null ? 'border-amber-200 bg-amber-50/40' : 'border-gray-200 bg-white'}`} />
    )
  }

  function changeMonth(delta: number) {
    const next = new Date(year, month - 1 + delta, 1)
    setYear(next.getFullYear())
    setMonth(next.getMonth() + 1)
  }

  if (!authorized) return <div className="flex min-h-[100dvh] items-center justify-center text-gray-400">権限を確認しています...</div>

  return (
    <main className="min-h-[100dvh] bg-gray-50 pb-16">
      <header className="sticky top-0 z-20 border-b bg-white px-4 py-3 shadow-sm">
        <div className="mx-auto flex max-w-5xl items-center justify-between">
          <div><h1 className="font-bold text-gray-800">月次レポート</h1><p className="text-xs text-gray-400">材料費率・店販原価率</p></div>
          <Link href="/admin" className="rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-600">管理へ戻る</Link>
        </div>
      </header>

      <div className="mx-auto max-w-5xl space-y-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-1">
            <button onClick={() => changeMonth(-1)} className="rounded border border-gray-200 bg-white px-3 py-1.5">‹</button>
            <span className="px-2 font-bold text-gray-800">{year}年{month}月</span>
            <button onClick={() => changeMonth(1)} className="rounded border border-gray-200 bg-white px-3 py-1.5">›</button>
          </div>
          <div className="flex rounded-lg bg-gray-100 p-0.5 text-sm font-medium">
            <button onClick={() => { setTaxIncluded(false); setDrafts({}) }} className={`rounded-md px-4 py-1.5 ${!taxIncluded ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500'}`}>税抜</button>
            <button onClick={() => { setTaxIncluded(true); setDrafts({}) }} className={`rounded-md px-4 py-1.5 ${taxIncluded ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500'}`}>税込</button>
          </div>
        </div>

        {error && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
        {missing.length > 0 && (
          <div className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">
            今月の計算に使う商品のうち <b>{missing.length}件</b> は仕入れ値が未入力のため、0円として計算しています。
            <button onClick={() => setShowMissing((value) => !value)} className="ml-2 text-xs font-bold underline">{showMissing ? '閉じる' : '一覧を見る'}</button>
            <Link href="/admin/products" className="ml-2 text-xs font-bold underline">商品管理で入力する</Link>
            {showMissing && (
              <ul className="mt-2 grid gap-x-4 gap-y-0.5 text-xs sm:grid-cols-2">
                {missing.map((product) => <li key={product.id}>{product.brand} {product.name}</li>)}
              </ul>
            )}
          </div>
        )}

        <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
          <h2 className="mb-1 font-bold text-gray-800">店舗別</h2>
          <p className="mb-3 text-xs text-gray-400">売上は入力欄から離れると自動で保存します（{taxIncluded ? '税込で入力 → 税抜で保存' : '税抜で入力'}）</p>
          {loading ? <p className="py-10 text-center text-sm text-gray-400">計算中...</p> : (
            <div className="overflow-x-auto">
              <table className="w-max min-w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-500">
                  <tr>
                    <th className="px-3 py-2 text-left">店舗</th>
                    <th className="px-3 py-2 text-right">施術売上</th>
                    <th className="px-3 py-2 text-right">材料費</th>
                    <th className="bg-blue-50 px-3 py-2 text-right text-blue-700">材料費率</th>
                    <th className="px-3 py-2 text-right">店販売上</th>
                    <th className="px-3 py-2 text-right">店販原価</th>
                    <th className="bg-green-50 px-3 py-2 text-right text-green-700">店販原価率</th>
                    <th className="px-3 py-2 text-right text-gray-400">個人販売（原価・参考）</th>
                  </tr>
                </thead>
                <tbody>
                  {stores.map((store) => {
                    const row = byStore.get(store.id) ?? EMPTY
                    const storeSales = salesMap.get(store.id)
                    return (
                      <tr key={store.id} className="border-t border-gray-100">
                        <td className="px-3 py-2 font-bold text-gray-700">{store.name}</td>
                        <td className="px-3 py-2 text-right">{salesInput(store.id, 'treatment_sales')}</td>
                        <td className="px-3 py-2 text-right font-medium">{money(row.material)}</td>
                        <td className="bg-blue-50/60 px-3 py-2 text-right font-bold text-blue-700">{rate(row.material, storeSales?.treatment_sales ?? null)}</td>
                        <td className="px-3 py-2 text-right">{salesInput(store.id, 'retail_sales')}</td>
                        <td className="px-3 py-2 text-right font-medium">{money(row.retailCost)}</td>
                        <td className="bg-green-50/60 px-3 py-2 text-right font-bold text-green-700">{rate(row.retailCost, storeSales?.retail_sales ?? null)}</td>
                        <td className="px-3 py-2 text-right text-gray-400">{money(row.personal)}</td>
                      </tr>
                    )
                  })}
                  <tr className="border-t-2 border-gray-300 bg-gray-50 font-bold">
                    <td className="px-3 py-2 text-gray-800">全店合計</td>
                    <td className="px-3 py-2 text-right">{total.hasTreatment ? money(total.treatment) : '−'}</td>
                    <td className="px-3 py-2 text-right">{money(total.material)}</td>
                    <td className="bg-blue-50 px-3 py-2 text-right text-blue-700">{rate(total.material, total.hasTreatment ? total.treatment : null)}</td>
                    <td className="px-3 py-2 text-right">{total.hasRetail ? money(total.retail) : '−'}</td>
                    <td className="px-3 py-2 text-right">{money(total.retailCost)}</td>
                    <td className="bg-green-50 px-3 py-2 text-right text-green-700">{rate(total.retailCost, total.hasRetail ? total.retail : null)}</td>
                    <td className="px-3 py-2 text-right text-gray-400">{money(total.personal)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
          <h2 className="mb-1 font-bold text-gray-800">材料費の内訳</h2>
          <p className="mb-3 text-xs text-gray-400">業務用は仕入れた分（店舗間移動は移動先へ付け替え）、発注しない商品と店販用商品は使った分で計算</p>
          <div className="overflow-x-auto">
            <table className="w-max min-w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500">
                <tr>
                  <th className="px-3 py-2 text-left">店舗</th>
                  <th className="px-3 py-2 text-right">業務用の入荷</th>
                  <th className="px-3 py-2 text-right">店舗間移動</th>
                  <th className="px-3 py-2 text-right">発注しない商品の使用</th>
                  <th className="px-3 py-2 text-right">店販商品の業務使用</th>
                  <th className="px-3 py-2 text-right">材料費 合計</th>
                </tr>
              </thead>
              <tbody>
                {[...stores.map((store) => ({ key: String(store.id), name: store.name, row: byStore.get(store.id) ?? EMPTY })), { key: 'total', name: '全店合計', row: total as Breakdown }].map(({ key, name, row }) => (
                  <tr key={key} className={`border-t border-gray-100 ${key === 'total' ? 'bg-gray-50 font-bold' : ''}`}>
                    <td className="px-3 py-2 font-bold text-gray-700">{name}</td>
                    <td className="px-3 py-2 text-right">{money(row.purchase)}</td>
                    <td className={`px-3 py-2 text-right ${row.transfer < 0 ? 'text-red-600' : ''}`}>{row.transfer === 0 ? '−' : money(row.transfer)}</td>
                    <td className="px-3 py-2 text-right">{money(row.usageOnly)}</td>
                    <td className="px-3 py-2 text-right">{money(row.retailBusiness)}</td>
                    <td className="px-3 py-2 text-right font-bold">{money(row.material)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  )
}

'use client'

import { useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { fetchAll } from '@/lib/fetchAll'
import { withTax, yen } from '@/lib/tax'

type Store = { id: number; name: string }
type Product = {
  id: number
  name: string
  brand: string | null
  cost_price: number | null
  product_type: 'material' | 'retail'
  usage_only: boolean
}
type Movement = { store_id: number; product_id: number; quantity: number; movement_type: string }

const NO_BRAND = '（ブランドなし）'

// 月次レポートの「材料費」と同じ数え方：
// 業務用は入荷（＋店舗間移動の付け替え）、発注しない商品と店販商品の業務使用は使った分
export function materialAmount(product: Product, movement: Movement) {
  if (product.cost_price === null) return null
  const cost = product.cost_price
  if (product.usage_only || product.product_type === 'retail') {
    return movement.movement_type === 'usage' ? -movement.quantity * cost : null
  }
  return ['purchase_order', 'transfer_in', 'transfer_out'].includes(movement.movement_type) ? movement.quantity * cost : null
}

function isCounted(product: Product, movement: Movement) {
  if (product.usage_only || product.product_type === 'retail') return movement.movement_type === 'usage'
  return ['purchase_order', 'transfer_in', 'transfer_out'].includes(movement.movement_type)
}

function brandOf(product: Product) {
  return product.brand?.trim() || NO_BRAND
}

// ブランドを選んで、期間内の材料費を店舗別・全店で調べる（選択は保存しない）
export default function BrandCostSearch({ stores, products, taxIncluded, defaultFrom, defaultTo }: {
  stores: Store[]
  products: Product[]
  taxIncluded: boolean
  defaultFrom: string
  defaultTo: string
}) {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [from, setFrom] = useState(defaultFrom)
  const [to, setTo] = useState(defaultTo)
  const [movements, setMovements] = useState<Movement[] | null>(null)
  const [searchedBrands, setSearchedBrands] = useState<string[]>([])
  const [searchedRange, setSearchedRange] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const brands = useMemo(() => {
    const names = Array.from(new Set(products.map(brandOf)))
    return names.sort((a, b) => (a === NO_BRAND ? 1 : b === NO_BRAND ? -1 : a.localeCompare(b, 'ja')))
  }, [products])
  const visibleBrands = useMemo(() => {
    const keyword = filter.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, '')
    if (!keyword) return brands
    return brands.filter((brand) => brand.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, '').includes(keyword))
  }, [brands, filter])

  const money = (amount: number) => yen(taxIncluded ? withTax(amount) : amount)

  function toggle(brand: string) {
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(brand)) next.delete(brand)
      else next.add(brand)
      return next
    })
  }

  async function search() {
    if (selected.size === 0) { setError('ブランドを1つ以上選んでください。'); return }
    if (!from || !to || from > to) { setError('期間を正しく入れてください（いつから ≦ いつまで）。'); return }
    setLoading(true)
    setError('')
    const result = await fetchAll((start, end) => supabase.from('inventory_movements')
      .select('id, store_id, product_id, quantity, movement_type')
      .gte('occurred_on', from).lte('occurred_on', to)
      .in('movement_type', ['purchase_order', 'transfer_in', 'transfer_out', 'usage'])
      .order('id').range(start, end))
    setLoading(false)
    if (result.error) { setError('読み込めませんでした。もう一度「調べる」を押してください。'); return }
    setMovements((result.data ?? []) as Movement[])
    setSearchedBrands(Array.from(selected))
    setSearchedRange(`${from.replaceAll('-', '/')} 〜 ${to.replaceAll('-', '/')}`)
  }

  const report = useMemo(() => {
    if (!movements) return null
    const targetBrands = new Set(searchedBrands)
    const productMap = new Map(products.filter((product) => targetBrands.has(brandOf(product))).map((product) => [product.id, product]))
    const byBrand = new Map<string, Map<number, number>>()
    const byProduct = new Map<number, Map<number, number>>()
    const missing = new Map<number, Product>()
    movements.forEach((movement) => {
      const product = productMap.get(movement.product_id)
      if (!product || !isCounted(product, movement)) return
      const amount = materialAmount(product, movement)
      if (amount === null) { missing.set(product.id, product); return }
      const brandRow = byBrand.get(brandOf(product)) ?? new Map<number, number>()
      brandRow.set(movement.store_id, (brandRow.get(movement.store_id) ?? 0) + amount)
      byBrand.set(brandOf(product), brandRow)
      const productRow = byProduct.get(product.id) ?? new Map<number, number>()
      productRow.set(movement.store_id, (productRow.get(movement.store_id) ?? 0) + amount)
      byProduct.set(product.id, productRow)
    })
    const sumOf = (row: Map<number, number> | undefined) => stores.reduce((sum, store) => sum + (row?.get(store.id) ?? 0), 0)
    const productRows = Array.from(byProduct.entries())
      .map(([id, row]) => ({ product: productMap.get(id)!, row, total: sumOf(row) }))
      .filter((item) => stores.some((store) => (item.row.get(store.id) ?? 0) !== 0))
      .sort((a, b) => b.total - a.total)
    const totalRow = new Map<number, number>()
    byBrand.forEach((row) => row.forEach((amount, storeId) => totalRow.set(storeId, (totalRow.get(storeId) ?? 0) + amount)))
    return { byBrand, productRows, totalRow, sumOf, missing: Array.from(missing.values()) }
  }, [movements, products, searchedBrands, stores])

  const cell = (amount: number) => (
    <span className={amount === 0 ? 'text-gray-300' : amount < 0 ? 'text-red-600' : ''}>{amount === 0 ? '−' : money(amount)}</span>
  )

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <button type="button" onClick={() => setOpen((value) => !value)} className="flex w-full items-center justify-between text-left">
        <div>
          <h2 className="font-bold text-gray-800">ブランドで調べる</h2>
          <p className="text-xs text-gray-400">ブランドを選んで、その材料費だけを店舗別・全店で出します（選んだ内容は保存されません）</p>
        </div>
        <span className="text-sm text-blue-600">{open ? '閉じる' : '開く'}</span>
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-gray-500">いつから
              <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} className="block rounded-lg border border-gray-200 px-2 py-1.5 text-base" />
            </label>
            <label className="text-xs text-gray-500">いつまで
              <input type="date" value={to} onChange={(event) => setTo(event.target.value)} className="block rounded-lg border border-gray-200 px-2 py-1.5 text-base" />
            </label>
          </div>

          <div>
            <div className="flex flex-wrap items-center gap-2">
              <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="ブランド名で絞り込み"
                className="w-48 rounded-lg border border-gray-200 px-2 py-1.5 text-base outline-none focus:border-blue-400" />
              <span className="text-xs text-gray-500">{selected.size}件選択中</span>
              {selected.size > 0 && (
                <button type="button" onClick={() => setSelected(new Set())} className="text-xs text-blue-600 underline">選択をすべて外す</button>
              )}
            </div>
            <div className="mt-2 flex max-h-56 flex-wrap gap-1.5 overflow-y-auto rounded-lg bg-gray-50 p-2">
              {visibleBrands.map((brand) => (
                <label key={brand} className={`flex cursor-pointer items-center gap-1 rounded-full border px-2.5 py-1 text-sm ${selected.has(brand) ? 'border-blue-400 bg-blue-50 text-blue-700' : 'border-gray-200 bg-white text-gray-600'}`}>
                  <input type="checkbox" checked={selected.has(brand)} onChange={() => toggle(brand)} className="h-4 w-4" />
                  {brand}
                </label>
              ))}
              {visibleBrands.length === 0 && <p className="text-xs text-gray-400">見つかりません</p>}
            </div>
          </div>

          <button type="button" onClick={() => void search()} disabled={loading}
            className="rounded-xl bg-blue-600 px-5 py-2 text-sm font-bold text-white disabled:bg-gray-300">
            {loading ? '調べています...' : '調べる'}
          </button>
          {error && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

          {report && (
            <div className="space-y-3">
              <p className="text-xs text-gray-500">
                {searchedRange}・{searchedBrands.join('、')}（{taxIncluded ? '税込' : '税抜'}・月次レポートの材料費と同じ数え方）
              </p>
              {report.missing.length > 0 && (
                <div className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  仕入れ値が未入力のため金額に入っていない商品が <b>{report.missing.length}件</b> あります：
                  {report.missing.map((product) => `${product.brand ?? ''} ${product.name}`).join('、')}
                </div>
              )}

              <div className="overflow-x-auto">
                <table className="w-full min-w-max border-collapse text-sm">
                  <thead>
                    <tr className="bg-gray-100 text-xs text-gray-500">
                      <th className="border border-gray-200 px-2 py-1.5 text-left">ブランド</th>
                      {stores.map((store) => <th key={store.id} className="border border-gray-200 px-2 py-1.5 text-right">{store.name}</th>)}
                      <th className="border border-gray-200 bg-gray-200 px-2 py-1.5 text-right">全店</th>
                    </tr>
                  </thead>
                  <tbody>
                    {searchedBrands.map((brand) => {
                      const row = report.byBrand.get(brand)
                      return (
                        <tr key={brand}>
                          <td className="border border-gray-200 px-2 py-1.5">{brand}</td>
                          {stores.map((store) => <td key={store.id} className="border border-gray-200 px-2 py-1.5 text-right">{cell(row?.get(store.id) ?? 0)}</td>)}
                          <td className="border border-gray-200 bg-gray-50 px-2 py-1.5 text-right font-medium">{cell(report.sumOf(row))}</td>
                        </tr>
                      )
                    })}
                    {searchedBrands.length > 1 && (
                      <tr className="font-bold">
                        <td className="border border-gray-200 bg-blue-50 px-2 py-1.5">合計</td>
                        {stores.map((store) => <td key={store.id} className="border border-gray-200 bg-blue-50 px-2 py-1.5 text-right">{cell(report.totalRow.get(store.id) ?? 0)}</td>)}
                        <td className="border border-gray-200 bg-blue-100 px-2 py-1.5 text-right">{cell(report.sumOf(report.totalRow))}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div>
                <h3 className="text-sm font-bold text-gray-700">商品ごとの内訳</h3>
                {report.productRows.length === 0 ? (
                  <p className="mt-1 text-xs text-gray-400">この期間に金額の出る記録はありません</p>
                ) : (
                  <div className="mt-1 max-h-[60vh] overflow-auto">
                    <table className="w-full min-w-max border-collapse text-xs">
                      <thead className="sticky top-0">
                        <tr className="bg-gray-100 text-gray-500">
                          <th className="border border-gray-200 bg-gray-100 px-2 py-1.5 text-left">ブランド</th>
                          <th className="border border-gray-200 bg-gray-100 px-2 py-1.5 text-left">商品名</th>
                          {stores.map((store) => <th key={store.id} className="border border-gray-200 bg-gray-100 px-2 py-1.5 text-right">{store.name}</th>)}
                          <th className="border border-gray-200 bg-gray-200 px-2 py-1.5 text-right">全店</th>
                        </tr>
                      </thead>
                      <tbody>
                        {report.productRows.map(({ product, row, total }) => (
                          <tr key={product.id}>
                            <td className="border border-gray-200 px-2 py-1 text-gray-400">{brandOf(product)}</td>
                            <td className="border border-gray-200 px-2 py-1">{product.name}</td>
                            {stores.map((store) => <td key={store.id} className="border border-gray-200 px-2 py-1 text-right">{cell(row.get(store.id) ?? 0)}</td>)}
                            <td className="border border-gray-200 bg-gray-50 px-2 py-1 text-right font-medium">{cell(total)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

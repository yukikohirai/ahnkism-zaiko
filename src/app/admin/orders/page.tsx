'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getCurrentProfile } from '@/lib/auth'
import { supabase } from '@/lib/supabase'

type Store = { id: number; name: string }
type Category = { id: number; name: string; sort_order: number }
type OrderRow = {
  store_id: number
  product_id: number
  opening_stock: number
  required_qty: number
  sort_order: number
  product: { id: number; category_id: number; brand: string | null; name: string; dealer: string | null; manufacturer: string | null; usage_only: boolean }
}

const UNSET = '発注先未設定'

function supplierOf(row: OrderRow) {
  return row.product.dealer || row.product.manufacturer || UNSET
}

export default function OrdersPage() {
  const router = useRouter()
  const [authorized, setAuthorized] = useState(false)
  const [stores, setStores] = useState<Store[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [rows, setRows] = useState<OrderRow[]>([])
  const [movementMap, setMovementMap] = useState<Map<string, number>>(new Map())
  const [storeId, setStoreId] = useState<number | null>(null)
  const [supplier, setSupplier] = useState<string>('all')
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

  const load = useCallback(async () => {
    if (!authorized) return
    setLoading(true)
    const [storeResult, categoryResult, assignmentResult, movementResult] = await Promise.all([
      supabase.from('stores').select('id, name').order('sort_order'),
      supabase.from('categories').select('id, name, sort_order').order('sort_order'),
      supabase.from('store_products')
        .select('store_id, product_id, opening_stock, required_qty, sort_order, products!inner(id, category_id, brand, name, dealer, manufacturer, usage_only)')
        .eq('is_active', true).eq('products.is_active', true).limit(5000),
      supabase.from('inventory_movements').select('store_id, product_id, quantity').limit(50000),
    ])
    if (storeResult.error || categoryResult.error || assignmentResult.error || movementResult.error) setError('データを読み込めませんでした。')
    const nextStores = (storeResult.data ?? []) as Store[]
    setStores(nextStores)
    setStoreId((current) => current ?? nextStores[0]?.id ?? null)
    setCategories((categoryResult.data ?? []) as Category[])
    setRows((assignmentResult.data ?? []).flatMap((row) => {
      const product = Array.isArray(row.products) ? row.products[0] : row.products
      return product ? [{ ...row, product } as OrderRow] : []
    }))
    const map = new Map<string, number>()
    ;(movementResult.data ?? []).forEach((item) => {
      const key = `${item.store_id}_${item.product_id}`
      map.set(key, (map.get(key) ?? 0) + item.quantity)
    })
    setMovementMap(map)
    setLoading(false)
  }, [authorized])

  useEffect(() => { void load() }, [load])

  const categoryOrder = useMemo(() => new Map(categories.map((category) => [category.id, category.sort_order])), [categories])
  const categoryName = useMemo(() => new Map(categories.map((category) => [category.id, category.name])), [categories])
  const sharedCategoryIds = useMemo(() => new Set(categories.filter((category) => category.name === '全店在庫').map((category) => category.id)), [categories])

  // 発注数 = 必要数 − 現在庫。発注しない商品と全店在庫は対象外
  const orderItems = useMemo(() => rows
    .filter((row) => row.store_id === storeId && !row.product.usage_only && !sharedCategoryIds.has(row.product.category_id))
    .map((row) => {
      const stock = row.opening_stock + (movementMap.get(`${row.store_id}_${row.product_id}`) ?? 0)
      return { row, stock, order: row.required_qty - stock }
    })
    .filter((item) => item.order > 0)
    .sort((a, b) => (
      supplierOf(a.row).localeCompare(supplierOf(b.row), 'ja')
      || (categoryOrder.get(a.row.product.category_id) ?? 999) - (categoryOrder.get(b.row.product.category_id) ?? 999)
      || a.row.sort_order - b.row.sort_order
    )), [categoryOrder, movementMap, rows, sharedCategoryIds, storeId])

  const suppliers = useMemo(() => {
    const counts = new Map<string, number>()
    orderItems.forEach((item) => counts.set(supplierOf(item.row), (counts.get(supplierOf(item.row)) ?? 0) + 1))
    return Array.from(counts.entries()).sort(([a], [b]) => (a === UNSET ? 1 : b === UNSET ? -1 : a.localeCompare(b, 'ja')))
  }, [orderItems])

  const grouped = useMemo(() => {
    const groups = new Map<string, typeof orderItems>()
    orderItems
      .filter((item) => supplier === 'all' || supplierOf(item.row) === supplier)
      .forEach((item) => {
        const key = supplierOf(item.row)
        groups.set(key, [...(groups.get(key) ?? []), item])
      })
    return Array.from(groups.entries()).sort(([a], [b]) => (a === UNSET ? 1 : b === UNSET ? -1 : a.localeCompare(b, 'ja')))
  }, [orderItems, supplier])

  if (!authorized) return <div className="flex min-h-[100dvh] items-center justify-center text-gray-400">権限を確認しています...</div>

  return (
    <main className="min-h-[100dvh] bg-gray-50 pb-16">
      <header className="sticky top-0 z-20 border-b bg-white px-4 py-3 shadow-sm">
        <div className="mx-auto flex max-w-3xl items-center justify-between">
          <div><h1 className="font-bold text-gray-800">発注リスト</h1><p className="text-xs text-gray-400">発注数 ＝ 必要数 − 現在庫（1以上の商品だけ表示）</p></div>
          <div className="flex gap-2">
            <button onClick={() => void load()} className="rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-600">更新</button>
            <Link href="/admin" className="rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-600">管理へ戻る</Link>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-3xl space-y-3 p-4">
        <div className="flex gap-1 overflow-x-auto">
          {stores.map((store) => (
            <button key={store.id} onClick={() => { setStoreId(store.id); setSupplier('all') }}
              className={`shrink-0 rounded-full px-4 py-2 text-sm font-bold ${storeId === store.id ? 'bg-blue-500 text-white' : 'bg-white text-gray-600 border border-gray-200'}`}>
              {store.name}
            </button>
          ))}
        </div>
        <div className="flex gap-1 overflow-x-auto pb-1">
          <button onClick={() => setSupplier('all')}
            className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium ${supplier === 'all' ? 'bg-slate-700 text-white' : 'bg-gray-100 text-gray-600'}`}>
            すべて（{orderItems.length}）
          </button>
          {suppliers.map(([name, count]) => (
            <button key={name} onClick={() => setSupplier(name)}
              className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium ${supplier === name ? 'bg-slate-700 text-white' : 'bg-gray-100 text-gray-600'}`}>
              {name}（{count}）
            </button>
          ))}
        </div>
        <p className="text-[11px] text-gray-400">「発注しない商品」と「全店在庫」は含めていません</p>
        {error && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

        {loading ? <p className="py-12 text-center text-sm text-gray-400">計算中...</p> : grouped.length === 0 ? (
          <p className="rounded-2xl bg-white py-12 text-center text-sm text-gray-400">発注が必要な商品はありません</p>
        ) : grouped.map(([name, items]) => {
          const totalQty = items.reduce((sum, item) => sum + item.order, 0)
          return (
            <section key={name} className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
              <div className="flex items-center justify-between bg-slate-100 px-4 py-2.5">
                <h2 className="font-bold text-slate-800">{name}</h2>
                <span className="text-xs text-slate-500">{items.length}品目・計{totalQty}個</span>
              </div>
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-500">
                  <tr>
                    <th className="px-4 py-2 text-left">商品</th>
                    <th className="w-16 px-2 py-2 text-center">必要数</th>
                    <th className="w-16 px-2 py-2 text-center">現在庫</th>
                    <th className="w-20 px-3 py-2 text-center">発注数</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map(({ row, stock, order }) => (
                    <tr key={row.product_id} className="border-t border-gray-100">
                      <td className="px-4 py-2">
                        <div className="text-[10px] text-gray-400">{categoryName.get(row.product.category_id)}・{row.product.brand}</div>
                        <div className="break-words font-medium text-gray-800">{row.product.name}</div>
                      </td>
                      <td className="px-2 py-2 text-center text-gray-500">{row.required_qty}</td>
                      <td className={`px-2 py-2 text-center ${stock < 0 ? 'text-red-600' : 'text-gray-500'}`}>{stock}</td>
                      <td className="bg-orange-50 px-3 py-2 text-center text-lg font-bold text-orange-600">{order}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )
        })}
      </div>
    </main>
  )
}

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
  order_sort: number | null
  product: { id: number; category_id: number; brand: string | null; name: string; dealer: string | null; manufacturer: string | null; usage_only: boolean }
}
type SupplierSort = { store_id: number; supplier: string; sort_order: number }

const UNSET = '発注先未設定'
const LAST = Number.MAX_SAFE_INTEGER

function supplierOf(row: OrderRow) {
  return row.product.dealer || row.product.manufacturer || UNSET
}

function move<T>(list: T[], index: number, delta: number) {
  const target = index + delta
  if (target < 0 || target >= list.length) return list
  const next = [...list]
  ;[next[index], next[target]] = [next[target], next[index]]
  return next
}

export default function OrdersPage() {
  const router = useRouter()
  const [authorized, setAuthorized] = useState(false)
  const [stores, setStores] = useState<Store[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [rows, setRows] = useState<OrderRow[]>([])
  const [supplierSorts, setSupplierSorts] = useState<SupplierSort[]>([])
  const [movementMap, setMovementMap] = useState<Map<string, number>>(new Map())
  const [storeId, setStoreId] = useState<number | null>(null)
  const [supplier, setSupplier] = useState<string>('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [sorting, setSorting] = useState(false)
  const [draftSuppliers, setDraftSuppliers] = useState<string[]>([])
  const [draftProducts, setDraftProducts] = useState<Record<string, number[]>>({})
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

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
    const [storeResult, categoryResult, assignmentResult, movementResult, sortResult] = await Promise.all([
      supabase.from('stores').select('id, name').order('sort_order'),
      supabase.from('categories').select('id, name, sort_order').order('sort_order'),
      supabase.from('store_products')
        .select('store_id, product_id, opening_stock, required_qty, sort_order, order_sort, products!inner(id, category_id, brand, name, dealer, manufacturer, usage_only)')
        .eq('is_active', true).eq('products.is_active', true).limit(5000),
      supabase.from('inventory_movements').select('store_id, product_id, quantity').limit(50000),
      supabase.from('order_supplier_sort').select('store_id, supplier, sort_order'),
    ])
    if (storeResult.error || categoryResult.error || assignmentResult.error || movementResult.error || sortResult.error) setError('データを読み込めませんでした。')
    const nextStores = (storeResult.data ?? []) as Store[]
    setStores(nextStores)
    setStoreId((current) => current ?? nextStores[0]?.id ?? null)
    setCategories((categoryResult.data ?? []) as Category[])
    setRows((assignmentResult.data ?? []).flatMap((row) => {
      const product = Array.isArray(row.products) ? row.products[0] : row.products
      return product ? [{ ...row, product } as OrderRow] : []
    }))
    setSupplierSorts((sortResult.data ?? []) as SupplierSort[])
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

  // この店舗の発注対象（発注しない商品と全店在庫は除く）。発注数0の商品も並び替え用に保持する
  const storeItems = useMemo(() => rows
    .filter((row) => row.store_id === storeId && !row.product.usage_only && !sharedCategoryIds.has(row.product.category_id))
    .map((row) => {
      const stock = row.opening_stock + (movementMap.get(`${row.store_id}_${row.product_id}`) ?? 0)
      return { row, stock, order: row.required_qty - stock }
    }), [movementMap, rows, sharedCategoryIds, storeId])

  // 保存済みの並び順（未設定は後ろ、発注先はあいうえお順・商品はカテゴリ順→入力画面の順）
  const savedSuppliers = useMemo(() => {
    const saved = new Map(supplierSorts.filter((item) => item.store_id === storeId).map((item) => [item.supplier, item.sort_order]))
    return Array.from(new Set(storeItems.map((item) => supplierOf(item.row))))
      .sort((a, b) => (saved.get(a) ?? LAST) - (saved.get(b) ?? LAST)
        || (a === UNSET ? 1 : b === UNSET ? -1 : a.localeCompare(b, 'ja')))
  }, [storeItems, storeId, supplierSorts])

  const savedProducts = useMemo(() => {
    const groups: Record<string, number[]> = {}
    ;[...storeItems]
      .sort((a, b) => (a.row.order_sort ?? LAST) - (b.row.order_sort ?? LAST)
        || (categoryOrder.get(a.row.product.category_id) ?? 999) - (categoryOrder.get(b.row.product.category_id) ?? 999)
        || a.row.sort_order - b.row.sort_order)
      .forEach((item) => {
        const key = supplierOf(item.row)
        ;(groups[key] ??= []).push(item.row.product_id)
      })
    return groups
  }, [categoryOrder, storeItems])

  const supplierList = sorting ? draftSuppliers : savedSuppliers
  const productOrder = sorting ? draftProducts : savedProducts
  const itemByProduct = useMemo(() => new Map(storeItems.map((item) => [item.row.product_id, item])), [storeItems])
  const orderItems = storeItems.filter((item) => item.order > 0)

  const supplierCounts = useMemo(() => {
    const counts = new Map<string, number>()
    orderItems.forEach((item) => counts.set(supplierOf(item.row), (counts.get(supplierOf(item.row)) ?? 0) + 1))
    return counts
  }, [orderItems])

  function startSorting() {
    setDraftSuppliers(savedSuppliers)
    setDraftProducts(savedProducts)
    setDirty(false)
    setSorting(true)
    setMessage('')
    setError('')
  }

  function cancelSorting() {
    if (dirty && !confirm('保存していない並び替えがあります。やめてもよろしいですか？')) return
    setSorting(false)
    setDirty(false)
  }

  async function saveSorting() {
    if (!storeId) return
    setSaving(true)
    setError('')
    const supplierPayload = draftSuppliers.map((name, index) => ({ store_id: storeId, supplier: name, sort_order: index + 1 }))
    const { error: supplierError } = await supabase.from('order_supplier_sort').upsert(supplierPayload, { onConflict: 'store_id,supplier' })
    if (supplierError) { setSaving(false); setError(`保存できませんでした：${supplierError.message}`); return }
    const updates = Object.values(draftProducts).flatMap((ids) => ids.map((productId, index) => ({ productId, sort: index + 1 })))
      .filter(({ productId, sort }) => itemByProduct.get(productId)?.row.order_sort !== sort)
    for (let start = 0; start < updates.length; start += 20) {
      const results = await Promise.all(updates.slice(start, start + 20).map(({ productId, sort }) => (
        supabase.from('store_products').update({ order_sort: sort }).eq('store_id', storeId).eq('product_id', productId)
      )))
      const failed = results.find((result) => result.error)
      if (failed?.error) { setSaving(false); setError(`保存できませんでした：${failed.error.message}`); return }
    }
    setSaving(false)
    setSorting(false)
    setDirty(false)
    setMessage('並び順を保存しました。')
    await load()
  }

  const visibleSuppliers = supplierList.filter((name) => (supplier === 'all' || name === supplier) && (sorting || (supplierCounts.get(name) ?? 0) > 0))

  if (!authorized) return <div className="flex min-h-[100dvh] items-center justify-center text-gray-400">権限を確認しています...</div>

  return (
    <main className="min-h-[100dvh] bg-gray-50 pb-16">
      <header className="sticky top-0 z-20 border-b bg-white px-4 py-3 shadow-sm">
        <div className="mx-auto flex max-w-3xl items-center justify-between">
          <div><h1 className="font-bold text-gray-800">発注リスト</h1><p className="text-xs text-gray-400">発注数 ＝ 必要数 − 現在庫（1以上の商品だけ表示）</p></div>
          <div className="flex gap-2">
            <button onClick={() => void load()} disabled={sorting} className="rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-600 disabled:opacity-40">更新</button>
            <Link href="/admin" className="rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-600">管理へ戻る</Link>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-3xl space-y-3 p-4">
        <div className="flex gap-1 overflow-x-auto">
          {stores.map((store) => (
            <button key={store.id} disabled={sorting} onClick={() => { setStoreId(store.id); setSupplier('all') }}
              className={`shrink-0 rounded-full px-4 py-2 text-sm font-bold disabled:opacity-40 ${storeId === store.id ? 'bg-blue-500 text-white' : 'bg-white text-gray-600 border border-gray-200'}`}>
              {store.name}
            </button>
          ))}
        </div>
        <div className="flex gap-1 overflow-x-auto pb-1">
          <button onClick={() => setSupplier('all')}
            className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium ${supplier === 'all' ? 'bg-slate-700 text-white' : 'bg-gray-100 text-gray-600'}`}>
            すべて（{orderItems.length}）
          </button>
          {supplierList.filter((name) => sorting || (supplierCounts.get(name) ?? 0) > 0).map((name) => (
            <button key={name} onClick={() => setSupplier(name)}
              className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium ${supplier === name ? 'bg-slate-700 text-white' : 'bg-gray-100 text-gray-600'}`}>
              {name}（{supplierCounts.get(name) ?? 0}）
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] text-gray-400">「発注しない商品」と「全店在庫」は含めていません</p>
          {sorting ? (
            <div className="flex shrink-0 gap-2">
              <button onClick={cancelSorting} className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-600">やめる</button>
              <button onClick={() => void saveSorting()} disabled={saving || !dirty} className="rounded-lg bg-blue-500 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-40">{saving ? '保存中...' : '並び順を保存'}</button>
            </div>
          ) : (
            <button onClick={startSorting} disabled={loading} className="shrink-0 rounded-lg bg-amber-50 px-3 py-1.5 text-xs font-bold text-amber-700">並び替え</button>
          )}
        </div>
        {sorting && <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-700">並び替え中です（{stores.find((store) => store.id === storeId)?.name}だけに反映）。発注先は見出しの ↑↓、商品は各行の ↑↓ で動かします。発注数0の商品も薄く表示しています。</p>}
        {message && <p className="rounded-xl bg-green-50 px-3 py-2 text-sm text-green-700">{message}</p>}
        {error && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

        {loading ? <p className="py-12 text-center text-sm text-gray-400">計算中...</p> : visibleSuppliers.length === 0 ? (
          <p className="rounded-2xl bg-white py-12 text-center text-sm text-gray-400">発注が必要な商品はありません</p>
        ) : visibleSuppliers.map((name) => {
          const supplierIndex = supplierList.indexOf(name)
          const ids = productOrder[name] ?? []
          const items = ids.map((id) => itemByProduct.get(id)).filter((item): item is NonNullable<typeof item> => !!item)
          const shown = sorting ? items : items.filter((item) => item.order > 0)
          const totalQty = items.filter((item) => item.order > 0).reduce((sum, item) => sum + item.order, 0)
          return (
            <section key={name} className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
              <div className="flex items-center justify-between gap-2 bg-slate-100 px-4 py-2.5">
                <h2 className="font-bold text-slate-800">{name}</h2>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-500">{supplierCounts.get(name) ?? 0}品目・計{totalQty}個</span>
                  {sorting && (
                    <>
                      <button onClick={() => { setDraftSuppliers((list) => move(list, supplierIndex, -1)); setDirty(true) }} disabled={supplierIndex === 0}
                        className="rounded bg-white px-2 py-1 text-xs font-bold text-slate-600 disabled:opacity-30">↑</button>
                      <button onClick={() => { setDraftSuppliers((list) => move(list, supplierIndex, 1)); setDirty(true) }} disabled={supplierIndex === supplierList.length - 1}
                        className="rounded bg-white px-2 py-1 text-xs font-bold text-slate-600 disabled:opacity-30">↓</button>
                    </>
                  )}
                </div>
              </div>
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-500">
                  <tr>
                    <th className="px-4 py-2 text-left">商品</th>
                    <th className="w-16 px-2 py-2 text-center">必要数</th>
                    <th className="w-16 px-2 py-2 text-center">現在庫</th>
                    <th className="w-20 px-3 py-2 text-center">発注数</th>
                    {sorting && <th className="w-20 px-2 py-2 text-center">順番</th>}
                  </tr>
                </thead>
                <tbody>
                  {shown.map(({ row, stock, order }) => {
                    const index = ids.indexOf(row.product_id)
                    return (
                      <tr key={row.product_id} className={`border-t border-gray-100 ${sorting && order <= 0 ? 'opacity-40' : ''}`}>
                        <td className="px-4 py-2">
                          <div className="text-[10px] text-gray-400">{categoryName.get(row.product.category_id)}・{row.product.brand}</div>
                          <div className="break-words font-medium text-gray-800">{row.product.name}</div>
                        </td>
                        <td className="px-2 py-2 text-center text-gray-500">{row.required_qty}</td>
                        <td className={`px-2 py-2 text-center ${stock < 0 ? 'text-red-600' : 'text-gray-500'}`}>{stock}</td>
                        <td className={`px-3 py-2 text-center text-lg font-bold ${order > 0 ? 'bg-orange-50 text-orange-600' : 'text-gray-300'}`}>{order > 0 ? order : 0}</td>
                        {sorting && (
                          <td className="px-2 py-2 text-center">
                            <div className="flex justify-center gap-1">
                              <button onClick={() => { setDraftProducts((groups) => ({ ...groups, [name]: move(groups[name] ?? [], index, -1) })); setDirty(true) }} disabled={index === 0}
                                className="rounded bg-gray-100 px-2 py-1 text-xs font-bold text-gray-600 disabled:opacity-30">↑</button>
                              <button onClick={() => { setDraftProducts((groups) => ({ ...groups, [name]: move(groups[name] ?? [], index, 1) })); setDirty(true) }} disabled={index === ids.length - 1}
                                className="rounded bg-gray-100 px-2 py-1 text-xs font-bold text-gray-600 disabled:opacity-30">↓</button>
                            </div>
                          </td>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </section>
          )
        })}
      </div>
    </main>
  )
}

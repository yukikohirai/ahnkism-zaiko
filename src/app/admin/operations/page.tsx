'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getCurrentProfile } from '@/lib/auth'
import { supabase } from '@/lib/supabase'

type Mode = 'receipt' | 'transfer' | 'reduction'
type Store = { id: number; name: string }
type Category = { id: number; name: string }
type AssignedProduct = {
  store_id: number
  product_id: number
  product: { id: number; category_id: number; brand: string | null; name: string }
}
type StockRow = { store_id: number; product_id: number; current_stock: number }
type MovementRow = {
  id: string
  store_id: number
  product_id: number
  occurred_on: string
  quantity: number
  movement_type: string
  created_at: string
  store: { name: string } | null
  product: { brand: string | null; name: string } | null
}

const MOVEMENT_LABELS: Record<string, string> = {
  purchase_order: '入荷・発注',
  transfer_out: '店舗移動（出）',
  transfer_in: '店舗移動（入）',
  usage: '業務利用',
  retail_sale: '店販販売',
  personal_sale: '個人販売',
  adjustment: '在庫調整',
}

function today() {
  return new Date().toLocaleDateString('sv-SE')
}

function normalizeSearch(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, '')
}

export default function OperationsPage() {
  const router = useRouter()
  const [authorized, setAuthorized] = useState(false)
  const [stores, setStores] = useState<Store[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [assignments, setAssignments] = useState<AssignedProduct[]>([])
  const [stockRows, setStockRows] = useState<StockRow[]>([])
  const [recent, setRecent] = useState<MovementRow[]>([])
  const [mode, setMode] = useState<Mode>('receipt')
  const [date, setDate] = useState(today())
  const [storeId, setStoreId] = useState<number | null>(null)
  const [fromStoreId, setFromStoreId] = useState<number | null>(null)
  const [toStoreId, setToStoreId] = useState<number | null>(null)
  const [productId, setProductId] = useState<number | null>(null)
  const [quantity, setQuantity] = useState(1)
  const [reason, setReason] = useState<'usage' | 'retail_sale' | 'personal_sale'>('retail_sale')
  const [search, setSearch] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => { void authorize() }, [])

  async function authorize() {
    const profile = await getCurrentProfile()
    if (!profile) {
      router.replace('/')
      return
    }
    if (profile.role !== 'hq') {
      router.replace(`/${profile.store_id}/input`)
      return
    }
    setAuthorized(true)
  }

  const loadData = useCallback(async () => {
    if (!authorized) return
    const [storeResult, categoryResult, assignmentResult, stockResult, movementResult] = await Promise.all([
      supabase.from('stores').select('id, name').order('sort_order'),
      supabase.from('categories').select('id, name').order('sort_order'),
      supabase.from('store_products')
        .select('store_id, product_id, products!inner(id, category_id, brand, name)')
        .eq('is_active', true).eq('products.is_active', true),
      supabase.from('current_store_stock').select('store_id, product_id, current_stock'),
      supabase.from('inventory_movements')
        .select('id, store_id, product_id, occurred_on, quantity, movement_type, created_at, stores(name), products(brand, name)')
        .order('created_at', { ascending: false }).limit(30),
    ])
    const nextStores = (storeResult.data ?? []) as Store[]
    setStores(nextStores)
    setCategories((categoryResult.data ?? []) as Category[])
    setAssignments((assignmentResult.data ?? []).flatMap((row) => {
      const product = Array.isArray(row.products) ? row.products[0] : row.products
      return product ? [{ store_id: row.store_id, product_id: row.product_id, product } as AssignedProduct] : []
    }))
    setStockRows((stockResult.data ?? []) as StockRow[])
    setRecent((movementResult.data ?? []).map((row) => ({
      id: row.id,
      store_id: row.store_id,
      product_id: row.product_id,
      occurred_on: row.occurred_on,
      quantity: row.quantity,
      movement_type: row.movement_type,
      created_at: row.created_at,
      store: Array.isArray(row.stores) ? row.stores[0] ?? null : row.stores,
      product: Array.isArray(row.products) ? row.products[0] ?? null : row.products,
    })))
    if (nextStores.length > 0) {
      setStoreId((current) => current ?? nextStores[0].id)
      setFromStoreId((current) => current ?? nextStores[0].id)
      setToStoreId((current) => current ?? nextStores[1]?.id ?? nextStores[0].id)
    }
  }, [authorized])

  useEffect(() => { void loadData() }, [loadData])
  useEffect(() => { setProductId(null); setSearch(''); setMessage(''); setError('') }, [mode, storeId, fromStoreId, toStoreId])

  const stockMap = useMemo(() => new Map(stockRows.map((row) => [`${row.store_id}_${row.product_id}`, row.current_stock])), [stockRows])
  const retailCategoryIds = useMemo(() => new Set(
    categories.filter((category) => /店販|オージュア|aujua/i.test(category.name)).map((category) => category.id)
  ), [categories])

  const availableProducts = useMemo(() => {
    const targetStoreId = mode === 'transfer' ? fromStoreId : storeId
    if (!targetStoreId) return []
    const destinationProductIds = mode === 'transfer' && toStoreId
      ? new Set(assignments.filter((item) => item.store_id === toStoreId).map((item) => item.product_id))
      : null
    const normalized = normalizeSearch(search)
    return assignments
      .filter((item) => item.store_id === targetStoreId)
      .filter((item) => !destinationProductIds || destinationProductIds.has(item.product_id))
      .filter((item) => mode !== 'reduction' || retailCategoryIds.has(item.product.category_id))
      .filter((item) => !normalized || normalizeSearch(`${item.product.brand ?? ''}${item.product.name}`).includes(normalized))
      .sort((a, b) => (a.product.brand ?? '').localeCompare(b.product.brand ?? '', 'ja') || a.product.name.localeCompare(b.product.name, 'ja'))
      .slice(0, 80)
  }, [assignments, fromStoreId, mode, retailCategoryIds, search, storeId, toStoreId])

  const selectedProduct = assignments.find((item) => item.store_id === (mode === 'transfer' ? fromStoreId : storeId) && item.product_id === productId)
  const selectedStock = selectedProduct
    ? stockMap.get(`${selectedProduct.store_id}_${selectedProduct.product_id}`) ?? 0
    : 0

  async function handleSubmit() {
    if (!productId || quantity < 1) {
      setError('商品と数量を確認してください。')
      return
    }
    setSaving(true)
    setError('')
    setMessage('')
    if (mode === 'transfer') {
      if (!fromStoreId || !toStoreId || fromStoreId === toStoreId) {
        setError('移動元と移動先は別の店舗を選んでください。')
        setSaving(false)
        return
      }
      const { error: submitError } = await supabase.rpc('record_stock_transfer', {
        p_occurred_on: date,
        p_from_store_id: fromStoreId,
        p_to_store_id: toStoreId,
        p_product_id: productId,
        p_quantity: quantity,
      })
      if (submitError) setError(submitError.message)
      else setMessage('店舗間移動を登録し、両店舗の在庫へ反映しました。')
    } else {
      if (!storeId) {
        setError('店舗を選んでください。')
        setSaving(false)
        return
      }
      const movementType = mode === 'receipt' ? 'purchase_order' : reason
      const { error: submitError } = await supabase.rpc('record_inventory_operation', {
        p_occurred_on: date,
        p_store_id: storeId,
        p_product_id: productId,
        p_quantity: quantity,
        p_movement_type: movementType,
        p_note: null,
      })
      if (submitError) setError(submitError.message)
      else setMessage(mode === 'receipt' ? '入荷・発注数を在庫へ加算しました。' : '在庫の減少理由を登録しました。')
    }
    setSaving(false)
    setProductId(null)
    setSearch('')
    setQuantity(1)
    await loadData()
  }

  if (!authorized) return <div className="flex min-h-[100dvh] items-center justify-center text-gray-400">権限を確認しています...</div>

  return (
    <main className="min-h-[100dvh] bg-gray-50 pb-16">
      <header className="sticky top-0 z-20 border-b bg-white px-4 py-3 shadow-sm">
        <div className="mx-auto flex max-w-3xl items-center justify-between">
          <div><h1 className="font-bold text-gray-800">在庫の入出庫</h1><p className="text-xs text-gray-400">本部専用</p></div>
          <Link href="/admin" className="rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-600">管理へ戻る</Link>
        </div>
      </header>

      <div className="mx-auto max-w-3xl p-4">
        <div className="mb-4 grid grid-cols-3 gap-2 rounded-2xl bg-white p-2 shadow-sm">
          {([
            ['receipt', '入荷・発注'],
            ['transfer', '店舗間移動'],
            ['reduction', '減少理由'],
          ] as [Mode, string][]).map(([value, label]) => (
            <button key={value} onClick={() => setMode(value)} className={`rounded-xl px-2 py-3 text-sm font-bold ${mode === value ? 'bg-blue-500 text-white' : 'bg-gray-50 text-gray-600'}`}>{label}</button>
          ))}
        </div>

        <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
          <label className="block text-xs font-medium text-gray-500">日付
            <input type="date" value={date} onChange={(event) => setDate(event.target.value)} className="mt-1 block w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm" />
          </label>

          {mode === 'transfer' ? (
            <div className="mt-3 grid grid-cols-[1fr_auto_1fr] items-end gap-2">
              <StoreSelect label="移動元" stores={stores} value={fromStoreId} onChange={setFromStoreId} />
              <span className="pb-3 text-gray-400">→</span>
              <StoreSelect label="移動先" stores={stores} value={toStoreId} onChange={setToStoreId} />
            </div>
          ) : (
            <div className="mt-3"><StoreSelect label="店舗" stores={stores} value={storeId} onChange={setStoreId} /></div>
          )}

          {mode === 'receipt' && <p className="mt-3 rounded-xl bg-blue-50 px-3 py-2 text-xs text-blue-700">現在の運用に合わせ、発注・入荷として入力した時点で店舗在庫へ加算します。</p>}
          {mode === 'reduction' && (
            <label className="mt-3 block text-xs font-medium text-gray-500">減少理由
              <select value={reason} onChange={(event) => setReason(event.target.value as typeof reason)} className="mt-1 block w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm">
                <option value="usage">業務利用</option><option value="retail_sale">店販販売</option><option value="personal_sale">個人販売</option>
              </select>
            </label>
          )}

          <label className="mt-4 block text-xs font-medium text-gray-500">商品検索
            <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="商品名・ブランドで検索" className="mt-1 block w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm outline-none focus:border-blue-400" />
          </label>
          <div className="mt-2 max-h-64 overflow-y-auto rounded-xl border border-gray-100">
            {availableProducts.map((item) => {
              const itemStock = stockMap.get(`${item.store_id}_${item.product_id}`) ?? 0
              return (
                <button key={`${item.store_id}_${item.product_id}`} onClick={() => setProductId(item.product_id)}
                  className={`flex w-full items-center justify-between border-b border-gray-100 px-3 py-2 text-left last:border-0 ${productId === item.product_id ? 'bg-blue-50' : 'bg-white'}`}>
                  <span><span className="block text-[10px] text-gray-400">{item.product.brand}</span><span className="text-sm font-medium text-gray-700">{item.product.name}</span></span>
                  <span className="ml-3 shrink-0 text-xs text-gray-500">在庫 {itemStock}</span>
                </button>
              )
            })}
            {availableProducts.length === 0 && <p className="px-3 py-8 text-center text-sm text-gray-400">該当商品がありません</p>}
          </div>

          {selectedProduct && (
            <div className="mt-3 rounded-xl bg-gray-50 p-3">
              <div className="text-xs text-gray-400">選択中・現在庫 {selectedStock}</div>
              <div className="font-bold text-gray-800">{selectedProduct.product.brand} {selectedProduct.product.name}</div>
            </div>
          )}

          <label className="mt-3 block text-xs font-medium text-gray-500">数量
            <input type="number" min="1" step="1" value={quantity} onChange={(event) => setQuantity(Math.max(1, parseInt(event.target.value) || 1))} className="mt-1 block w-full rounded-xl border border-gray-200 px-3 py-3 text-center text-lg font-bold" />
          </label>
          {message && <p className="mt-3 rounded-xl bg-green-50 px-3 py-2 text-sm text-green-700">{message}</p>}
          {error && <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
          <button onClick={() => void handleSubmit()} disabled={!productId || saving}
            className="mt-4 w-full rounded-xl bg-blue-500 py-3.5 font-bold text-white disabled:bg-gray-200 disabled:text-gray-400">
            {saving ? '登録中...' : mode === 'transfer' ? '店舗間移動を登録' : mode === 'receipt' ? '在庫へ加算' : '減少を登録'}
          </button>
        </section>

        <section className="mt-5 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between"><h2 className="font-bold text-gray-800">最近の在庫履歴</h2><button onClick={() => void loadData()} className="text-xs text-blue-600">更新</button></div>
          <div className="divide-y divide-gray-100">
            {recent.map((item) => (
              <div key={item.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <div className="min-w-0"><div className="text-xs text-gray-400">{item.occurred_on}・{item.store?.name}・{MOVEMENT_LABELS[item.movement_type] ?? item.movement_type}</div><div className="truncate font-medium text-gray-700">{item.product?.brand} {item.product?.name}</div></div>
                <div className={`shrink-0 font-bold ${item.quantity > 0 ? 'text-green-600' : 'text-red-600'}`}>{item.quantity > 0 ? '+' : ''}{item.quantity}</div>
              </div>
            ))}
            {recent.length === 0 && <p className="py-8 text-center text-sm text-gray-400">まだ履歴はありません</p>}
          </div>
        </section>
      </div>
    </main>
  )
}

function StoreSelect({ label, stores, value, onChange }: { label: string; stores: Store[]; value: number | null; onChange: (value: number) => void }) {
  return (
    <label className="block text-xs font-medium text-gray-500">{label}
      <select value={value ?? ''} onChange={(event) => onChange(Number(event.target.value))} className="mt-1 block w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm">
        {stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}
      </select>
    </label>
  )
}

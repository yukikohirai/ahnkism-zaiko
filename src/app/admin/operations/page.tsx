'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getCurrentProfile } from '@/lib/auth'
import { supabase } from '@/lib/supabase'

type Mode = 'receipt' | 'transfer' | 'reduction' | 'adjustment'
type Store = { id: number; name: string }
type Category = { id: number; name: string }
type AssignedProduct = {
  store_id: number
  product_id: number
  sort_order: number
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
  note: string | null
  session_id: string | null
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
  adjustment: '誤差調整',
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
  const [historyStoreId, setHistoryStoreId] = useState<number | 'all'>('all')
  const [historyFrom, setHistoryFrom] = useState('')
  const [historyTo, setHistoryTo] = useState('')
  const [historySearch, setHistorySearch] = useState('')
  const [historyLoading, setHistoryLoading] = useState(false)
  const [editMode, setEditMode] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDate, setEditDate] = useState('')
  const [editStoreId, setEditStoreId] = useState<number | null>(null)
  const [editToStoreId, setEditToStoreId] = useState<number | null>(null)
  const [editType, setEditType] = useState('purchase_order')
  const [editQuantity, setEditQuantity] = useState('')
  const [editSaving, setEditSaving] = useState(false)
  const [historyMessage, setHistoryMessage] = useState('')
  const [historyError, setHistoryError] = useState('')
  const [mode, setMode] = useState<Mode>('receipt')
  const [date, setDate] = useState(today())
  const [storeId, setStoreId] = useState<number | null>(null)
  const [fromStoreId, setFromStoreId] = useState<number | null>(null)
  const [toStoreId, setToStoreId] = useState<number | null>(null)
  const [productId, setProductId] = useState<number | null>(null)
  const [quantity, setQuantity] = useState(1)
  const [actualStock, setActualStock] = useState('')
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
    const [storeResult, categoryResult, assignmentResult, stockResult] = await Promise.all([
      supabase.from('stores').select('id, name').order('sort_order'),
      supabase.from('categories').select('id, name').order('sort_order'),
      supabase.from('store_products')
        .select('store_id, product_id, sort_order, products!inner(id, category_id, brand, name)')
        .eq('is_active', true).eq('products.is_active', true).limit(5000),
      supabase.from('current_store_stock').select('store_id, product_id, current_stock'),
    ])
    const nextStores = (storeResult.data ?? []) as Store[]
    setStores(nextStores)
    setCategories((categoryResult.data ?? []) as Category[])
    setAssignments((assignmentResult.data ?? []).flatMap((row) => {
      const product = Array.isArray(row.products) ? row.products[0] : row.products
      return product ? [{ store_id: row.store_id, product_id: row.product_id, sort_order: row.sort_order, product } as AssignedProduct] : []
    }))
    setStockRows((stockResult.data ?? []) as StockRow[])
    if (nextStores.length > 0) {
      setStoreId((current) => current ?? nextStores[0].id)
      setFromStoreId((current) => current ?? nextStores[0].id)
      setToStoreId((current) => current ?? nextStores[1]?.id ?? nextStores[0].id)
    }
  }, [authorized])

  useEffect(() => { void loadData() }, [loadData])

  const loadHistory = useCallback(async () => {
    if (!authorized) return
    setHistoryLoading(true)
    let query = supabase.from('inventory_movements')
      .select('id, store_id, product_id, occurred_on, quantity, movement_type, note, session_id, created_at, stores(name), products!inner(brand, name)')
      .order('occurred_on', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(200)
    if (historyStoreId !== 'all') query = query.eq('store_id', historyStoreId)
    if (historyFrom) query = query.gte('occurred_on', historyFrom)
    if (historyTo) query = query.lte('occurred_on', historyTo)
    const keyword = historySearch.trim()
    if (keyword) query = query.ilike('products.name', `%${keyword}%`)
    const { data, error: historyLoadError } = await query
    setHistoryLoading(false)
    if (historyLoadError) {
      setHistoryError('履歴を読み込めませんでした。')
      return
    }
    setRecent((data ?? []).map((row) => ({
      id: row.id,
      store_id: row.store_id,
      product_id: row.product_id,
      occurred_on: row.occurred_on,
      quantity: row.quantity,
      movement_type: row.movement_type,
      note: row.note,
      session_id: row.session_id,
      created_at: row.created_at,
      store: Array.isArray(row.stores) ? row.stores[0] ?? null : row.stores,
      product: Array.isArray(row.products) ? row.products[0] ?? null : row.products,
    })))
  }, [authorized, historyFrom, historySearch, historyStoreId, historyTo])

  useEffect(() => {
    const timer = setTimeout(() => { void loadHistory() }, 300)
    return () => clearTimeout(timer)
  }, [loadHistory])

  const isTransfer = (type: string) => type === 'transfer_in' || type === 'transfer_out'

  async function startEdit(item: MovementRow) {
    setHistoryMessage('')
    setHistoryError('')
    setEditingId(item.id)
    setEditDate(item.occurred_on)
    setEditType(item.movement_type)
    if (isTransfer(item.movement_type)) {
      // 出と入は note で結びついている。絞り込みで相手側が一覧に無いこともあるのでDBから取る
      const { data: pair } = await supabase.from('inventory_movements')
        .select('store_id, movement_type')
        .eq('note', item.note ?? '')
        .neq('id', item.id)
        .in('movement_type', ['transfer_in', 'transfer_out'])
        .maybeSingle()
      const outStore = item.movement_type === 'transfer_out' ? item.store_id : pair?.store_id
      const inStore = item.movement_type === 'transfer_in' ? item.store_id : pair?.store_id
      setEditStoreId(outStore ?? null)
      setEditToStoreId(inStore ?? null)
      setEditQuantity(String(Math.abs(item.quantity)))
    } else {
      setEditStoreId(item.store_id)
      setEditToStoreId(null)
      setEditQuantity(String(item.movement_type === 'adjustment' ? item.quantity : Math.abs(item.quantity)))
    }
  }

  async function saveEdit(item: MovementRow) {
    const parsed = parseInt(editQuantity, 10)
    if (!editDate || !editStoreId || Number.isNaN(parsed)) {
      setHistoryError('日付・店舗・数量を確認してください。')
      return
    }
    if (isTransfer(item.movement_type) && !editToStoreId) {
      setHistoryError('移動先の店舗を選んでください。')
      return
    }
    setEditSaving(true)
    setHistoryError('')
    const { error: updateError } = await supabase.rpc('update_inventory_movement', {
      p_id: item.id,
      p_occurred_on: editDate,
      p_store_id: editStoreId,
      p_movement_type: isTransfer(item.movement_type) ? item.movement_type : editType,
      p_quantity: parsed,
      p_to_store_id: isTransfer(item.movement_type) ? editToStoreId : null,
    })
    setEditSaving(false)
    if (updateError) {
      setHistoryError(updateError.message)
      return
    }
    setEditingId(null)
    setHistoryMessage('履歴を修正し、在庫を計算し直しました。')
    await Promise.all([loadHistory(), loadData()])
  }

  async function deleteMovement(item: MovementRow) {
    const label = `${item.occurred_on} ${item.store?.name ?? ''} ${item.product?.name ?? ''}（${item.quantity > 0 ? '+' : ''}${item.quantity}）`
    const warning = isTransfer(item.movement_type)
      ? `店舗間移動の「出」と「入」をまとめて取り消します。\n${label}\n在庫は移動前に戻ります。よろしいですか？`
      : `この履歴を取り消します。\n${label}\n在庫はこの入力をする前に戻ります。よろしいですか？`
    if (!confirm(warning)) return
    setEditSaving(true)
    setHistoryError('')
    const { error: deleteError } = await supabase.rpc('delete_inventory_movement', { p_id: item.id })
    setEditSaving(false)
    if (deleteError) {
      setHistoryError(deleteError.message)
      return
    }
    setEditingId(null)
    setHistoryMessage('履歴を取り消し、在庫を計算し直しました。')
    await Promise.all([loadHistory(), loadData()])
  }
  useEffect(() => { setProductId(null); setSearch(''); setMessage(''); setError(''); setActualStock('') }, [mode, storeId, fromStoreId, toStoreId])

  const stockMap = useMemo(() => new Map(stockRows.map((row) => [`${row.store_id}_${row.product_id}`, row.current_stock])), [stockRows])
  // 店舗入力画面と同じ並び（カテゴリの sort_order → 店舗ごとの store_products.sort_order）で全件出す。
  const productGroups = useMemo(() => {
    const targetStoreId = mode === 'transfer' ? fromStoreId : storeId
    if (!targetStoreId) return []
    const destinationProductIds = mode === 'transfer' && toStoreId
      ? new Set(assignments.filter((item) => item.store_id === toStoreId).map((item) => item.product_id))
      : null
    const normalized = normalizeSearch(search)
    const grouped = new Map<number, AssignedProduct[]>()
    assignments
      .filter((item) => item.store_id === targetStoreId)
      .filter((item) => !destinationProductIds || destinationProductIds.has(item.product_id))
      .filter((item) => !normalized || normalizeSearch(`${item.product.brand ?? ''}${item.product.name}`).includes(normalized))
      .forEach((item) => {
        const list = grouped.get(item.product.category_id) ?? []
        list.push(item)
        grouped.set(item.product.category_id, list)
      })
    return categories
      .filter((category) => grouped.has(category.id))
      .map((category) => ({
        category,
        items: (grouped.get(category.id) ?? []).sort((a, b) => a.sort_order - b.sort_order),
      }))
  }, [assignments, categories, fromStoreId, mode, search, storeId, toStoreId])

  const availableCount = useMemo(
    () => productGroups.reduce((total, group) => total + group.items.length, 0),
    [productGroups],
  )

  const selectedProduct = assignments.find((item) => item.store_id === (mode === 'transfer' ? fromStoreId : storeId) && item.product_id === productId)
  const selectedStock = selectedProduct
    ? stockMap.get(`${selectedProduct.store_id}_${selectedProduct.product_id}`) ?? 0
    : 0
  const actualStockValue = actualStock === '' ? null : Math.max(0, parseInt(actualStock) || 0)
  const adjustmentDiff = actualStockValue === null ? 0 : actualStockValue - selectedStock

  function selectProduct(item: AssignedProduct) {
    setProductId(item.product_id)
    if (mode === 'adjustment') {
      setActualStock(String(stockMap.get(`${item.store_id}_${item.product_id}`) ?? 0))
    }
  }

  async function handleSubmit() {
    if (!productId) {
      setError('商品を選んでください。')
      return
    }
    if (mode === 'adjustment') {
      if (actualStockValue === null || adjustmentDiff === 0) {
        setError('実際の在庫数を入力してください（今の在庫と同じ場合は登録不要です）。')
        return
      }
    } else if (quantity < 1) {
      setError('数量を確認してください。')
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
      const movementType = mode === 'receipt' ? 'purchase_order' : mode === 'adjustment' ? 'adjustment' : reason
      const { error: submitError } = await supabase.rpc('record_inventory_operation', {
        p_occurred_on: date,
        p_store_id: storeId,
        p_product_id: productId,
        p_quantity: mode === 'adjustment' ? adjustmentDiff : quantity,
        p_movement_type: movementType,
        p_note: mode === 'adjustment' ? `誤差調整 実在庫 ${actualStockValue}（前 ${selectedStock}）` : null,
      })
      if (submitError) setError(submitError.message)
      else if (mode === 'receipt') setMessage('入荷・発注数を在庫へ加算しました。')
      else if (mode === 'adjustment') setMessage(`誤差調整を登録しました（${selectedStock} → ${actualStockValue}）。`)
      else setMessage('在庫の減少理由を登録しました。')
    }
    setSaving(false)
    setProductId(null)
    setSearch('')
    setQuantity(1)
    setActualStock('')
    await Promise.all([loadData(), loadHistory()])
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
        <div className="mb-4 grid grid-cols-4 gap-2 rounded-2xl bg-white p-2 shadow-sm">
          {([
            ['receipt', '入荷・発注'],
            ['transfer', '店舗間移動'],
            ['reduction', '減少理由'],
            ['adjustment', '誤差調整'],
          ] as [Mode, string][]).map(([value, label]) => (
            <button key={value} onClick={() => setMode(value)} className={`rounded-xl px-1 py-3 text-xs font-bold ${mode === value ? 'bg-blue-500 text-white' : 'bg-gray-50 text-gray-600'}`}>{label}</button>
          ))}
        </div>

        <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
          <label className="block text-xs font-medium text-gray-500">日付
            <input type="date" value={date} onChange={(event) => setDate(event.target.value)} className="mt-1 block w-full rounded-xl border border-gray-200 px-3 py-2 text-base" />
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
          {mode === 'adjustment' && <p className="mt-3 rounded-xl bg-blue-50 px-3 py-2 text-xs text-blue-700">数えた実際の在庫数を入力すると、差分だけを「誤差調整」として記録します。</p>}
          {mode === 'reduction' && (
            <label className="mt-3 block text-xs font-medium text-gray-500">減少理由
              <select value={reason} onChange={(event) => setReason(event.target.value as typeof reason)} className="mt-1 block w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-base">
                <option value="usage">業務利用</option><option value="retail_sale">店販販売</option><option value="personal_sale">個人販売</option>
              </select>
            </label>
          )}

          <label className="mt-4 block text-xs font-medium text-gray-500">商品検索
            <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="商品名・ブランドで検索" className="mt-1 block w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-base outline-none focus:border-blue-400" />
          </label>
          <div className="mt-2 max-h-[60dvh] overflow-y-auto rounded-xl border border-gray-100">
            {productGroups.map((group) => (
              <div key={group.category.id}>
                <div className="border-b border-gray-100 bg-slate-50 px-3 py-1.5 text-xs font-bold text-gray-600">{group.category.name}</div>
                {group.items.map((item) => {
                  const itemStock = stockMap.get(`${item.store_id}_${item.product_id}`) ?? 0
                  return (
                    <button key={`${item.store_id}_${item.product_id}`} onClick={() => selectProduct(item)}
                      className={`flex w-full items-center justify-between border-b border-gray-100 px-3 py-2 text-left last:border-0 ${productId === item.product_id ? 'bg-blue-50' : 'bg-white'}`}>
                      <span><span className="block text-[10px] text-gray-400">{item.product.brand}</span><span className="text-sm font-medium text-gray-700">{item.product.name}</span></span>
                      <span className={`ml-3 shrink-0 text-xs ${itemStock < 0 ? 'font-bold text-red-600' : 'text-gray-500'}`}>在庫 {itemStock}</span>
                    </button>
                  )
                })}
              </div>
            ))}
            {availableCount === 0 && <p className="px-3 py-8 text-center text-sm text-gray-400">該当商品がありません</p>}
          </div>

          {selectedProduct && (
            <div className="mt-3 rounded-xl bg-gray-50 p-3">
              <div className="text-xs text-gray-400">選択中・現在庫 <span className={selectedStock < 0 ? 'font-bold text-red-600' : ''}>{selectedStock}</span></div>
              <div className="font-bold text-gray-800">{selectedProduct.product.brand} {selectedProduct.product.name}</div>
              {mode === 'adjustment' && actualStockValue !== null && (
                <div className={`mt-1 text-sm font-bold ${adjustmentDiff === 0 ? 'text-gray-400' : adjustmentDiff > 0 ? 'text-green-600' : 'text-red-600'}`}>
                  今の在庫 {selectedStock} → 実在庫 {actualStockValue}（差分 {adjustmentDiff > 0 ? '+' : ''}{adjustmentDiff}）
                </div>
              )}
            </div>
          )}

          {mode === 'adjustment' ? (
            <label className="mt-3 block text-xs font-medium text-gray-500">実際の在庫数
              <input type="number" min="0" step="1" value={actualStock} onChange={(event) => setActualStock(event.target.value)} placeholder="数えた在庫数" className="mt-1 block w-full rounded-xl border border-gray-200 px-3 py-3 text-center text-lg font-bold" />
            </label>
          ) : (
            <label className="mt-3 block text-xs font-medium text-gray-500">数量
              <input type="number" min="1" step="1" value={quantity} onChange={(event) => setQuantity(Math.max(1, parseInt(event.target.value) || 1))} className="mt-1 block w-full rounded-xl border border-gray-200 px-3 py-3 text-center text-lg font-bold" />
            </label>
          )}
          {message && <p className="mt-3 rounded-xl bg-green-50 px-3 py-2 text-sm text-green-700">{message}</p>}
          {error && <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
          <button onClick={() => void handleSubmit()} disabled={!productId || saving || (mode === 'adjustment' && adjustmentDiff === 0)}
            className="mt-4 w-full rounded-xl bg-blue-500 py-3.5 font-bold text-white disabled:bg-gray-200 disabled:text-gray-400">
            {saving ? '登録中...' : mode === 'transfer' ? '店舗間移動を登録' : mode === 'receipt' ? '在庫へ加算' : mode === 'adjustment' ? '誤差調整を登録' : '減少を登録'}
          </button>
        </section>

        <section className="mt-5 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="font-bold text-gray-800">在庫履歴</h2>
            <div className="flex items-center gap-2">
              <button onClick={() => void loadHistory()} className="text-xs text-blue-600">更新</button>
              <button onClick={() => { setEditMode((value) => !value); setEditingId(null); setHistoryError(''); setHistoryMessage('') }}
                className={`rounded-lg px-3 py-1.5 text-xs font-bold ${editMode ? 'bg-amber-500 text-white' : 'bg-amber-50 text-amber-700'}`}>
                {editMode ? '修正モードを終了' : '修正モード'}
              </button>
            </div>
          </div>
          {editMode && <p className="mb-3 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-700">修正モード中です。各行の「修正」から書き換え・取り消しができます。</p>}
          <div className="mb-3 grid grid-cols-2 gap-2">
            <select value={historyStoreId} onChange={(event) => setHistoryStoreId(event.target.value === 'all' ? 'all' : Number(event.target.value))}
              className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-base">
              <option value="all">全店舗</option>
              {stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}
            </select>
            <input type="search" value={historySearch} onChange={(event) => setHistorySearch(event.target.value)} placeholder="商品名で絞り込み"
              className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-base outline-none focus:border-blue-400" />
            <label className="text-[10px] text-gray-400">いつから
              <input type="date" value={historyFrom} onChange={(event) => setHistoryFrom(event.target.value)} className="block w-full rounded-xl border border-gray-200 px-3 py-2 text-base text-gray-700" />
            </label>
            <label className="text-[10px] text-gray-400">いつまで
              <input type="date" value={historyTo} onChange={(event) => setHistoryTo(event.target.value)} className="block w-full rounded-xl border border-gray-200 px-3 py-2 text-base text-gray-700" />
            </label>
          </div>
          {historyMessage && <p className="mb-2 rounded-xl bg-green-50 px-3 py-2 text-sm text-green-700">{historyMessage}</p>}
          {historyError && <p className="mb-2 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">{historyError}</p>}
          <div className="divide-y divide-gray-100">
            {recent.map((item) => (
              <div key={item.id} className="py-2.5 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs text-gray-400">
                      {item.occurred_on}・{item.store?.name}・{MOVEMENT_LABELS[item.movement_type] ?? item.movement_type}
                      {item.session_id && <span className="ml-1 rounded bg-blue-50 px-1 text-[10px] text-blue-600">店舗報告</span>}
                    </div>
                    <div className="break-words font-medium text-gray-700">{item.product?.brand} {item.product?.name}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <div className={`font-bold ${item.quantity > 0 ? 'text-green-600' : 'text-red-600'}`}>{item.quantity > 0 ? '+' : ''}{item.quantity}</div>
                    {editMode && editingId !== item.id && (
                      <button onClick={() => void startEdit(item)} className="rounded-lg bg-blue-50 px-2.5 py-1.5 text-xs font-medium text-blue-700">修正</button>
                    )}
                  </div>
                </div>
                {editMode && editingId === item.id && (
                  <div className="mt-2 space-y-2 rounded-xl border border-amber-200 bg-amber-50/50 p-3">
                    <label className="block text-xs text-gray-500">日付
                      <input type="date" value={editDate} onChange={(event) => setEditDate(event.target.value)} className="mt-1 block w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-base" />
                    </label>
                    {isTransfer(item.movement_type) ? (
                      <div className="grid grid-cols-2 gap-2">
                        <label className="block text-xs text-gray-500">移動元
                          <select value={editStoreId ?? ''} onChange={(event) => setEditStoreId(Number(event.target.value))} className="mt-1 block w-full rounded-lg border border-gray-200 bg-white px-2 py-2 text-base">
                            <option value="" disabled>選択</option>
                            {stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}
                          </select>
                        </label>
                        <label className="block text-xs text-gray-500">移動先
                          <select value={editToStoreId ?? ''} onChange={(event) => setEditToStoreId(Number(event.target.value))} className="mt-1 block w-full rounded-lg border border-gray-200 bg-white px-2 py-2 text-base">
                            <option value="" disabled>選択</option>
                            {stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}
                          </select>
                        </label>
                      </div>
                    ) : (
                      <div className="grid grid-cols-2 gap-2">
                        <label className="block text-xs text-gray-500">店舗
                          <select value={editStoreId ?? ''} onChange={(event) => setEditStoreId(Number(event.target.value))} className="mt-1 block w-full rounded-lg border border-gray-200 bg-white px-2 py-2 text-base">
                            {stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}
                          </select>
                        </label>
                        <label className="block text-xs text-gray-500">種類
                          <select value={editType} onChange={(event) => setEditType(event.target.value)} className="mt-1 block w-full rounded-lg border border-gray-200 bg-white px-2 py-2 text-base">
                            <option value="purchase_order">入荷・発注</option>
                            <option value="usage">業務利用</option>
                            <option value="retail_sale">店販販売</option>
                            <option value="personal_sale">個人販売</option>
                            <option value="adjustment">誤差調整</option>
                          </select>
                        </label>
                      </div>
                    )}
                    <label className="block text-xs text-gray-500">
                      {editType === 'adjustment' && !isTransfer(item.movement_type) ? '数量（増やす＋・減らす−）' : '数量（入荷は加算、使用・販売は在庫から引かれます）'}
                      <input type="number" step="1" value={editQuantity} onChange={(event) => setEditQuantity(event.target.value)}
                        className="mt-1 block w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-center text-lg font-bold" />
                    </label>
                    <div className="flex gap-2">
                      <button onClick={() => setEditingId(null)} className="flex-1 rounded-lg border border-gray-200 bg-white py-2 text-sm text-gray-600">やめる</button>
                      <button onClick={() => void saveEdit(item)} disabled={editSaving} className="flex-1 rounded-lg bg-blue-500 py-2 text-sm font-bold text-white disabled:opacity-50">{editSaving ? '保存中...' : '保存'}</button>
                    </div>
                    <button onClick={() => void deleteMovement(item)} disabled={editSaving} className="w-full rounded-lg bg-red-50 py-2 text-xs font-medium text-red-600 disabled:opacity-50">
                      {isTransfer(item.movement_type) ? 'この店舗間移動を取り消す（出・入ともに）' : 'この履歴を取り消す'}
                    </button>
                  </div>
                )}
              </div>
            ))}
            {historyLoading && recent.length === 0 && <p className="py-8 text-center text-sm text-gray-400">読み込み中...</p>}
            {!historyLoading && recent.length === 0 && <p className="py-8 text-center text-sm text-gray-400">該当する履歴はありません</p>}
            {recent.length >= 200 && <p className="pt-3 text-center text-xs text-gray-400">最新200件まで表示しています。店舗・日付・商品名で絞り込んでください。</p>}
          </div>
        </section>
      </div>
    </main>
  )
}

function StoreSelect({ label, stores, value, onChange }: { label: string; stores: Store[]; value: number | null; onChange: (value: number) => void }) {
  return (
    <label className="block text-xs font-medium text-gray-500">{label}
      <select value={value ?? ''} onChange={(event) => onChange(Number(event.target.value))} className="mt-1 block w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-base">
        {stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}
      </select>
    </label>
  )
}

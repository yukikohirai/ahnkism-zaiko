'use client'
import { useEffect, useState, useMemo, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { getCurrentProfile } from '@/lib/auth'
import { supabase } from '@/lib/supabase'

type Store = { id: number; name: string }
type Category = { id: number; name: string; sort_order: number }
type Product = { id: number; category_id: number; brand: string | null; name: string; required_qty: number; dealer: string | null; manufacturer: string | null }
type SessionSummary = { id: string; store_id: number; entry_date: string; status: 'draft' | 'completed'; completed_at: string | null }
type StoreProductSummary = {
  store_id: number
  product_id: number
  opening_stock: number
  required_qty: number
  sort_order: number
  dealer_override: string | null
  product: { id: number; category_id: number; brand: string | null; name: string; dealer: string | null; manufacturer: string | null }
}
type MovementSummary = { store_id: number; product_id: number; quantity: number }
type StoreAssignment = { store_id: number; product_id: number; sort_order: number }
type InventoryMovement = {
  id: string
  store_id: number
  product_id: number
  occurred_on: string
  quantity: number
  movement_type: string
}
type UsageLog = { id: number; store_id: number; product_id: number; date: string; quantity: number; type: string }
type Receipt = { id: number; product_id: number; date: string; quantity: number }
type Balance = { product_id: number; year_month: string; carry_over: number }
const MOVEMENT_META: Record<string, { short: string; label: string; className: string }> = {
  purchase_order: { short: '入', label: '入荷・発注', className: 'bg-emerald-50 text-emerald-700' },
  transfer_in: { short: '移', label: '店舗移動（入）', className: 'bg-purple-50 text-purple-700' },
  transfer_out: { short: '移', label: '店舗移動（出）', className: 'bg-purple-50 text-purple-700' },
  usage: { short: '業', label: '業務利用', className: 'bg-blue-50 text-blue-700' },
  retail_sale: { short: '販', label: '店販販売', className: 'bg-green-50 text-green-700' },
  personal_sale: { short: '個', label: '個人販売', className: 'bg-amber-50 text-amber-700' },
  adjustment: { short: '調', label: '在庫調整', className: 'bg-gray-100 text-gray-700' },
}

const MOVEMENT_ORDER = ['purchase_order', 'transfer_in', 'transfer_out', 'usage', 'retail_sale', 'personal_sale', 'adjustment']
const TYPE_CYCLE: Record<string, string> = { '業務': '店販', '店販': '個人', '個人': '業務' }
const TYPE_COLOR: Record<string, string> = {
  '業務': 'bg-blue-50 text-blue-700',
  '店販': 'bg-green-50 text-green-700',
  '個人': 'bg-amber-50 text-amber-700',
}

function getDays(year: number, month: number) {
  const n = new Date(year, month, 0).getDate()
  return Array.from({ length: n }, (_, i) => i + 1)
}
function toDate(year: number, month: number, day: number) {
  return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`
}
function toYM(year: number, month: number) {
  return `${year}-${String(month).padStart(2,'0')}`
}
function dow(year: number, month: number, d: number) {
  return ['日','月','火','水','木','金','土'][new Date(year, month-1, d).getDay()]
}

function normalizeSearch(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, '')
}

function signedQuantity(quantity: number) {
  return quantity > 0 ? `+${quantity}` : String(quantity)
}

function supplierName(row: Pick<StoreProductSummary, 'dealer_override' | 'product'>) {
  return row.dealer_override || row.product.dealer || row.product.manufacturer || '発注先未設定'
}

function sortBySheetGroups<T>(items: T[], getSupplier: (item: T) => string, getCategoryId: (item: T) => number, getSortOrder: (item: T) => number) {
  const originalOrder = [...items].sort((a, b) => getSortOrder(a) - getSortOrder(b))
  const supplierOrder = new Map<string, number>()
  const categoryOrder = new Map<string, number>()
  originalOrder.forEach((item, index) => {
    const supplier = getSupplier(item)
    const categoryKey = `${supplier}_${getCategoryId(item)}`
    if (!supplierOrder.has(supplier)) supplierOrder.set(supplier, index)
    if (!categoryOrder.has(categoryKey)) categoryOrder.set(categoryKey, index)
  })
  return originalOrder.sort((a, b) => {
    const aSupplier = getSupplier(a)
    const bSupplier = getSupplier(b)
    return (supplierOrder.get(aSupplier) ?? 0) - (supplierOrder.get(bSupplier) ?? 0)
      || (categoryOrder.get(`${aSupplier}_${getCategoryId(a)}`) ?? 0) - (categoryOrder.get(`${bSupplier}_${getCategoryId(b)}`) ?? 0)
      || getSortOrder(a) - getSortOrder(b)
  })
}

function MovementCell({ movements }: { movements: InventoryMovement[] }) {
  const summaries = useMemo(() => {
    const totals = new Map<string, number>()
    movements.forEach((movement) => {
      totals.set(movement.movement_type, (totals.get(movement.movement_type) ?? 0) + movement.quantity)
    })
    return Array.from(totals.entries())
      .filter(([, quantity]) => quantity !== 0)
      .sort(([a], [b]) => {
        const aIndex = MOVEMENT_ORDER.indexOf(a)
        const bIndex = MOVEMENT_ORDER.indexOf(b)
        return (aIndex < 0 ? MOVEMENT_ORDER.length : aIndex) - (bIndex < 0 ? MOVEMENT_ORDER.length : bIndex)
      })
  }, [movements])

  if (summaries.length === 0) return null

  return (
    <div className="flex min-h-7 flex-col justify-center gap-0.5 px-0.5 py-0.5">
      {summaries.map(([type, quantity]) => {
        const meta = MOVEMENT_META[type] ?? { short: '他', label: type, className: 'bg-gray-100 text-gray-700' }
        return (
          <span key={type} title={`${meta.label} ${signedQuantity(quantity)}`} className={`whitespace-nowrap rounded px-0.5 text-[9px] font-bold leading-4 ${meta.className}`}>
            {meta.short}{signedQuantity(quantity)}
          </span>
        )
      })}
    </div>
  )
}

function InventoryHistoryTable({ stores, products, year, month }: { stores: Store[]; products: Product[]; year: number; month: number }) {
  const [movements, setMovements] = useState<InventoryMovement[]>([])
  const [assignments, setAssignments] = useState<StoreAssignment[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selectedStoreId, setSelectedStoreId] = useState<number | 'all'>('all')

  const loadHistory = useCallback(async () => {
    if (products.length === 0) {
      setMovements([])
      setAssignments([])
      return
    }
    setLoading(true)
    setError('')
    const productIds = products.map((product) => product.id)
    const from = toDate(year, month, 1)
    const to = toDate(year, month, getDays(year, month).length)
    const [movementResult, assignmentResult] = await Promise.all([
      supabase.from('inventory_movements')
        .select('id, store_id, product_id, occurred_on, quantity, movement_type')
        .in('product_id', productIds)
        .gte('occurred_on', from)
        .lte('occurred_on', to)
        .order('occurred_on')
        .order('created_at'),
      supabase.from('store_products').select('store_id, product_id, sort_order').in('product_id', productIds),
    ])
    if (movementResult.error || assignmentResult.error) {
      setError('月別履歴を読み込めませんでした。')
    }
    setMovements((movementResult.data ?? []) as InventoryMovement[])
    setAssignments((assignmentResult.data ?? []) as StoreAssignment[])
    setLoading(false)
  }, [month, products, year])

  useEffect(() => { void loadHistory() }, [loadHistory])

  const days = useMemo(() => getDays(year, month), [year, month])
  const movementCellMap = useMemo(() => {
    const map = new Map<string, InventoryMovement[]>()
    movements.forEach((movement) => {
      const key = `${movement.store_id}_${movement.product_id}_${movement.occurred_on}`
      const rows = map.get(key) ?? []
      rows.push(movement)
      map.set(key, rows)
    })
    return map
  }, [movements])
  const monthlyNetMap = useMemo(() => {
    const map = new Map<string, number>()
    movements.forEach((movement) => {
      const key = `${movement.store_id}_${movement.product_id}`
      map.set(key, (map.get(key) ?? 0) + movement.quantity)
    })
    return map
  }, [movements])
  const storeIdsByProduct = useMemo(() => {
    const map = new Map<number, Set<number>>()
    assignments.forEach((assignment) => {
      const storeIds = map.get(assignment.product_id) ?? new Set<number>()
      storeIds.add(assignment.store_id)
      map.set(assignment.product_id, storeIds)
    })
    movements.forEach((movement) => {
      const storeIds = map.get(movement.product_id) ?? new Set<number>()
      storeIds.add(movement.store_id)
      map.set(movement.product_id, storeIds)
    })
    return map
  }, [assignments, movements])
  const visibleStores = selectedStoreId === 'all'
    ? stores
    : stores.filter((store) => store.id === selectedStoreId)
  const assignmentOrderMap = useMemo(() => new Map(
    assignments.map((assignment) => [`${assignment.store_id}_${assignment.product_id}`, assignment.sort_order])
  ), [assignments])
  const historyProducts = useMemo(() => {
    if (selectedStoreId === 'all') return products
    return [...products]
      .filter((product) => storeIdsByProduct.get(product.id)?.has(selectedStoreId))
      .sort((a, b) => (
        (assignmentOrderMap.get(`${selectedStoreId}_${a.id}`) ?? Number.MAX_SAFE_INTEGER)
        - (assignmentOrderMap.get(`${selectedStoreId}_${b.id}`) ?? Number.MAX_SAFE_INTEGER)
      ))
  }, [assignmentOrderMap, products, selectedStoreId, storeIdsByProduct])
  const hasVisibleProducts = historyProducts.some((product) => (
    visibleStores.some((store) => storeIdsByProduct.get(product.id)?.has(store.id))
  ))

  return (
    <section>
      <div className="mx-3 mb-2 mt-5 flex items-end justify-between gap-3">
        <div>
          <h2 className="font-bold text-gray-800">月別の入出庫履歴</h2>
          <p className="text-xs text-gray-400">店舗入力・入荷・店舗移動・販売をすべて同じ表に反映</p>
        </div>
        <button onClick={() => void loadHistory()} className="shrink-0 rounded-lg bg-gray-100 px-3 py-1.5 text-xs text-gray-600">更新</button>
      </div>
      <div className="mx-3 mb-3 flex gap-1 overflow-x-auto pb-1">
        <button onClick={() => setSelectedStoreId('all')}
          className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium ${selectedStoreId === 'all' ? 'bg-blue-500 text-white' : 'bg-gray-100 text-gray-600'}`}>
          全店
        </button>
        {stores.map((store) => (
          <button key={store.id} onClick={() => setSelectedStoreId(store.id)}
            className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium ${selectedStoreId === store.id ? 'bg-blue-500 text-white' : 'bg-gray-100 text-gray-600'}`}>
            {store.name}
          </button>
        ))}
      </div>
      {error && <p className="mx-3 mb-2 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
      {loading ? (
        <p className="py-12 text-center text-sm text-gray-400">月別履歴を読み込み中...</p>
      ) : (
        <div className="overflow-x-auto pb-2">
          <table className="w-max table-fixed border-collapse text-xs">
            <thead>
              <tr className="bg-gray-100">
                <th className="sticky left-0 z-10 w-20 min-w-20 border border-gray-200 bg-gray-100 px-1 py-1.5 text-left">ブランド</th>
                <th className="sticky left-20 z-10 w-40 min-w-40 border border-gray-200 bg-gray-100 px-1 py-1.5 text-left">商品名</th>
                <th className="w-14 min-w-14 border border-gray-200 bg-gray-100 px-1 py-1.5 text-center text-[10px] text-gray-500">店舗</th>
                {days.map((day) => {
                  const dayOfWeek = dow(year, month, day)
                  return (
                    <th key={day} className={`w-14 min-w-14 border border-gray-200 px-0 py-1 text-center ${dayOfWeek === '日' ? 'bg-red-50 text-red-500' : dayOfWeek === '土' ? 'bg-blue-50 text-blue-500' : 'text-gray-500'}`}>
                      <div>{day}</div><div className="text-[9px]">{dayOfWeek}</div>
                    </th>
                  )
                })}
                <th className="w-14 min-w-14 border border-gray-200 bg-yellow-50 px-1 py-1.5 text-center font-bold text-gray-600">月計</th>
              </tr>
            </thead>
            <tbody>
              {historyProducts.flatMap((product, productIndex) => {
                const productStoreIds = storeIdsByProduct.get(product.id) ?? new Set<number>()
                const productStores = visibleStores.filter((store) => productStoreIds.has(store.id))
                const rowBackground = productIndex % 2 === 0 ? 'bg-white' : 'bg-gray-50'
                return productStores.map((store, storeIndex) => {
                  const monthlyNet = monthlyNetMap.get(`${store.id}_${product.id}`) ?? 0
                  return (
                    <tr key={`${product.id}_${store.id}`} className={rowBackground}>
                      <td className={`sticky left-0 z-10 border border-gray-200 px-1 py-1 text-[10px] text-gray-400 ${rowBackground}`}>
                        {storeIndex === 0 ? product.brand ?? '' : ''}
                      </td>
                      <td title={product.name} className={`sticky left-20 z-10 max-w-40 overflow-hidden text-ellipsis whitespace-nowrap border border-gray-200 px-1 py-1 font-medium text-gray-700 ${rowBackground}`}>
                        {storeIndex === 0 ? product.name : ''}
                      </td>
                      <td className="border border-gray-200 bg-gray-50 px-1 py-1 text-center text-[10px] font-medium text-gray-500">{store.name}</td>
                      {days.map((day) => {
                        const date = toDate(year, month, day)
                        const cellMovements = movementCellMap.get(`${store.id}_${product.id}_${date}`) ?? []
                        return <td key={day} className="border border-gray-200 p-0 text-center"><MovementCell movements={cellMovements} /></td>
                      })}
                      <td className={`border border-gray-200 bg-yellow-50 px-1 py-1 text-center font-bold ${monthlyNet > 0 ? 'text-green-700' : monthlyNet < 0 ? 'text-red-600' : 'text-gray-300'}`}>
                        {monthlyNet === 0 ? '−' : signedQuantity(monthlyNet)}
                      </td>
                    </tr>
                  )
                })
              })}
            </tbody>
          </table>
          {products.length > 0 && !hasVisibleProducts && (
            <p className="py-10 text-center text-sm text-gray-400">このカテゴリの取扱商品はありません</p>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-2 px-4 pb-5 pt-3 text-[10px] text-gray-500">
        {MOVEMENT_ORDER.map((type) => {
          const meta = MOVEMENT_META[type]
          return <span key={type} className={`rounded px-1.5 py-0.5 ${meta.className}`}>{meta.short} = {meta.label}</span>
        })}
        <span className="w-full text-gray-400">入出庫の追加は「入出庫」画面から行います。</span>
      </div>
    </section>
  )
}

function HqOverview({ stores, categories }: { stores: Store[]; categories: Category[] }) {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [activeSessionIds, setActiveSessionIds] = useState<Set<string>>(new Set())
  const [assignments, setAssignments] = useState<StoreProductSummary[]>([])
  const [movements, setMovements] = useState<MovementSummary[]>([])
  const [selectedView, setSelectedView] = useState<string>('retail')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [editRequiredKey, setEditRequiredKey] = useState('')
  const [editRequiredValue, setEditRequiredValue] = useState('')

  const todayText = new Date().toLocaleDateString('sv-SE')

  const loadOverview = useCallback(async () => {
    if (stores.length === 0) return
    setLoading(true)
    const [sessionResult, assignmentResult, usageResult] = await Promise.all([
      supabase.from('inventory_sessions')
        .select('id, store_id, entry_date, status, completed_at')
        .eq('entry_date', todayText),
      supabase.from('store_products')
        .select('store_id, product_id, opening_stock, required_qty, sort_order, dealer_override, products!inner(id, category_id, brand, name, dealer, manufacturer)')
        .eq('is_active', true)
        .eq('products.is_active', true),
      supabase.from('inventory_movements')
        .select('store_id, product_id, quantity')
        .order('created_at'),
    ])

    const sessionRows = (sessionResult.data ?? []) as SessionSummary[]
    setSessions(sessionRows)
    const sessionIds = sessionRows.map((session) => session.id)
    if (sessionIds.length > 0) {
      const [itemResult, confirmationResult] = await Promise.all([
        supabase.from('inventory_session_items').select('session_id').in('session_id', sessionIds),
        supabase.from('inventory_session_categories').select('session_id').in('session_id', sessionIds),
      ])
      setActiveSessionIds(new Set([
        ...(itemResult.data ?? []).map((item) => item.session_id),
        ...(confirmationResult.data ?? []).map((item) => item.session_id),
      ]))
    } else {
      setActiveSessionIds(new Set())
    }
    const rows = (assignmentResult.data ?? []).flatMap((row) => {
      const product = Array.isArray(row.products) ? row.products[0] : row.products
      return product ? [{
        store_id: row.store_id,
        product_id: row.product_id,
        opening_stock: row.opening_stock,
        required_qty: row.required_qty,
        sort_order: row.sort_order,
        dealer_override: row.dealer_override,
        product,
      } as StoreProductSummary] : []
    })
    setAssignments(rows)
    setMovements((usageResult.data ?? []) as MovementSummary[])
    setLoading(false)
  }, [stores, todayText])

  useEffect(() => { void loadOverview() }, [loadOverview])

  const movementMap = useMemo(() => {
    const map = new Map<string, number>()
    movements.forEach((item) => {
      const key = `${item.store_id}_${item.product_id}`
      map.set(key, (map.get(key) ?? 0) + item.quantity)
    })
    return map
  }, [movements])

  const currentStock = useCallback((row: StoreProductSummary) => (
    row.opening_stock + (movementMap.get(`${row.store_id}_${row.product_id}`) ?? 0)
  ), [movementMap])

  async function saveStoreRequired(row: StoreProductSummary) {
    const quantity = Math.max(0, parseInt(editRequiredValue) || 0)
    const { error } = await supabase.from('store_products')
      .update({ required_qty: quantity, updated_at: new Date().toISOString() })
      .eq('store_id', row.store_id).eq('product_id', row.product_id)
    if (!error) {
      setAssignments((previous) => previous.map((item) => (
        item.store_id === row.store_id && item.product_id === row.product_id
          ? { ...item, required_qty: quantity }
          : item
      )))
    }
    setEditRequiredKey('')
  }

  const normalizedSearch = normalizeSearch(search)
  const retailCategoryIds = useMemo(() => new Set(
    categories.filter((category) => /店販|オージュア|aujua/i.test(category.name)).map((category) => category.id)
  ), [categories])
  const categoryNameMap = useMemo(() => new Map(categories.map((category) => [category.id, category.name])), [categories])
  const selectedStoreId = selectedView === 'retail' ? null : Number(selectedView)
  const storeRows = useMemo(() => {
    if (selectedStoreId === null) return []
    const filtered = assignments
      .filter((row) => row.store_id === selectedStoreId)
      .filter((row) => !normalizedSearch || normalizeSearch(`${supplierName(row)}${row.product.manufacturer ?? ''}${row.product.brand ?? ''}${row.product.name}`).includes(normalizedSearch))
    return sortBySheetGroups(
      filtered,
      (row) => supplierName(row),
      (row) => row.product.category_id,
      (row) => row.sort_order,
    )
  }, [assignments, normalizedSearch, selectedStoreId])

  const retailRows = useMemo(() => {
    const grouped = new Map<number, { product: StoreProductSummary['product']; rows: StoreProductSummary[] }>()
    assignments.filter((row) => retailCategoryIds.has(row.product.category_id)).forEach((row) => {
      const current = grouped.get(row.product_id) ?? { product: row.product, rows: [] }
      current.rows.push(row)
      grouped.set(row.product_id, current)
    })
    const filtered = Array.from(grouped.values())
      .filter((item) => !normalizedSearch || normalizeSearch(`${item.rows.map((row) => supplierName(row)).join('')}${item.product.manufacturer ?? ''}${item.product.brand ?? ''}${item.product.name}`).includes(normalizedSearch))
    return sortBySheetGroups(
      filtered,
      (item) => supplierName([...item.rows].sort((a, b) => a.sort_order - b.sort_order)[0]),
      (item) => item.product.category_id,
      (item) => Math.min(...item.rows.map((row) => row.sort_order)),
    )
  }, [assignments, normalizedSearch, retailCategoryIds])

  return (
    <section className="mx-3 mt-3 space-y-3">
      <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="font-bold text-gray-800">今日の入力状況</h2>
            <p className="text-xs text-gray-400">{todayText}</p>
          </div>
          <button onClick={() => void loadOverview()} className="rounded-lg bg-gray-100 px-3 py-1.5 text-xs text-gray-600">更新</button>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {stores.map((store) => {
            const storeSessions = sessions.filter((session) => session.store_id === store.id)
            const completedSession = storeSessions.find((session) => session.status === 'completed')
            const draftSession = storeSessions.find((session) => session.status === 'draft' && activeSessionIds.has(session.id))
            const status = completedSession ? '完了' : draftSession ? '下書き' : '未入力'
            const style = completedSession
              ? 'border-green-200 bg-green-50 text-green-700'
              : draftSession
                ? 'border-amber-200 bg-amber-50 text-amber-700'
                : 'border-gray-200 bg-gray-50 text-gray-500'
            return (
              <Link key={store.id} href={`/${store.id}/input`} className={`rounded-xl border p-3 text-center ${style}`}>
                <div className="text-sm font-bold">{store.name}</div>
                <div className="mt-1 text-xs font-medium">{status}</div>
              </Link>
            )
          })}
        </div>
      </div>

      <div className="rounded-2xl border border-gray-200 bg-white shadow-sm">
        <div className="border-b border-gray-100 p-4">
          <h2 className="font-bold text-gray-800">店舗別在庫</h2>
          <p className="mt-0.5 text-xs text-gray-400">開始在庫に使用・入荷・店舗移動を反映して表示</p>
          <div className="mt-3 flex gap-1 overflow-x-auto pb-1">
            <button onClick={() => setSelectedView('retail')}
              className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium ${selectedView === 'retail' ? 'bg-blue-500 text-white' : 'bg-gray-100 text-gray-600'}`}>
              全店 店販・Aujua
            </button>
            {stores.map((store) => (
              <button key={store.id} onClick={() => setSelectedView(String(store.id))}
                className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium ${selectedView === String(store.id) ? 'bg-blue-500 text-white' : 'bg-gray-100 text-gray-600'}`}>
                {store.name}
              </button>
            ))}
          </div>
          <input type="search" value={search} onChange={(event) => setSearch(event.target.value)}
            placeholder="商品名・ブランドで検索"
            className="mt-2 w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm outline-none focus:border-blue-400" />
        </div>

        {loading ? (
          <p className="py-10 text-center text-sm text-gray-400">読み込み中...</p>
        ) : selectedView === 'retail' ? (
          <div className="max-h-[460px] overflow-auto">
            <table className="w-full min-w-[560px] text-xs">
              <thead className="sticky top-0 bg-gray-50 text-gray-500">
                <tr>
                  <th className="px-3 py-2 text-left">商品</th>
                  {stores.map((store) => <th key={store.id} className="px-2 py-2 text-center">{store.name}</th>)}
                  <th className="px-3 py-2 text-center">全店計</th>
                </tr>
              </thead>
              <tbody>
                {retailRows.flatMap((item, index) => {
                  const stockByStore = new Map(item.rows.map((row) => [row.store_id, currentStock(row)]))
                  const total = Array.from(stockByStore.values()).reduce((sum, value) => sum + value, 0)
                  const currentSupplier = supplierName([...item.rows].sort((a, b) => a.sort_order - b.sort_order)[0])
                  const previousItem = retailRows[index - 1]
                  const previousSupplier = previousItem ? supplierName([...previousItem.rows].sort((a, b) => a.sort_order - b.sort_order)[0]) : null
                  const isNewSupplier = currentSupplier !== previousSupplier
                  const isNewCategory = isNewSupplier || item.product.category_id !== previousItem?.product.category_id
                  const rows: React.ReactNode[] = []
                  if (isNewSupplier) {
                    rows.push(
                      <tr key={`${item.product.id}_supplier`} className="bg-slate-100">
                        <td colSpan={stores.length + 2} className="px-3 py-2 text-sm font-bold text-slate-700">{currentSupplier}</td>
                      </tr>
                    )
                  }
                  if (isNewCategory) {
                    rows.push(
                      <tr key={`${item.product.id}_category`} className="bg-slate-50">
                        <td colSpan={stores.length + 2} className="px-3 py-1.5 text-xs font-bold text-slate-500">{categoryNameMap.get(item.product.category_id) ?? 'カテゴリ未設定'}</td>
                      </tr>
                    )
                  }
                  rows.push(
                    <tr key={item.product.id} className="border-t border-gray-100">
                      <td className="px-3 py-2">
                        <div className="text-[10px] text-gray-400">{item.product.brand}</div>
                        <div className="font-medium text-gray-700">{item.product.name}</div>
                      </td>
                      {stores.map((store) => <td key={store.id} className="px-2 py-2 text-center font-medium text-gray-700">{stockByStore.get(store.id) ?? '−'}</td>)}
                      <td className="bg-blue-50 px-3 py-2 text-center font-bold text-blue-700">{total}</td>
                    </tr>
                  )
                  return rows
                })}
              </tbody>
            </table>
            {retailRows.length === 0 && <p className="py-10 text-center text-sm text-gray-400">該当商品がありません</p>}
          </div>
        ) : (
          <div className="max-h-[460px] overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-gray-50 text-gray-500">
                <tr><th className="px-3 py-2 text-left">商品</th><th className="px-2 py-2 text-center">現在庫</th><th className="px-2 py-2 text-center">必要数</th><th className="px-3 py-2 text-center">不足</th></tr>
              </thead>
              <tbody>
                {storeRows.flatMap((row, index) => {
                  const stock = currentStock(row)
                  const shortage = Math.max(0, row.required_qty - stock)
                  const editKey = `${row.store_id}_${row.product_id}`
                  const currentSupplier = supplierName(row)
                  const previousRow = storeRows[index - 1]
                  const previousSupplier = previousRow ? supplierName(previousRow) : null
                  const isNewSupplier = currentSupplier !== previousSupplier
                  const isNewCategory = isNewSupplier || row.product.category_id !== previousRow?.product.category_id
                  const rows: React.ReactNode[] = []
                  if (isNewSupplier) {
                    rows.push(
                      <tr key={`${editKey}_supplier`} className="bg-slate-100">
                        <td colSpan={4} className="px-3 py-2 text-sm font-bold text-slate-700">{currentSupplier}</td>
                      </tr>
                    )
                  }
                  if (isNewCategory) {
                    rows.push(
                      <tr key={`${editKey}_category`} className="bg-slate-50">
                        <td colSpan={4} className="px-3 py-1.5 text-xs font-bold text-slate-500">{categoryNameMap.get(row.product.category_id) ?? 'カテゴリ未設定'}</td>
                      </tr>
                    )
                  }
                  rows.push(
                    <tr key={editKey} className="border-t border-gray-100">
                      <td className="px-3 py-2"><div className="text-[10px] text-gray-400">{row.product.brand}</div><div className="font-medium text-gray-700">{row.product.name}</div></td>
                      <td className={`px-2 py-2 text-center font-bold ${stock < row.required_qty ? 'text-red-600' : 'text-gray-700'}`}>{stock}</td>
                      <td className="px-2 py-2 text-center">
                        {editRequiredKey === editKey ? (
                          <input type="number" min="0" value={editRequiredValue} onChange={(event) => setEditRequiredValue(event.target.value)}
                            onBlur={() => void saveStoreRequired(row)} onKeyDown={(event) => event.key === 'Enter' && void saveStoreRequired(row)}
                            className="w-14 rounded border border-blue-300 px-1 py-1 text-center outline-none" autoFocus />
                        ) : (
                          <button onClick={() => { setEditRequiredKey(editKey); setEditRequiredValue(String(row.required_qty)) }}
                            className="rounded bg-purple-50 px-3 py-1 font-bold text-purple-700">{row.required_qty}</button>
                        )}
                      </td>
                      <td className={`px-3 py-2 text-center font-bold ${shortage > 0 ? 'text-orange-600' : 'text-gray-300'}`}>{shortage > 0 ? shortage : '−'}</td>
                    </tr>
                  )
                  return rows
                })}
              </tbody>
            </table>
            {storeRows.length === 0 && <p className="py-10 text-center text-sm text-gray-400">該当商品がありません</p>}
          </div>
        )}
      </div>
    </section>
  )
}

export default function AdminPage() {
  const router = useRouter()
  const now = new Date()
  const [authorized, setAuthorized] = useState(false)
  const [stores, setStores] = useState<Store[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [logs, setLogs] = useState<UsageLog[]>([])
  const [receipts, setReceipts] = useState<Receipt[]>([])
  const [balances, setBalances] = useState<Balance[]>([])
  const [selectedCat, setSelectedCat] = useState<number | null>(null)
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [closing, setClosing] = useState(false)
  const [closeDone, setCloseDone] = useState(false)
  const [editCell, setEditCell] = useState<string | null>(null)
  const [editVal, setEditVal] = useState('')

  useEffect(() => {
    void authorize()
  }, [])

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

  useEffect(() => {
    if (!authorized) return
    Promise.all([
      supabase.from('stores').select('*').order('sort_order'),
      supabase.from('categories').select('*').order('sort_order'),
    ]).then(([s, c]) => {
      if (s.data) setStores(s.data)
      if (c.data) { setCategories(c.data); setSelectedCat(c.data[0]?.id ?? null) }
    })
  }, [authorized])

  useEffect(() => {
    if (!selectedCat || !authorized) return
    supabase.from('products').select('*').eq('category_id', selectedCat).order('sort_order')
      .then(({ data }) => { if (data) setProducts(data) })
  }, [selectedCat, authorized])

  const loadData = useCallback(() => {
    if (!selectedCat || products.length === 0) return
    const pids = products.map(p => p.id)
    const from = toDate(year, month, 1)
    const to = toDate(year, month, getDays(year, month).length)
    const ym = toYM(year, month)
    Promise.all([
      supabase.from('usage_logs').select('id, store_id, product_id, date, quantity, type')
        .in('product_id', pids).gte('date', from).lte('date', to),
      supabase.from('stock_receipts').select('id, product_id, date, quantity')
        .in('product_id', pids).gte('date', from).lte('date', to),
      supabase.from('monthly_balance').select('product_id, year_month, carry_over')
        .in('product_id', pids).eq('year_month', ym),
    ]).then(([l, r, b]) => {
      if (l.data) setLogs(l.data)
      if (r.data) setReceipts(r.data)
      if (b.data) setBalances(b.data)
    })
  }, [selectedCat, products, year, month])

  useEffect(() => { loadData() }, [loadData])

  const days = useMemo(() => getDays(year, month), [year, month])

  // ログをマップ化
  const logMap = useMemo(() => {
    const m = new Map<string, UsageLog>()
    logs.forEach(l => m.set(`${l.store_id}_${l.product_id}_${l.date}`, l))
    return m
  }, [logs])
  const receiptMap = useMemo(() => {
    const m = new Map<string, Receipt>()
    receipts.forEach(r => m.set(`${r.product_id}_${r.date}`, r))
    return m
  }, [receipts])
  const balanceMap = useMemo(() => {
    const m = new Map<number, number>()
    balances.forEach(b => m.set(b.product_id, b.carry_over))
    return m
  }, [balances])

  // 入庫セルの編集
  async function handleReceiptEdit(productId: number, day: number) {
    const date = toDate(year, month, day)
    const key = `receipt_${productId}_${date}`
    const current = receiptMap.get(`${productId}_${date}`)
    setEditCell(key)
    setEditVal(String(current?.quantity ?? 0))
  }
  async function saveReceipt(productId: number, day: number) {
    const date = toDate(year, month, day)
    const qty = parseInt(editVal) || 0
    await supabase.from('stock_receipts').upsert(
      { product_id: productId, date, quantity: qty, updated_at: new Date().toISOString() },
      { onConflict: 'product_id,date' }
    )
    setEditCell(null)
    loadData()
  }

  // 使用ログの種類変更
  async function cycleType(log: UsageLog) {
    const nextType = TYPE_CYCLE[log.type] || '業務'
    await supabase.from('usage_logs').update({ type: nextType }).eq('id', log.id)
    setLogs(prev => prev.map(l => l.id === log.id ? { ...l, type: nextType } : l))
  }

  // 月締め処理
  async function handleClose() {
    if (!confirm(`${year}年${month}月を締めますか？\n翌月の繰越在庫が計算されます。`)) return
    setClosing(true)
    const ym = toYM(year, month)
    const nextYM = month === 12 ? `${year+1}-01` : `${year}-${String(month+1).padStart(2,'0')}`

    for (const p of products) {
      const carryOver = balanceMap.get(p.id) ?? 0
      const totalIn = receipts.filter(r => r.product_id === p.id).reduce((s, r) => s + r.quantity, 0)
      const totalOut = logs.filter(l => l.product_id === p.id).reduce((s, l) => s + l.quantity, 0)
      const nextCarry = carryOver + totalIn - totalOut
      await supabase.from('monthly_balance').upsert(
        { product_id: p.id, year_month: nextYM, carry_over: nextCarry },
        { onConflict: 'product_id,year_month' }
      )
    }
    setClosing(false)
    setCloseDone(true)
    setTimeout(() => setCloseDone(false), 3000)
  }

  function prevMonth() { if (month === 1) { setYear(y=>y-1); setMonth(12) } else setMonth(m=>m-1) }
  function nextMonth() { if (month === 12) { setYear(y=>y+1); setMonth(1) } else setMonth(m=>m+1) }

  const ym = toYM(year, month)

  if (!authorized) {
    return <div className="flex min-h-screen items-center justify-center text-gray-400">権限を確認しています...</div>
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* ヘッダー */}
      <div className="bg-white border-b sticky top-0 z-20 shadow-sm">
        <div className="px-3 py-2 flex items-center gap-2 flex-wrap">
          <h1 className="text-base font-bold text-gray-800 shrink-0">管理</h1>
          <Link href="/" className="text-xs text-blue-500 shrink-0">← 入力</Link>
          <Link href="/admin/operations" className="rounded bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700 shrink-0">入出庫</Link>
          <Link href="/admin/products" className="rounded bg-purple-50 px-2 py-1 text-xs font-medium text-purple-700 shrink-0">商品管理</Link>
          <div className="flex items-center gap-1">
            <button onClick={prevMonth} className="px-2 py-1 rounded border border-gray-200 text-sm">‹</button>
            <span className="text-sm font-medium px-1">{year}年{month}月</span>
            <button onClick={nextMonth} className="px-2 py-1 rounded border border-gray-200 text-sm">›</button>
          </div>
          <button
            disabled
            title="9月の運用開始までに月締め機能を反映します"
            className="px-2 py-1 bg-gray-200 text-gray-500 rounded text-xs font-medium"
          >
            月締め（9月開始）
          </button>
          <div className="ml-auto flex gap-1 text-xs">
            <span className="px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">業務</span>
            <span className="px-1.5 py-0.5 rounded bg-green-100 text-green-700">店販</span>
            <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">個人</span>
          </div>
        </div>
        {/* カテゴリタブ */}
        <div className="flex overflow-x-auto gap-1 px-3 pb-2">
          {categories.map(cat => (
            <button key={cat.id} onClick={() => setSelectedCat(cat.id)}
              className={`shrink-0 px-3 py-1 rounded-full text-xs font-medium ${selectedCat === cat.id ? 'bg-blue-500 text-white' : 'bg-gray-100 text-gray-600'}`}>
              {cat.name}
            </button>
          ))}
        </div>
      </div>

      <HqOverview stores={stores} categories={categories} />

      <InventoryHistoryTable stores={stores} products={products} year={year} month={month} />

      {/* テーブル */}
      <div className="hidden">
        <h2 className="font-bold text-gray-800">月別使用履歴</h2>
        <p className="text-xs text-gray-400">商品ごとの入庫・店舗使用数を日別に確認</p>
      </div>
      <div className="hidden">
        <table className="text-xs border-collapse" style={{ tableLayout: 'fixed', width: 'max-content' }}>
          <thead>
            <tr className="bg-gray-100">
              <th className="sticky left-0 bg-gray-100 z-10 border border-gray-200 px-1 py-1.5 text-left w-14 min-w-[56px]">ブランド</th>
              <th className="sticky left-14 bg-gray-100 z-10 border border-gray-200 px-1 py-1.5 text-left w-28 min-w-[112px]">品名</th>
              <th className="border border-gray-200 px-1 py-1.5 text-center w-10 min-w-[40px] bg-yellow-50 text-gray-600">繰越</th>
              <th className="border border-gray-200 px-1 py-1.5 text-center w-10 min-w-[40px] bg-purple-50 text-purple-600">必要</th>
              <th className="border border-gray-200 px-1 py-1.5 text-center w-8 min-w-[32px] text-gray-400 text-[10px]">行</th>
              {days.map(d => {
                const w = dow(year, month, d)
                return (
                  <th key={d} className={`border border-gray-200 px-0 py-1 text-center w-8 min-w-[32px] ${w==='日'?'text-red-500 bg-red-50':w==='土'?'text-blue-500 bg-blue-50':'text-gray-500'}`}>
                    <div>{d}</div>
                    <div className="text-[9px]">{w}</div>
                  </th>
                )
              })}
              <th className="border border-gray-200 px-1 py-1.5 text-center w-10 min-w-[40px] bg-yellow-50 font-bold text-gray-600">計</th>
            </tr>
          </thead>
          <tbody>
            {products.map((p, pi) => {
              const carryOver = balanceMap.get(p.id) ?? 0
              const totalIn = receipts.filter(r => r.product_id === p.id).reduce((s,r)=>s+r.quantity,0)
              const rowBg = pi % 2 === 0 ? 'bg-white' : 'bg-gray-50'

              return stores.reduce<React.ReactNode[]>((rows, store, si) => {
                const isFirstRow = si === 0
                const isLastRow = si === stores.length - 1

                // 入庫行（最初の店舗の前）
                if (isFirstRow) {
                  rows.push(
                    <tr key={`${p.id}_receipt`} className={rowBg}>
                      <td className={`sticky left-0 z-10 border border-gray-200 px-1 py-1 text-[10px] text-gray-400 whitespace-nowrap ${rowBg}`}>
                        {pi === 0 || products[pi-1]?.brand !== p.brand ? p.brand ?? '' : ''}
                      </td>
                      <td className={`sticky left-14 z-10 border border-gray-200 px-1 py-1 text-gray-700 font-medium whitespace-nowrap overflow-hidden text-ellipsis max-w-[112px] ${rowBg}`}>
                        {p.name}
                      </td>
                      <td className="border border-gray-200 px-1 py-1 text-center bg-yellow-50 font-medium text-gray-700">
                        {carryOver > 0 ? carryOver : ''}
                      </td>
                      <td className="border border-gray-200 text-center p-0 bg-purple-50">
                        <span className="text-[9px] text-purple-500">店舗別</span>
                      </td>
                      <td className="border border-gray-200 px-1 py-1 text-center bg-gray-100 text-[10px] text-gray-400">入庫</td>
                      {days.map(d => {
                        const date = toDate(year, month, d)
                        const rec = receiptMap.get(`${p.id}_${date}`)
                        const cellKey = `receipt_${p.id}_${date}`
                        return (
                          <td key={d} className="border border-gray-200 text-center p-0">
                            {editCell === cellKey ? (
                              <input
                                type="number"
                                value={editVal}
                                onChange={e => setEditVal(e.target.value)}
                                onBlur={() => saveReceipt(p.id, d)}
                                onKeyDown={e => e.key === 'Enter' && saveReceipt(p.id, d)}
                                className="w-full text-center text-xs py-1 outline-none bg-green-50"
                                autoFocus
                              />
                            ) : (
                              <button
                                disabled
                                title="店舗別の入荷入力画面へ切り替え中です"
                                className={`w-full h-full py-1 px-0 text-center ${rec && rec.quantity > 0 ? 'bg-green-100 text-green-700 font-bold' : 'text-gray-200'}`}
                              >
                                {rec && rec.quantity > 0 ? rec.quantity : ''}
                              </button>
                            )}
                          </td>
                        )
                      })}
                      <td className="border border-gray-200 px-1 py-1 text-center bg-yellow-50 font-bold text-green-700">
                        {totalIn > 0 ? totalIn : ''}
                      </td>
                    </tr>
                  )
                }

                // 店舗の出庫行
                const storeTotal = logs.filter(l => l.store_id === store.id && l.product_id === p.id).reduce((s,l)=>s+l.quantity, 0)
                rows.push(
                  <tr key={`${p.id}_${store.id}`} className={rowBg}>
                    <td className={`sticky left-0 z-10 border border-gray-200 px-1 py-1 ${rowBg}`}></td>
                    <td className={`sticky left-14 z-10 border border-gray-200 px-1 py-1 ${rowBg}`}></td>
                    <td className="border border-gray-200 bg-yellow-50"></td>
                    <td className="border border-gray-200 bg-purple-50"></td>
                    <td className="border border-gray-200 px-1 py-1 text-center bg-gray-50 text-[10px] text-gray-500 whitespace-nowrap">{store.name}</td>
                    {days.map(d => {
                      const date = toDate(year, month, d)
                      const log = logMap.get(`${store.id}_${p.id}_${date}`)
                      if (!log || log.quantity === 0) {
                        return <td key={d} className="border border-gray-200 text-center py-1 text-gray-200"></td>
                      }
                      return (
                        <td key={d} className="border border-gray-200 text-center p-0">
                          <button
                            onClick={() => cycleType(log)}
                            className={`w-full py-1 font-bold text-xs cursor-pointer ${TYPE_COLOR[log.type] || TYPE_COLOR['業務']}`}
                            title={log.type}
                          >
                            {log.quantity}
                          </button>
                        </td>
                      )
                    })}
                    <td className={`border border-gray-200 px-1 py-1 text-center bg-yellow-50 font-bold ${storeTotal > 0 ? 'text-blue-700' : 'text-gray-200'}`}>
                      {storeTotal > 0 ? storeTotal : ''}
                    </td>
                  </tr>
                )

                // 小計行（最後の店舗の後）
                if (isLastRow) {
                  const dayTotals = days.map(d => {
                    const date = toDate(year, month, d)
                    return logs.filter(l => l.product_id === p.id && l.date === date).reduce((s,l)=>s+l.quantity, 0)
                  })
                  const grandTotal = dayTotals.reduce((s,v)=>s+v, 0)
                  rows.push(
                    <tr key={`${p.id}_subtotal`} className="bg-gray-100">
                      <td className={`sticky left-0 z-10 bg-gray-100 border border-gray-200 px-1 py-1`}></td>
                      <td className={`sticky left-14 z-10 bg-gray-100 border border-gray-200 px-1 py-1`}></td>
                      <td className="border border-gray-200 bg-yellow-100"></td>
                      <td className="border border-gray-200 bg-purple-50"></td>
                      <td className="border border-gray-200 px-1 py-1 text-center text-[10px] font-bold text-gray-500 bg-gray-200">合計</td>
                      {dayTotals.map((total, i) => (
                        <td key={i} className={`border border-gray-200 px-1 py-1 text-center font-bold ${total > 0 ? 'text-gray-700 bg-gray-200' : ''}`}>
                          {total > 0 ? total : ''}
                        </td>
                      ))}
                      <td className={`border border-gray-200 px-1 py-1 text-center bg-yellow-100 font-bold ${grandTotal > 0 ? 'text-blue-800' : 'text-gray-300'}`}>
                        {grandTotal > 0 ? grandTotal : ''}
                      </td>
                    </tr>
                  )
                }
                return rows
              }, [])
            })}
          </tbody>
        </table>
      </div>

      {/* 凡例 */}
      <div className="hidden">
        <span>入庫・月締めは店舗別の新画面へ切り替え中です</span>
        <span>数字タップで種類切替：<span className="text-blue-600">業務</span>→<span className="text-green-600">店販</span>→<span className="text-amber-600">個人</span></span>
      </div>
    </div>
  )
}

// ─── 発注リスト ───────────────────────────────────────
type OrderListProps = {
  products: (Product & { dealer: string | null })[]
  balances: Balance[]
  receipts: Receipt[]
  logs: UsageLog[]
  ym: string
}

function OrderList({ products, balances, receipts, logs, ym }: OrderListProps) {
  const [open, setOpen] = useState(true)

  // 現在庫 = 繰越 + 入庫合計 - 出庫合計
  const items = products.map(p => {
    const carryOver = balances.find(b => b.product_id === p.id)?.carry_over ?? 0
    const totalIn = receipts.filter(r => r.product_id === p.id).reduce((s, r) => s + r.quantity, 0)
    const totalOut = logs.filter(l => l.product_id === p.id).reduce((s, l) => s + l.quantity, 0)
    const currentStock = carryOver + totalIn - totalOut
    const orderQty = p.required_qty - currentStock
    return { ...p, currentStock, orderQty }
  }).filter(p => p.orderQty > 0 && p.required_qty > 0)

  // ディーラー別グループ化
  const grouped = items.reduce<Record<string, typeof items>>((acc, p) => {
    const dealer = p.dealer ?? 'その他'
    if (!acc[dealer]) acc[dealer] = []
    acc[dealer].push(p)
    return acc
  }, {})

  const dealerOrder = ['きくや', 'LINE', 'アクティム', '平尾さん', 'Aujua', 'oggi otto', 'マーキス', 'その他']
  const sortedDealers = [
    ...dealerOrder.filter(d => grouped[d]),
    ...Object.keys(grouped).filter(d => !dealerOrder.includes(d)),
  ]

  function copyText() {
    const lines: string[] = [`📋 発注リスト（${ym}）\n`]
    for (const dealer of sortedDealers) {
      lines.push(`【${dealer}】`)
      for (const p of grouped[dealer]) {
        lines.push(`  ${p.brand ? p.brand + ' ' : ''}${p.name}　× ${p.orderQty}`)
      }
      lines.push('')
    }
    navigator.clipboard.writeText(lines.join('\n'))
      .then(() => alert('コピーしました'))
  }

  if (items.length === 0) return (
    <div className="mx-4 my-4 p-4 rounded-xl bg-green-50 border border-green-200 text-sm text-green-700 text-center">
      ✅ 発注が必要な商品はありません
    </div>
  )

  return (
    <div className="mx-4 my-4 rounded-xl border border-orange-200 overflow-hidden">
      {/* ヘッダー */}
      <div
        className="flex items-center justify-between px-4 py-3 bg-orange-50 cursor-pointer"
        onClick={() => setOpen(o => !o)}
      >
        <div className="flex items-center gap-2">
          <span className="text-orange-600 font-bold text-sm">📋 発注リスト</span>
          <span className="bg-orange-500 text-white text-xs font-bold px-2 py-0.5 rounded-full">{items.length}件</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={e => { e.stopPropagation(); copyText() }}
            className="px-3 py-1 bg-orange-500 text-white text-xs rounded-lg font-medium hover:bg-orange-600"
          >
            コピー
          </button>
          <span className="text-gray-400 text-sm">{open ? '▲' : '▼'}</span>
        </div>
      </div>

      {/* リスト本体 */}
      {open && (
        <div className="bg-white divide-y divide-gray-100">
          {sortedDealers.map(dealer => (
            <div key={dealer} className="p-3">
              <div className="text-xs font-bold text-gray-500 mb-2 pb-1 border-b border-gray-100">
                【{dealer}】{grouped[dealer].length}点
              </div>
              <div className="space-y-1">
                {grouped[dealer].map(p => (
                  <div key={p.id} className="flex items-center justify-between text-sm">
                    <div>
                      {p.brand && <span className="text-xs text-gray-400 mr-1">{p.brand}</span>}
                      <span className="text-gray-700">{p.name}</span>
                    </div>
                    <div className="flex items-center gap-3 text-xs shrink-0 ml-2">
                      <span className="text-gray-400">在庫{p.currentStock}</span>
                      <span className="text-gray-400">必要{p.required_qty}</span>
                      <span className="font-bold text-orange-600 bg-orange-50 px-2 py-0.5 rounded">× {p.orderQty}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

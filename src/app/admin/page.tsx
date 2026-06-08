'use client'
import { useEffect, useState, useMemo, useCallback } from 'react'
import { supabase } from '@/lib/supabase'

type Store = { id: number; name: string }
type Category = { id: number; name: string; sort_order: number }
type Product = { id: number; category_id: number; brand: string | null; name: string; required_qty: number; dealer: string | null }
type UsageLog = { id: number; store_id: number; product_id: number; date: string; quantity: number; type: string }
type Receipt = { id: number; product_id: number; date: string; quantity: number }
type Balance = { product_id: number; year_month: string; carry_over: number }

const TYPE_CYCLE: Record<string, string> = { '業務': '店販', '店販': '個人', '個人': '業務' }
const TYPE_COLOR: Record<string, string> = {
  '業務': 'bg-blue-50 text-blue-700',
  '店販': 'bg-green-50 text-green-700',
  '個人': 'bg-amber-50 text-amber-700',
}
const TYPE_LABEL: Record<string, string> = { '業務': '業', '店販': '販', '個人': '個' }

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

export default function AdminPage() {
  const now = new Date()
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
  const [editReqId, setEditReqId] = useState<number | null>(null)
  const [editReqVal, setEditReqVal] = useState('')

  useEffect(() => {
    Promise.all([
      supabase.from('stores').select('*').order('sort_order'),
      supabase.from('categories').select('*').order('sort_order'),
    ]).then(([s, c]) => {
      if (s.data) setStores(s.data)
      if (c.data) { setCategories(c.data); setSelectedCat(c.data[0]?.id ?? null) }
    })
  }, [])

  useEffect(() => {
    if (!selectedCat) return
    supabase.from('products').select('*').eq('category_id', selectedCat).order('sort_order')
      .then(({ data }) => { if (data) setProducts(data) })
  }, [selectedCat])

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

  // 必要数の編集
  async function saveRequiredQty(productId: number) {
    const qty = parseInt(editReqVal) || 0
    await supabase.from('products').update({ required_qty: qty }).eq('id', productId)
    setProducts(prev => prev.map(p => p.id === productId ? { ...p, required_qty: qty } : p))
    setEditReqId(null)
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

  return (
    <div className="min-h-screen bg-gray-50">
      {/* ヘッダー */}
      <div className="bg-white border-b sticky top-0 z-20 shadow-sm">
        <div className="px-3 py-2 flex items-center gap-2 flex-wrap">
          <h1 className="text-base font-bold text-gray-800 shrink-0">管理</h1>
          <a href="/" className="text-xs text-blue-500 shrink-0">← 入力</a>
          <div className="flex items-center gap-1">
            <button onClick={prevMonth} className="px-2 py-1 rounded border border-gray-200 text-sm">‹</button>
            <span className="text-sm font-medium px-1">{year}年{month}月</span>
            <button onClick={nextMonth} className="px-2 py-1 rounded border border-gray-200 text-sm">›</button>
          </div>
          <button
            onClick={handleClose}
            disabled={closing}
            className="px-2 py-1 bg-orange-500 text-white rounded text-xs font-medium hover:bg-orange-600 disabled:opacity-50"
          >
            {closing ? '処理中...' : closeDone ? '✓ 月締め完了' : '月締め'}
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

      {/* テーブル */}
      <div className="overflow-x-auto" style={{ paddingRight: '80vw' }}>
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
                        {editReqId === p.id ? (
                          <input
                            type="number"
                            value={editReqVal}
                            onChange={e => setEditReqVal(e.target.value)}
                            onBlur={() => saveRequiredQty(p.id)}
                            onKeyDown={e => e.key === 'Enter' && saveRequiredQty(p.id)}
                            className="w-full text-center text-xs py-1 outline-none bg-purple-100"
                            autoFocus
                          />
                        ) : (
                          <button
                            onClick={() => { setEditReqId(p.id); setEditReqVal(String(p.required_qty)) }}
                            className={`w-full py-1 px-0 text-center text-xs ${p.required_qty > 0 ? 'text-purple-700 font-bold' : 'text-gray-300 hover:bg-purple-50'}`}
                          >
                            {p.required_qty > 0 ? p.required_qty : '−'}
                          </button>
                        )}
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
                                onClick={() => handleReceiptEdit(p.id, d)}
                                className={`w-full h-full py-1 px-0 text-center ${rec && rec.quantity > 0 ? 'bg-green-100 text-green-700 font-bold' : 'hover:bg-green-50 text-gray-300'}`}
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
      <div className="px-4 pt-3 pb-1 text-xs text-gray-400 flex gap-4">
        <span>🟩 入庫（タップで編集）</span>
        <span>数字タップで種類切替：<span className="text-blue-600">業務</span>→<span className="text-green-600">店販</span>→<span className="text-amber-600">個人</span></span>
      </div>

      {/* 発注リスト */}
      <OrderList products={products} balances={balances} receipts={receipts} logs={logs} ym={ym} />
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

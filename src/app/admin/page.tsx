'use client'
import { useEffect, useState, useMemo } from 'react'
import { supabase } from '@/lib/supabase'

type Store = { id: number; name: string }
type Category = { id: number; name: string; sort_order: number }
type Product = { id: number; category_id: number; brand: string | null; name: string; required_qty: number }
type UsageLog = { product_id: number; date: string; quantity: number }

function getDaysInMonth(year: number, month: number) {
  return new Date(year, month, 0).getDate()
}

function toCSV(products: Product[], logs: UsageLog[], days: number[], year: number, month: number, storeName: string, catName: string) {
  const logMap = new Map(logs.map(l => [`${l.product_id}_${l.date}`, l.quantity]))
  const header = ['ブランド', '品名', ...days.map(d => `${d}日`), '合計'].join(',')
  const rows = products.map(p => {
    const vals = days.map(d => {
      const date = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`
      return logMap.get(`${p.id}_${date}`) ?? 0
    })
    const total = vals.reduce((a, b) => a + b, 0)
    return [p.brand ?? '', p.name, ...vals, total].join(',')
  })
  return [header, ...rows].join('\n')
}

export default function AdminPage() {
  const now = new Date()
  const [stores, setStores] = useState<Store[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [logs, setLogs] = useState<UsageLog[]>([])
  const [selectedStore, setSelectedStore] = useState<number | null>(null)
  const [selectedCat, setSelectedCat] = useState<number | null>(null)
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [loading, setLoading] = useState(false)

  // マスタ読み込み
  useEffect(() => {
    Promise.all([
      supabase.from('stores').select('*').order('sort_order'),
      supabase.from('categories').select('*').order('sort_order'),
    ]).then(([s, c]) => {
      if (s.data) { setStores(s.data); setSelectedStore(s.data[0]?.id ?? null) }
      if (c.data) { setCategories(c.data); setSelectedCat(c.data[0]?.id ?? null) }
    })
  }, [])

  // 商品読み込み
  useEffect(() => {
    if (!selectedCat) return
    supabase.from('products').select('*').eq('category_id', selectedCat).order('sort_order')
      .then(({ data }) => { if (data) setProducts(data) })
  }, [selectedCat])

  // 使用ログ読み込み
  useEffect(() => {
    if (!selectedStore || !selectedCat || products.length === 0) return
    setLoading(true)
    const from = `${year}-${String(month).padStart(2,'0')}-01`
    const to = `${year}-${String(month).padStart(2,'0')}-${getDaysInMonth(year, month)}`
    supabase.from('usage_logs')
      .select('product_id, date, quantity')
      .eq('store_id', selectedStore)
      .in('product_id', products.map(p => p.id))
      .gte('date', from)
      .lte('date', to)
      .then(({ data }) => {
        if (data) setLogs(data)
        setLoading(false)
      })
  }, [selectedStore, selectedCat, products, year, month])

  const days = useMemo(() => {
    const n = getDaysInMonth(year, month)
    return Array.from({ length: n }, (_, i) => i + 1)
  }, [year, month])

  const logMap = useMemo(() => {
    const m = new Map<string, number>()
    logs.forEach(l => m.set(`${l.product_id}_${l.date}`, l.quantity))
    return m
  }, [logs])

  const dayOfWeek = (d: number) => {
    const w = new Date(year, month - 1, d).getDay()
    return ['日','月','火','水','木','金','土'][w]
  }

  function getCell(productId: number, day: number) {
    const date = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`
    return logMap.get(`${productId}_${date}`) ?? 0
  }

  function getRowTotal(productId: number) {
    return days.reduce((sum, d) => sum + getCell(productId, d), 0)
  }

  function prevMonth() {
    if (month === 1) { setYear(y => y - 1); setMonth(12) }
    else setMonth(m => m - 1)
  }
  function nextMonth() {
    if (month === 12) { setYear(y => y + 1); setMonth(1) }
    else setMonth(m => m + 1)
  }

  function downloadCSV() {
    const store = stores.find(s => s.id === selectedStore)
    const cat = categories.find(c => c.id === selectedCat)
    const csv = toCSV(products, logs, days, year, month, store?.name ?? '', cat?.name ?? '')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `在庫使用数_${store?.name}_${year}${String(month).padStart(2,'0')}.csv`
    a.click()
  }

  const currentCat = categories.find(c => c.id === selectedCat)

  return (
    <div className="min-h-screen bg-gray-50">
      {/* ヘッダー */}
      <div className="bg-white border-b sticky top-0 z-20 shadow-sm">
        <div className="px-4 py-3 flex items-center gap-3 flex-wrap">
          <h1 className="text-lg font-bold text-gray-800 shrink-0">管理ページ</h1>
          <a href="/" className="text-sm text-blue-500 hover:underline shrink-0">← 入力へ</a>

          {/* 店舗選択 */}
          <select
            value={selectedStore ?? ''}
            onChange={e => setSelectedStore(Number(e.target.value))}
            className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-white font-medium"
          >
            {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>

          {/* 月選択 */}
          <div className="flex items-center gap-1">
            <button onClick={prevMonth} className="px-2 py-1.5 rounded-lg border border-gray-200 text-sm hover:bg-gray-50">‹</button>
            <span className="text-sm font-medium px-2">{year}年{month}月</span>
            <button onClick={nextMonth} className="px-2 py-1.5 rounded-lg border border-gray-200 text-sm hover:bg-gray-50">›</button>
          </div>

          <button onClick={downloadCSV} className="ml-auto px-3 py-1.5 bg-green-500 text-white rounded-lg text-sm font-medium hover:bg-green-600 shrink-0">
            CSV
          </button>
        </div>

        {/* カテゴリタブ */}
        <div className="flex overflow-x-auto gap-1 px-4 pb-2">
          {categories.map(cat => (
            <button
              key={cat.id}
              onClick={() => setSelectedCat(cat.id)}
              className={`shrink-0 px-3 py-1.5 rounded-full text-sm font-medium transition-all ${
                selectedCat === cat.id ? 'bg-blue-500 text-white' : 'bg-gray-100 text-gray-600'
              }`}
            >
              {cat.name}
            </button>
          ))}
        </div>
      </div>

      {/* テーブル */}
      <div className="overflow-x-auto">
        <table className="text-sm border-collapse min-w-max">
          <thead>
            <tr className="bg-gray-100 sticky top-[89px] z-10">
              <th className="sticky left-0 bg-gray-100 z-20 border border-gray-200 px-2 py-2 text-left text-xs text-gray-500 whitespace-nowrap min-w-[72px]">ブランド</th>
              <th className="sticky left-[72px] bg-gray-100 z-20 border border-gray-200 px-2 py-2 text-left text-xs text-gray-500 whitespace-nowrap min-w-[160px]">品名</th>
              {days.map(d => {
                const dow = dayOfWeek(d)
                const isSun = dow === '日'
                const isSat = dow === '土'
                return (
                  <th key={d} className={`border border-gray-200 px-2 py-1 text-center text-xs min-w-[36px] ${isSun ? 'text-red-500 bg-red-50' : isSat ? 'text-blue-500 bg-blue-50' : 'text-gray-500'}`}>
                    <div>{d}</div>
                    <div className="text-[10px]">{dow}</div>
                  </th>
                )
              })}
              <th className="border border-gray-200 px-2 py-2 text-center text-xs text-gray-600 font-bold min-w-[44px] bg-yellow-50">合計</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={days.length + 3} className="text-center text-gray-400 py-8">読み込み中...</td>
              </tr>
            ) : products.length === 0 ? (
              <tr>
                <td colSpan={days.length + 3} className="text-center text-gray-400 py-8">商品データがありません</td>
              </tr>
            ) : (
              products.map((p, idx) => {
                const total = getRowTotal(p.id)
                return (
                  <tr key={p.id} className={idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                    <td className={`sticky left-0 z-10 border border-gray-200 px-2 py-1.5 text-xs text-gray-400 whitespace-nowrap ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}>
                      {p.brand}
                    </td>
                    <td className={`sticky left-[72px] z-10 border border-gray-200 px-2 py-1.5 text-xs text-gray-700 whitespace-nowrap ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}>
                      {p.name}
                    </td>
                    {days.map(d => {
                      const val = getCell(p.id, d)
                      const dow = dayOfWeek(d)
                      return (
                        <td key={d} className={`border border-gray-200 px-1 py-1.5 text-center text-sm ${
                          val > 0 ? 'font-bold text-blue-600 bg-blue-50' :
                          dow === '日' ? 'bg-red-50/30' :
                          dow === '土' ? 'bg-blue-50/30' : ''
                        }`}>
                          {val > 0 ? val : ''}
                        </td>
                      )
                    })}
                    <td className={`border border-gray-200 px-2 py-1.5 text-center text-sm font-bold ${total > 0 ? 'text-blue-700 bg-yellow-50' : 'bg-yellow-50 text-gray-300'}`}>
                      {total > 0 ? total : ''}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

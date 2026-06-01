'use client'
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'

type Row = {
  id: number
  date: string
  store_name: string
  category_name: string
  brand: string | null
  product_name: string
  quantity: number
}

function toCSV(rows: Row[]) {
  const header = '日付,店舗,カテゴリ,ブランド,品番,使用数'
  const lines = rows.map((r) =>
    [r.date, r.store_name, r.category_name, r.brand ?? '', r.product_name, r.quantity].join(',')
  )
  return [header, ...lines].join('\n')
}

export default function AdminPage() {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [filterStore, setFilterStore] = useState('')
  const [filterDate, setFilterDate] = useState('')
  const [stores, setStores] = useState<string[]>([])

  useEffect(() => {
    supabase
      .from('usage_logs')
      .select(`
        id, date, quantity,
        stores ( name ),
        products ( brand, name, categories ( name ) )
      `)
      .order('date', { ascending: false })
      .limit(1000)
      .then(({ data }) => {
        if (data) {
          const mapped: Row[] = data.map((d: any) => ({
            id: d.id,
            date: d.date,
            store_name: d.stores?.name ?? '',
            category_name: d.products?.categories?.name ?? '',
            brand: d.products?.brand ?? null,
            product_name: d.products?.name ?? '',
            quantity: d.quantity,
          }))
          setRows(mapped)
          setStores([...new Set(mapped.map((r) => r.store_name))])
        }
        setLoading(false)
      })
  }, [])

  const filtered = rows.filter((r) => {
    if (filterStore && r.store_name !== filterStore) return false
    if (filterDate && r.date !== filterDate) return false
    return true
  })

  function downloadCSV() {
    const csv = toCSV(filtered)
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `在庫使用数_${new Date().toLocaleDateString('sv-SE')}.csv`
    a.click()
  }

  return (
    <div className="max-w-5xl mx-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">管理ダッシュボード</h1>
          <a href="/" className="text-sm text-blue-500 hover:underline">← 店舗入力へ</a>
        </div>
        <button
          onClick={downloadCSV}
          className="px-4 py-2 bg-green-500 text-white rounded-lg text-sm font-medium hover:bg-green-600"
        >
          CSVダウンロード
        </button>
      </div>

      {/* フィルター */}
      <div className="flex gap-3 mb-4 flex-wrap">
        <select
          value={filterStore}
          onChange={(e) => setFilterStore(e.target.value)}
          className="border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-700 bg-white"
        >
          <option value="">全店舗</option>
          {stores.map((s) => <option key={s}>{s}</option>)}
        </select>
        <input
          type="date"
          value={filterDate}
          onChange={(e) => setFilterDate(e.target.value)}
          className="border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-700 bg-white"
        />
        {(filterStore || filterDate) && (
          <button
            onClick={() => { setFilterStore(''); setFilterDate('') }}
            className="text-sm text-gray-400 hover:text-gray-600"
          >
            クリア
          </button>
        )}
        <span className="ml-auto text-sm text-gray-400 self-center">{filtered.length} 件</span>
      </div>

      {loading ? (
        <p className="text-center text-gray-400 py-12">読み込み中...</p>
      ) : (
        <div className="bg-white rounded-xl shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-500">
                <tr>
                  <th className="text-left px-4 py-3 font-medium">日付</th>
                  <th className="text-left px-4 py-3 font-medium">店舗</th>
                  <th className="text-left px-4 py-3 font-medium">カテゴリ</th>
                  <th className="text-left px-4 py-3 font-medium">ブランド</th>
                  <th className="text-left px-4 py-3 font-medium">品番</th>
                  <th className="text-right px-4 py-3 font-medium">使用数</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={6} className="text-center text-gray-400 py-12">データがありません</td>
                  </tr>
                )}
                {filtered.map((r) => (
                  <tr key={r.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-gray-600">{r.date}</td>
                    <td className="px-4 py-3 font-medium">{r.store_name}</td>
                    <td className="px-4 py-3 text-gray-500">{r.category_name}</td>
                    <td className="px-4 py-3 text-gray-400 text-xs">{r.brand}</td>
                    <td className="px-4 py-3">{r.product_name}</td>
                    <td className="px-4 py-3 text-right font-bold text-blue-600">{r.quantity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

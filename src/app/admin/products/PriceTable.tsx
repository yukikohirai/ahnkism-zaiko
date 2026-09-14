'use client'

import { useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { withTax, withoutTax } from '@/lib/tax'

type Category = { id: number; name: string }
type PriceProduct = {
  id: number
  category_id: number
  brand: string | null
  name: string
  cost_price: number | null
  sale_price: number | null
  product_type: 'material' | 'retail'
}

function normalizeSearch(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, '')
}

export default function PriceTable({ categories }: { categories: Category[] }) {
  const [products, setProducts] = useState<PriceProduct[]>([])
  const [categoryId, setCategoryId] = useState<number | 'all'>('all')
  const [search, setSearch] = useState('')
  const [taxIncluded, setTaxIncluded] = useState(false)
  const [onlyMissing, setOnlyMissing] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [savingKey, setSavingKey] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    void (async () => {
      const { data, error: loadError } = await supabase.from('products')
        .select('id, category_id, brand, name, cost_price, sale_price, product_type')
        .eq('is_active', true)
        .order('sort_order')
        .limit(5000)
      if (loadError) setError('商品を読み込めませんでした。')
      setProducts((data ?? []) as PriceProduct[])
    })()
  }, [])

  const categoryOrder = useMemo(() => new Map(categories.map((category, index) => [category.id, index])), [categories])
  const visible = useMemo(() => {
    const keyword = normalizeSearch(search)
    return products
      .filter((product) => categoryId === 'all' || product.category_id === categoryId)
      .filter((product) => !keyword || normalizeSearch(`${product.brand ?? ''}${product.name}`).includes(keyword))
      .filter((product) => !onlyMissing || product.cost_price === null || (product.product_type === 'retail' && product.sale_price === null))
      .sort((a, b) => (categoryOrder.get(a.category_id) ?? 999) - (categoryOrder.get(b.category_id) ?? 999))
  }, [categoryId, categoryOrder, onlyMissing, products, search])
  const missingCount = products.filter((product) => product.cost_price === null).length

  function shown(amount: number | null) {
    if (amount === null) return ''
    return String(taxIncluded ? withTax(amount) : amount)
  }

  async function savePrice(product: PriceProduct, field: 'cost_price' | 'sale_price') {
    const key = `${product.id}_${field}`
    const raw = drafts[key]
    if (raw === undefined) return
    const trimmed = raw.replace(/[,，¥円\s]/g, '')
    let value: number | null = null
    if (trimmed !== '') {
      const parsed = Number(trimmed)
      if (!Number.isFinite(parsed) || parsed < 0) {
        setError('価格は0以上の数字で入力してください。')
        return
      }
      value = taxIncluded ? withoutTax(parsed) : Math.round(parsed)
    }
    if (value === product[field]) {
      setDrafts((previous) => { const next = { ...previous }; delete next[key]; return next })
      return
    }
    setSavingKey(key)
    setError('')
    const { error: saveError } = await supabase.from('products').update({ [field]: value }).eq('id', product.id)
    setSavingKey('')
    if (saveError) {
      setError(`保存できませんでした：${saveError.message}`)
      return
    }
    setProducts((previous) => previous.map((item) => item.id === product.id ? { ...item, [field]: value } : item))
    setDrafts((previous) => { const next = { ...previous }; delete next[key]; return next })
  }

  async function saveType(product: PriceProduct, type: 'material' | 'retail') {
    setSavingKey(`${product.id}_type`)
    const { error: saveError } = await supabase.from('products').update({ product_type: type }).eq('id', product.id)
    setSavingKey('')
    if (saveError) {
      setError(`保存できませんでした：${saveError.message}`)
      return
    }
    setProducts((previous) => previous.map((item) => item.id === product.id ? { ...item, product_type: type } : item))
  }

  const categoryName = new Map(categories.map((category) => [category.id, category.name]))

  return (
    <section className="mb-4 rounded-2xl border border-emerald-100 bg-white p-4 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-bold text-gray-800">価格をまとめて入力</h2>
          <p className="text-xs text-gray-400">入力欄から離れると自動で保存します。仕入れ値が未入力の商品：{missingCount}件</p>
        </div>
        <div className="flex rounded-lg bg-gray-100 p-0.5 text-xs font-medium">
          <button onClick={() => { setTaxIncluded(false); setDrafts({}) }} className={`rounded-md px-3 py-1.5 ${!taxIncluded ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500'}`}>税抜</button>
          <button onClick={() => { setTaxIncluded(true); setDrafts({}) }} className={`rounded-md px-3 py-1.5 ${taxIncluded ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500'}`}>税込</button>
        </div>
      </div>
      <div className="mb-3 grid gap-2 sm:grid-cols-3">
        <select value={categoryId} onChange={(event) => setCategoryId(event.target.value === 'all' ? 'all' : Number(event.target.value))}
          className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-base">
          <option value="all">全カテゴリ</option>
          {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
        </select>
        <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="商品名・ブランドで検索"
          className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-base outline-none focus:border-blue-400" />
        <label className="flex items-center gap-2 rounded-xl bg-gray-50 px-3 py-2 text-sm text-gray-600">
          <input type="checkbox" checked={onlyMissing} onChange={(event) => setOnlyMissing(event.target.checked)} className="h-4 w-4" />
          未入力だけ表示
        </label>
      </div>
      {taxIncluded && <p className="mb-2 rounded-lg bg-amber-50 px-3 py-1.5 text-xs text-amber-700">税込で表示・入力中です。保存は税抜（÷1.1・四捨五入）で行います。</p>}
      {error && <p className="mb-2 rounded-lg bg-red-50 px-3 py-1.5 text-sm text-red-600">{error}</p>}
      <div className="max-h-[60vh] overflow-auto rounded-xl border border-gray-100">
        <table className="w-full min-w-[560px] text-xs">
          <thead className="sticky top-0 z-10 bg-gray-50 text-gray-500">
            <tr>
              <th className="px-3 py-2 text-left">商品</th>
              <th className="w-24 px-2 py-2 text-center">区分</th>
              <th className="w-28 px-2 py-2 text-center">仕入れ値</th>
              <th className="w-28 px-2 py-2 text-center">販売価格</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((product) => (
              <tr key={product.id} className="border-t border-gray-100">
                <td className="px-3 py-1.5">
                  <div className="text-[10px] text-gray-400">{categoryName.get(product.category_id)}・{product.brand}</div>
                  <div className="break-words font-medium text-gray-700">{product.name}</div>
                </td>
                <td className="px-2 py-1.5 text-center">
                  <select value={product.product_type} disabled={savingKey === `${product.id}_type`}
                    onChange={(event) => void saveType(product, event.target.value as 'material' | 'retail')}
                    className={`w-full rounded-lg border px-1 py-1.5 text-base ${product.product_type === 'retail' ? 'border-green-200 bg-green-50 text-green-700' : 'border-blue-200 bg-blue-50 text-blue-700'}`}>
                    <option value="material">業務用</option>
                    <option value="retail">店販用</option>
                  </select>
                </td>
                {(['cost_price', 'sale_price'] as const).map((field) => {
                  const key = `${product.id}_${field}`
                  return (
                    <td key={field} className="px-2 py-1.5">
                      <input inputMode="numeric" value={drafts[key] ?? shown(product[field])} placeholder="未入力"
                        onChange={(event) => setDrafts((previous) => ({ ...previous, [key]: event.target.value }))}
                        onBlur={() => void savePrice(product, field)}
                        onKeyDown={(event) => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur() }}
                        className={`w-full rounded-lg border px-2 py-1.5 text-right text-base outline-none focus:border-blue-400 ${savingKey === key ? 'border-blue-300 bg-blue-50' : product[field] === null ? 'border-amber-200 bg-amber-50/40' : 'border-gray-200'}`} />
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {visible.length === 0 && <p className="py-8 text-center text-sm text-gray-400">該当する商品がありません</p>}
      </div>
    </section>
  )
}

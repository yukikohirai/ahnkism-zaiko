'use client'

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { fetchAll } from '@/lib/fetchAll'
import GenreManager from './GenreManager'
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
  genre_id: number | null
}
type Genre = { id: number; name: string }
type Store = { id: number; name: string }
type Assignment = { store_id: number; product_id: number; sort_order: number }

function normalizeSearch(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, '')
}

export default function PriceTable({ categories }: { categories: Category[] }) {
  const [products, setProducts] = useState<PriceProduct[]>([])
  const [categoryId, setCategoryId] = useState<number | 'all'>('all')
  const [search, setSearch] = useState('')
  const [taxIncluded, setTaxIncluded] = useState(false)
  const [onlyMissing, setOnlyMissing] = useState(false)
  const [onlyNoGenre, setOnlyNoGenre] = useState(false)
  const [genres, setGenres] = useState<Genre[]>([])
  const [stores, setStores] = useState<Store[]>([])
  const [assignments, setAssignments] = useState<Assignment[]>([])
  const [storeView, setStoreView] = useState<string>('')
  const [showGenres, setShowGenres] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [bulkGenre, setBulkGenre] = useState('')
  const [bulkSaving, setBulkSaving] = useState(false)
  const [bulkMessage, setBulkMessage] = useState('')

  // ジャンルを追加・名称変更・削除したら、表の選択肢と商品の割り当てを読み直す
  const reloadGenres = useCallback(async () => {
    const [genreResult, productResult] = await Promise.all([
      supabase.from('product_genres').select('id, name').order('sort_order').order('id'),
      fetchAll((start, end) => supabase.from('products').select('id, genre_id').eq('is_active', true).order('id').range(start, end)),
    ])
    if (genreResult.data) setGenres(genreResult.data as Genre[])
    if (productResult.data) {
      const genreById = new Map((productResult.data as { id: number; genre_id: number | null }[]).map((row) => [row.id, row.genre_id]))
      setProducts((previous) => previous.map((item) => genreById.has(item.id) ? { ...item, genre_id: genreById.get(item.id) ?? null } : item))
    }
  }, [])
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [savingKey, setSavingKey] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    void (async () => {
      const { data, error: loadError } = await fetchAll((start, end) => supabase.from('products')
        .select('id, category_id, brand, name, cost_price, sale_price, product_type, genre_id')
        .eq('is_active', true)
        .order('sort_order').order('id')
        .range(start, end))
      const [genreResult, storeResult, assignmentResult] = await Promise.all([
        supabase.from('product_genres').select('id, name').order('sort_order').order('id'),
        supabase.from('stores').select('id, name').order('sort_order'),
        fetchAll((start, end) => supabase.from('store_products').select('store_id, product_id, sort_order')
          .eq('is_active', true).order('store_id').order('product_id').range(start, end)),
      ])
      if (loadError || genreResult.error || storeResult.error || assignmentResult.error) setError('商品を読み込めませんでした。')
      setProducts((data ?? []) as PriceProduct[])
      setGenres((genreResult.data ?? []) as Genre[])
      const nextStores = (storeResult.data ?? []) as Store[]
      setStores(nextStores)
      setStoreView((current) => current || String(nextStores[0]?.id ?? 'all'))
      setAssignments((assignmentResult.data ?? []) as Assignment[])
    })()
  }, [])

  const categoryOrder = useMemo(() => new Map(categories.map((category, index) => [category.id, index])), [categories])
  // 並びは入荷・店舗入力と同じ：カテゴリ順 → その店舗の並び順。
  // 「全店」は LABO→nit→elu の順に最初に取り扱っている店舗の並びを使う
  const storeSort = useMemo(() => {
    const storeIndex = new Map(stores.map((store, index) => [store.id, index]))
    const map = new Map<number, { rank: number; sort: number }>()
    assignments.forEach((row) => {
      if (storeView !== 'all' && String(row.store_id) !== storeView) return
      const rank = storeIndex.get(row.store_id) ?? 999
      const current = map.get(row.product_id)
      if (!current || rank < current.rank) map.set(row.product_id, { rank, sort: row.sort_order })
    })
    return map
  }, [assignments, storeView, stores])
  const visible = useMemo(() => {
    const keyword = normalizeSearch(search)
    return products
      .filter((product) => storeView === 'all' || storeSort.has(product.id))
      .filter((product) => categoryId === 'all' || product.category_id === categoryId)
      .filter((product) => !keyword || normalizeSearch(`${product.brand ?? ''}${product.name}`).includes(keyword))
      .filter((product) => !onlyMissing || product.cost_price === null || (product.product_type === 'retail' && product.sale_price === null))
      .filter((product) => !onlyNoGenre || product.genre_id === null)
      .sort((a, b) => (categoryOrder.get(a.category_id) ?? 999) - (categoryOrder.get(b.category_id) ?? 999)
        || (storeSort.get(a.id)?.rank ?? 999) - (storeSort.get(b.id)?.rank ?? 999)
        || (storeSort.get(a.id)?.sort ?? Number.MAX_SAFE_INTEGER) - (storeSort.get(b.id)?.sort ?? Number.MAX_SAFE_INTEGER)
        || a.id - b.id)
  }, [categoryId, categoryOrder, onlyMissing, onlyNoGenre, products, search, storeSort, storeView])
  const noGenreCount = products.filter((product) => product.genre_id === null).length

  // チェックした商品のジャンルをまとめて設定する
  async function applyBulkGenre() {
    const ids = Array.from(selected)
    if (ids.length === 0 || bulkGenre === '') return
    const genreId = bulkGenre === 'none' ? null : Number(bulkGenre)
    const label = genreId === null ? '未分類' : genres.find((genre) => genre.id === genreId)?.name
    if (!confirm(`チェックした${ids.length}件のジャンルを「${label}」にします。よろしいですか？`)) return
    setBulkSaving(true)
    setError('')
    setBulkMessage('')
    for (let start = 0; start < ids.length; start += 200) {
      const { error: saveError } = await supabase.from('products').update({ genre_id: genreId }).in('id', ids.slice(start, start + 200))
      if (saveError) {
        setBulkSaving(false)
        setError(`保存できませんでした：${saveError.message}`)
        return
      }
    }
    const idSet = new Set(ids)
    setProducts((previous) => previous.map((item) => idSet.has(item.id) ? { ...item, genre_id: genreId } : item))
    setSelected(new Set())
    setBulkSaving(false)
    setBulkMessage(`${ids.length}件を「${label}」にしました。`)
  }

  function toggle(id: number) {
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function saveGenre(product: PriceProduct, value: string) {
    const genreId = value === '' ? null : Number(value)
    setSavingKey(`${product.id}_genre`)
    const { error: saveError } = await supabase.from('products').update({ genre_id: genreId }).eq('id', product.id)
    setSavingKey('')
    if (saveError) {
      setError(`保存できませんでした：${saveError.message}`)
      return
    }
    setProducts((previous) => previous.map((item) => item.id === product.id ? { ...item, genre_id: genreId } : item))
  }
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
          <p className="text-xs text-gray-400">入力欄から離れると自動で保存します。仕入れ値が未入力：{missingCount}件／ジャンル未設定：{noGenreCount}件</p>
        </div>
        <div className="flex rounded-lg bg-gray-100 p-0.5 text-xs font-medium">
          <button onClick={() => { setTaxIncluded(false); setDrafts({}) }} className={`rounded-md px-3 py-1.5 ${!taxIncluded ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500'}`}>税抜</button>
          <button onClick={() => { setTaxIncluded(true); setDrafts({}) }} className={`rounded-md px-3 py-1.5 ${taxIncluded ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500'}`}>税込</button>
        </div>
      </div>
      <div className="mb-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-gray-600">ジャンル：{genres.map((genre) => genre.name).join('・') || 'なし'}</span>
          <button onClick={() => setShowGenres((value) => !value)} className="shrink-0 rounded-lg bg-white px-3 py-1.5 text-xs font-bold text-slate-700 shadow-sm">
            {showGenres ? '閉じる' : 'ジャンルの追加・編集・削除'}
          </button>
        </div>
        {showGenres && <div className="mt-3"><GenreManager onChanged={reloadGenres} /></div>}
      </div>
      <div className="mb-2 flex gap-1 overflow-x-auto">
        {stores.map((store) => (
          <button key={store.id} onClick={() => setStoreView(String(store.id))}
            className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-bold ${storeView === String(store.id) ? 'bg-blue-500 text-white' : 'bg-gray-100 text-gray-600'}`}>{store.name}の並び</button>
        ))}
        <button onClick={() => setStoreView('all')}
          className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-bold ${storeView === 'all' ? 'bg-blue-500 text-white' : 'bg-gray-100 text-gray-600'}`}>全商品</button>
      </div>
      <p className="mb-2 text-[11px] text-gray-400">{storeView === 'all' ? '全店の商品を表示（LABO→nit→elu の並びを優先）' : 'この店舗の取扱商品を、入荷・店舗入力と同じ並びで表示'}。価格は全店共通です。</p>
      <div className="mb-3 grid gap-2 sm:grid-cols-4">
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
        <label className="flex items-center gap-2 rounded-xl bg-gray-50 px-3 py-2 text-sm text-gray-600">
          <input type="checkbox" checked={onlyNoGenre} onChange={(event) => setOnlyNoGenre(event.target.checked)} className="h-4 w-4" />
          ジャンル未設定だけ
        </label>
      </div>
      {taxIncluded && <p className="mb-2 rounded-lg bg-amber-50 px-3 py-1.5 text-xs text-amber-700">税込で表示・入力中です。保存は税抜（÷1.1・四捨五入）で行います。</p>}
      {error && <p className="mb-2 rounded-lg bg-red-50 px-3 py-1.5 text-sm text-red-600">{error}</p>}
      <div className="mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-blue-100 bg-blue-50/60 px-3 py-2 text-xs text-gray-700">
        <span className="font-bold">まとめて設定</span>
        <span>チェック {selected.size}件</span>
        <button onClick={() => setSelected(new Set(visible.map((product) => product.id)))} className="rounded-lg bg-white px-2.5 py-1.5 font-medium text-blue-700 shadow-sm">表示中をすべてチェック（{visible.length}件）</button>
        <button onClick={() => setSelected(new Set())} disabled={selected.size === 0} className="rounded-lg bg-white px-2.5 py-1.5 text-gray-600 shadow-sm disabled:opacity-40">チェックを外す</button>
        <span className="ml-auto flex items-center gap-2">
          ジャンルを
          <select value={bulkGenre} onChange={(event) => setBulkGenre(event.target.value)} className="rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-base">
            <option value="">選ぶ</option>
            {genres.map((genre) => <option key={genre.id} value={genre.id}>{genre.name}</option>)}
            <option value="none">未分類に戻す</option>
          </select>
          に
          <button onClick={() => void applyBulkGenre()} disabled={bulkSaving || selected.size === 0 || bulkGenre === ''}
            className="rounded-lg bg-blue-500 px-3 py-1.5 font-bold text-white disabled:opacity-40">{bulkSaving ? '設定中...' : 'まとめて設定'}</button>
        </span>
      </div>
      {bulkMessage && <p className="mb-2 rounded-lg bg-green-50 px-3 py-1.5 text-sm text-green-700">{bulkMessage}</p>}
      <div className="max-h-[60vh] overflow-auto rounded-xl border border-gray-100">
        <table className="w-full min-w-[720px] text-xs">
          <thead className="sticky top-0 z-10 bg-gray-50 text-gray-500">
            <tr>
              <th className="w-8 px-2 py-2 text-center">
                <input type="checkbox" aria-label="表示中をすべて選択" className="h-4 w-4"
                  checked={visible.length > 0 && visible.every((product) => selected.has(product.id))}
                  onChange={(event) => setSelected(event.target.checked ? new Set(visible.map((product) => product.id)) : new Set())} />
              </th>
              <th className="px-3 py-2 text-left">商品</th>
              <th className="w-24 px-2 py-2 text-center">区分</th>
              <th className="w-28 px-2 py-2 text-center">ジャンル</th>
              <th className="w-28 px-2 py-2 text-center">仕入れ値</th>
              <th className="w-28 px-2 py-2 text-center">販売価格</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((product, index) => (
              <Fragment key={product.id}>
              {product.category_id !== visible[index - 1]?.category_id && (
                <tr>
                  <td colSpan={6} className="sticky top-8 z-[5] bg-slate-100 px-3 py-1.5 text-xs font-bold text-slate-600">{categoryName.get(product.category_id)}</td>
                </tr>
              )}
              <tr className="border-t border-gray-100">
                <td className="px-2 py-1.5 text-center">
                  <input type="checkbox" checked={selected.has(product.id)} onChange={() => toggle(product.id)} className="h-4 w-4" />
                </td>
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
                <td className="px-2 py-1.5 text-center">
                  <select value={product.genre_id ?? ''} disabled={savingKey === `${product.id}_genre`}
                    onChange={(event) => void saveGenre(product, event.target.value)}
                    className={`w-full rounded-lg border px-1 py-1.5 text-base ${product.genre_id === null ? 'border-amber-200 bg-amber-50 text-amber-700' : 'border-gray-200 bg-white text-gray-700'}`}>
                    <option value="">未分類</option>
                    {genres.map((genre) => <option key={genre.id} value={genre.id}>{genre.name}</option>)}
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
              </Fragment>
            ))}
          </tbody>
        </table>
        {visible.length === 0 && <p className="py-8 text-center text-sm text-gray-400">該当する商品がありません</p>}
      </div>
    </section>
  )
}

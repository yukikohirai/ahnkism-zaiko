'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getCurrentProfile } from '@/lib/auth'
import { supabase } from '@/lib/supabase'

type Store = { id: number; name: string }
type Category = { id: number; name: string }
type Product = {
  id: number
  category_id: number
  dealer: string | null
  manufacturer: string | null
  brand: string | null
  name: string
  is_active: boolean
}

function normalizeSearch(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, '')
}

export default function ProductManagementPage() {
  const router = useRouter()
  const [authorized, setAuthorized] = useState(false)
  const [stores, setStores] = useState<Store[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [search, setSearch] = useState('')
  const [showStopped, setShowStopped] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [dealer, setDealer] = useState('')
  const [manufacturer, setManufacturer] = useState('')
  const [brand, setBrand] = useState('')
  const [name, setName] = useState('')
  const [categoryId, setCategoryId] = useState<number | null>(null)
  const [selectedStores, setSelectedStores] = useState<Set<number>>(new Set())
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
    const [storeResult, categoryResult, productResult] = await Promise.all([
      supabase.from('stores').select('id, name').order('sort_order'),
      supabase.from('categories').select('id, name').order('sort_order'),
      supabase.from('products').select('id, category_id, dealer, manufacturer, brand, name, is_active').order('sort_order'),
    ])
    const nextStores = (storeResult.data ?? []) as Store[]
    const nextCategories = (categoryResult.data ?? []) as Category[]
    setStores(nextStores)
    setCategories(nextCategories)
    setProducts((productResult.data ?? []) as Product[])
    setCategoryId((current) => current ?? nextCategories[0]?.id ?? null)
    setSelectedStores((current) => current.size > 0 ? current : new Set(nextStores.map((store) => store.id)))
  }, [authorized])

  useEffect(() => { void loadData() }, [loadData])

  const filteredProducts = useMemo(() => {
    const normalized = normalizeSearch(search)
    return products
      .filter((product) => showStopped ? !product.is_active : product.is_active)
      .filter((product) => !normalized || normalizeSearch(`${product.dealer ?? ''}${product.manufacturer ?? ''}${product.brand ?? ''}${product.name}`).includes(normalized))
  }, [products, search, showStopped])

  function toggleStore(storeId: number) {
    setSelectedStores((previous) => {
      const next = new Set(previous)
      if (next.has(storeId)) next.delete(storeId)
      else next.add(storeId)
      return next
    })
  }

  async function addProduct() {
    if (!categoryId || !name.trim() || selectedStores.size === 0) {
      setError('カテゴリ・商品名・取扱店舗を確認してください。')
      return
    }
    const duplicateKey = normalizeSearch(`${brand}${name}`)
    if (products.some((product) => normalizeSearch(`${product.brand ?? ''}${product.name}`) === duplicateKey)) {
      setError('同じブランド・商品名がすでに登録されています。既存商品を確認してください。')
      return
    }
    setSaving(true)
    setError('')
    setMessage('')
    const maxSort = products.length > 0 ? Math.max(...products.map((product) => product.id)) + 1 : 1
    const { data: created, error: productError } = await supabase.from('products').insert({
      category_id: categoryId,
      dealer: dealer.trim() || null,
      manufacturer: manufacturer.trim() || null,
      brand: brand.trim() || null,
      name: name.trim(),
      required_qty: 0,
      sort_order: maxSort,
      is_active: true,
    }).select('id').single()
    if (productError || !created) {
      setError(productError?.message ?? '商品を追加できませんでした。')
      setSaving(false)
      return
    }
    const { error: assignmentError } = await supabase.from('store_products').insert(
      Array.from(selectedStores).map((storeId, index) => ({
        store_id: storeId,
        product_id: created.id,
        is_active: true,
        required_qty: 0,
        opening_stock: 0,
        sort_order: maxSort + index,
      }))
    )
    if (assignmentError) {
      await supabase.from('products').update({ is_active: false }).eq('id', created.id)
      setError(`店舗への取扱設定に失敗したため、商品を停止状態で保存しました。${assignmentError.message}`)
      setSaving(false)
      await loadData()
      return
    }
    setDealer('')
    setManufacturer('')
    setBrand('')
    setName('')
    setShowForm(false)
    setMessage('商品を追加しました。必要数は店舗別在庫画面で設定できます。')
    setSaving(false)
    await loadData()
  }

  async function setActive(product: Product, active: boolean) {
    const action = active ? '再開' : '停止'
    if (!confirm(`${product.brand ? `${product.brand} ` : ''}${product.name}を${action}しますか？\n過去の履歴は残ります。`)) return
    const { error: updateError } = await supabase.from('products').update({ is_active: active }).eq('id', product.id)
    if (updateError) setError(updateError.message)
    else {
      setMessage(`商品を${action}しました。`)
      setProducts((previous) => previous.map((item) => item.id === product.id ? { ...item, is_active: active } : item))
    }
  }

  if (!authorized) return <div className="flex min-h-[100dvh] items-center justify-center text-gray-400">権限を確認しています...</div>

  return (
    <main className="min-h-[100dvh] bg-gray-50 pb-16">
      <header className="sticky top-0 z-20 border-b bg-white px-4 py-3 shadow-sm">
        <div className="mx-auto flex max-w-3xl items-center justify-between">
          <div><h1 className="font-bold text-gray-800">商品管理</h1><p className="text-xs text-gray-400">共通商品マスタ・本部専用</p></div>
          <Link href="/admin" className="rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-600">管理へ戻る</Link>
        </div>
      </header>

      <div className="mx-auto max-w-3xl p-4">
        {message && <p className="mb-3 rounded-xl bg-green-50 px-3 py-2 text-sm text-green-700">{message}</p>}
        {error && <p className="mb-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

        <button onClick={() => { setShowForm((value) => !value); setError(''); setMessage('') }} className="mb-3 w-full rounded-xl bg-blue-500 py-3 font-bold text-white">
          {showForm ? '追加フォームを閉じる' : '＋ 新しい商品を追加'}
        </button>

        {showForm && (
          <section className="mb-4 rounded-2xl border border-blue-100 bg-white p-4 shadow-sm">
            <h2 className="mb-3 font-bold text-gray-800">商品を追加</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField label="ディーラー" value={dealer} onChange={setDealer} placeholder="例：きくや" />
              <TextField label="メーカー" value={manufacturer} onChange={setManufacturer} placeholder="例：ミルボン" />
              <TextField label="ブランド" value={brand} onChange={setBrand} placeholder="例：Aujua" />
              <TextField label="商品名（必須）" value={name} onChange={setName} placeholder="容量・色番まで入力" />
            </div>
            <label className="mt-3 block text-xs font-medium text-gray-500">カテゴリ
              <select value={categoryId ?? ''} onChange={(event) => setCategoryId(Number(event.target.value))} className="mt-1 block w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm">
                {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
              </select>
            </label>
            <fieldset className="mt-3"><legend className="text-xs font-medium text-gray-500">取扱店舗</legend>
              <div className="mt-1 grid grid-cols-3 gap-2">
                {stores.map((store) => (
                  <label key={store.id} className={`flex items-center justify-center gap-2 rounded-xl border px-2 py-2.5 text-sm ${selectedStores.has(store.id) ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-gray-200 text-gray-500'}`}>
                    <input type="checkbox" checked={selectedStores.has(store.id)} onChange={() => toggleStore(store.id)} />{store.name}
                  </label>
                ))}
              </div>
            </fieldset>
            <p className="mt-3 text-xs text-gray-400">追加時の開始在庫・必要数は0です。追加後、店舗別在庫画面で必要数を設定してください。</p>
            <button onClick={() => void addProduct()} disabled={saving} className="mt-4 w-full rounded-xl bg-blue-500 py-3 font-bold text-white disabled:opacity-50">{saving ? '追加中...' : '商品を追加'}</button>
          </section>
        )}

        <section className="rounded-2xl border border-gray-200 bg-white shadow-sm">
          <div className="border-b border-gray-100 p-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-bold text-gray-800">{showStopped ? '停止中の商品' : '取扱中の商品'}</h2>
              <button onClick={() => setShowStopped((value) => !value)} className="rounded-lg bg-gray-100 px-3 py-1.5 text-xs text-gray-600">{showStopped ? '取扱中を見る' : '停止中を見る'}</button>
            </div>
            <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="ディーラー・メーカー・ブランド・商品名で検索" className="mt-3 w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm outline-none focus:border-blue-400" />
          </div>
          <div className="max-h-[600px] divide-y divide-gray-100 overflow-y-auto">
            {filteredProducts.map((product) => (
              <div key={product.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="text-[10px] text-gray-400">{product.dealer || 'ディーラー未設定'}／{product.manufacturer || 'メーカー未設定'}</div>
                  <div className="text-xs text-gray-500">{product.brand}</div>
                  <div className="truncate font-medium text-gray-800">{product.name}</div>
                </div>
                <button onClick={() => void setActive(product, !product.is_active)} className={`shrink-0 rounded-lg px-3 py-2 text-xs font-medium ${product.is_active ? 'bg-red-50 text-red-600' : 'bg-green-50 text-green-700'}`}>{product.is_active ? '停止' : '再開'}</button>
              </div>
            ))}
            {filteredProducts.length === 0 && <p className="py-10 text-center text-sm text-gray-400">該当商品がありません</p>}
          </div>
        </section>
      </div>
    </main>
  )
}

function TextField({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder: string }) {
  return (
    <label className="block text-xs font-medium text-gray-500">{label}
      <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className="mt-1 block w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-blue-400" />
    </label>
  )
}

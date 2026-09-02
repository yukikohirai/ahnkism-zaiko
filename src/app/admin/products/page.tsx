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

type SortRow = { product_id: number; sort_order: number; name: string; brand: string | null }

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
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editDealer, setEditDealer] = useState('')
  const [editManufacturer, setEditManufacturer] = useState('')
  const [editBrand, setEditBrand] = useState('')
  const [editName, setEditName] = useState('')
  const [editCategoryId, setEditCategoryId] = useState<number | null>(null)
  const [editNewCategory, setEditNewCategory] = useState('')
  const [newCategory, setNewCategory] = useState('')
  const [sortStoreId, setSortStoreId] = useState<number | null>(null)
  const [sortCategoryId, setSortCategoryId] = useState<number | null>(null)
  const [sortRows, setSortRows] = useState<SortRow[]>([])
  const [sortLoading, setSortLoading] = useState(false)
  const [sortDirty, setSortDirty] = useState(false)

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
    setSortStoreId((current) => current ?? nextStores[0]?.id ?? null)
    setSortCategoryId((current) => current ?? nextCategories[0]?.id ?? null)
    setSelectedStores((current) => current.size > 0 ? current : new Set(nextStores.map((store) => store.id)))
  }, [authorized])

  useEffect(() => { void loadData() }, [loadData])

  const filteredProducts = useMemo(() => {
    const normalized = normalizeSearch(search)
    return products
      .filter((product) => showStopped ? !product.is_active : product.is_active)
      .filter((product) => !normalized || normalizeSearch(`${product.dealer ?? ''}${product.manufacturer ?? ''}${product.brand ?? ''}${product.name}`).includes(normalized))
  }, [products, search, showStopped])

  const dealerOptions = useMemo(() => uniqueValues(products.map((product) => product.dealer)), [products])
  const manufacturerOptions = useMemo(() => uniqueValues(products.map((product) => product.manufacturer)), [products])
  const brandOptions = useMemo(() => uniqueValues(products.map((product) => product.brand)), [products])

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
    const resolvedCategoryId = await resolveCategoryId(categoryId, newCategory)
    if (!resolvedCategoryId) {
      setSaving(false)
      return
    }
    const maxSort = products.length > 0 ? Math.max(...products.map((product) => product.id)) + 1 : 1
    const { data: created, error: productError } = await supabase.from('products').insert({
      category_id: resolvedCategoryId,
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
    setNewCategory('')
    setShowForm(false)
    setMessage('商品を追加しました。必要数は店舗別在庫画面で設定できます。')
    setSaving(false)
    await loadData()
  }

  async function resolveCategoryId(selectedId: number | null, newName: string): Promise<number | null> {
    const trimmed = newName.trim()
    if (!trimmed) return selectedId
    const existing = categories.find((category) => normalizeSearch(category.name) === normalizeSearch(trimmed))
    if (existing) return existing.id
    const maxSort = categories.length > 0 ? categories.length + 1 : 1
    const { data, error: categoryError } = await supabase
      .from('categories')
      .insert({ name: trimmed, sort_order: maxSort })
      .select('id, name')
      .single()
    if (categoryError || !data) {
      setError(categoryError?.message ?? 'カテゴリを追加できませんでした。')
      return null
    }
    setCategories((previous) => [...previous, data as Category])
    return data.id
  }

  function startEdit(product: Product) {
    setEditingId(product.id)
    setEditDealer(product.dealer ?? '')
    setEditManufacturer(product.manufacturer ?? '')
    setEditBrand(product.brand ?? '')
    setEditName(product.name)
    setEditCategoryId(product.category_id)
    setEditNewCategory('')
    setError('')
    setMessage('')
  }

  async function saveEdit(product: Product) {
    const trimmedName = editName.trim()
    if (!trimmedName) {
      setError('商品名を入力してください。')
      return
    }
    const duplicateKey = normalizeSearch(`${editBrand.trim()}${trimmedName}`)
    if (products.some((item) => item.id !== product.id && normalizeSearch(`${item.brand ?? ''}${item.name}`) === duplicateKey)) {
      setError('同じブランド・商品名の商品がすでにあります。')
      return
    }
    setSaving(true)
    setError('')
    const resolvedCategoryId = await resolveCategoryId(editCategoryId, editNewCategory)
    if (!resolvedCategoryId) {
      setSaving(false)
      if (!error) setError('カテゴリを確認してください。')
      return
    }
    const patch = {
      dealer: editDealer.trim() || null,
      manufacturer: editManufacturer.trim() || null,
      brand: editBrand.trim() || null,
      name: trimmedName,
      category_id: resolvedCategoryId,
    }
    const { error: updateError } = await supabase.from('products').update(patch).eq('id', product.id)
    setSaving(false)
    if (updateError) {
      setError(updateError.message)
      return
    }
    setProducts((previous) => previous.map((item) => item.id === product.id ? { ...item, ...patch } : item))
    setEditingId(null)
    setEditNewCategory('')
    setMessage(resolvedCategoryId !== product.category_id
      ? 'カテゴリを変更しました。店舗の入力画面では別のタブに移動します。'
      : '商品情報を更新しました。在庫・必要数・履歴はそのままです。')
  }

  const loadSortRows = useCallback(async () => {
    if (!sortStoreId || !sortCategoryId) {
      setSortRows([])
      return
    }
    setSortLoading(true)
    setSortDirty(false)
    const { data } = await supabase
      .from('store_products')
      .select('product_id, sort_order, products!inner(name, brand, is_active, category_id)')
      .eq('store_id', sortStoreId)
      .eq('is_active', true)
      .eq('products.category_id', sortCategoryId)
      .eq('products.is_active', true)
      .order('sort_order')
    const rows = (data ?? []).flatMap((row) => {
      const product = Array.isArray(row.products) ? row.products[0] : row.products
      return product ? [{ product_id: row.product_id, sort_order: row.sort_order, name: product.name as string, brand: (product.brand ?? null) as string | null }] : []
    })
    setSortRows(rows)
    setSortLoading(false)
  }, [sortStoreId, sortCategoryId])

  useEffect(() => { void loadSortRows() }, [loadSortRows])

  function moveRow(index: number, direction: -1 | 1) {
    const target = index + direction
    if (target < 0 || target >= sortRows.length) return
    setSortRows((previous) => {
      const next = [...previous]
      const [moved] = next.splice(index, 1)
      next.splice(target, 0, moved)
      return next
    })
    setSortDirty(true)
  }

  async function saveOrder() {
    if (!sortStoreId || sortRows.length === 0) return
    setSaving(true)
    setError('')
    // 元々使われていた並び番号を、新しい順番に振り直す（他カテゴリと衝突しない）
    const slots = sortRows.map((row) => row.sort_order).sort((a, b) => a - b)
    const updates = sortRows
      .map((row, index) => ({ row, slot: slots[index] }))
      .filter(({ row, slot }) => row.sort_order !== slot)
    for (const { row, slot } of updates) {
      const { error: updateError } = await supabase
        .from('store_products')
        .update({ sort_order: slot })
        .eq('store_id', sortStoreId)
        .eq('product_id', row.product_id)
      if (updateError) {
        setError(updateError.message)
        setSaving(false)
        return
      }
    }
    setSaving(false)
    setSortDirty(false)
    setMessage(`並び順を保存しました。（${updates.length}件を変更）`)
    await loadSortRows()
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
              <PickField label="発注先" value={dealer} onChange={setDealer} options={dealerOptions} placeholder="例：きくや" />
              <PickField label="メーカー" value={manufacturer} onChange={setManufacturer} options={manufacturerOptions} placeholder="例：ミルボン" />
              <PickField label="ブランド" value={brand} onChange={setBrand} options={brandOptions} placeholder="例：Aujua" />
              <TextField label="商品名（必須）" value={name} onChange={setName} placeholder="容量・色番まで入力" />
            </div>
            <div className="mt-3">
              <CategoryField label="カテゴリ" categories={categories} selectedId={categoryId} onSelect={setCategoryId} newName={newCategory} onNewName={setNewCategory} />
            </div>
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

        <section className="mb-4 rounded-2xl border border-gray-200 bg-white shadow-sm">
          <div className="border-b border-gray-100 p-4">
            <h2 className="font-bold text-gray-800">並び替え</h2>
            <p className="mt-0.5 text-xs text-gray-400">店舗の入力画面に出てくる順番を変えます。店舗ごと・カテゴリごとに設定します。</p>
            <div className="mt-3 flex gap-2">
              <select value={sortStoreId ?? ''} onChange={(event) => setSortStoreId(Number(event.target.value))} className="flex-1 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm">
                {stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}
              </select>
              <select value={sortCategoryId ?? ''} onChange={(event) => setSortCategoryId(Number(event.target.value))} className="flex-1 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm">
                {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
              </select>
            </div>
            {sortDirty && (
              <button onClick={() => void saveOrder()} disabled={saving} className="mt-3 w-full rounded-xl bg-blue-500 py-3 text-sm font-bold text-white disabled:opacity-50">
                {saving ? '保存中...' : 'この並び順を保存する'}
              </button>
            )}
          </div>
          <div className="max-h-[400px] divide-y divide-gray-100 overflow-y-auto">
            {sortLoading && <p className="py-8 text-center text-sm text-gray-400">読み込み中...</p>}
            {!sortLoading && sortRows.length === 0 && <p className="py-8 text-center text-sm text-gray-400">この店舗・カテゴリの商品がありません</p>}
            {!sortLoading && sortRows.map((row, index) => (
              <div key={row.product_id} className="flex items-center gap-3 px-4 py-2.5">
                <span className="w-6 shrink-0 text-xs text-gray-300">{index + 1}</span>
                <div className="min-w-0 flex-1">
                  {row.brand && <div className="text-xs text-gray-400">{row.brand}</div>}
                  <div className="text-sm leading-snug break-words text-gray-800">{row.name}</div>
                </div>
                <div className="flex shrink-0 gap-1">
                  <button onClick={() => moveRow(index, -1)} disabled={index === 0} className="h-9 w-9 rounded-lg bg-gray-100 text-gray-600 disabled:opacity-30">↑</button>
                  <button onClick={() => moveRow(index, 1)} disabled={index === sortRows.length - 1} className="h-9 w-9 rounded-lg bg-gray-100 text-gray-600 disabled:opacity-30">↓</button>
                </div>
              </div>
            ))}
          </div>
        </section>

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
              <div key={product.id} className="px-4 py-3">
                {editingId === product.id ? (
                  <div className="space-y-2">
                    <PickField key={`dealer-${product.id}`} label="発注先" value={editDealer} onChange={setEditDealer} options={dealerOptions} placeholder="きくや など" />
                    <PickField key={`maker-${product.id}`} label="メーカー" value={editManufacturer} onChange={setEditManufacturer} options={manufacturerOptions} placeholder="メーカー名" />
                    <PickField key={`brand-${product.id}`} label="ブランド" value={editBrand} onChange={setEditBrand} options={brandOptions} placeholder="ブランド名" />
                    <TextField label="商品名" value={editName} onChange={setEditName} placeholder="商品名" />
                    <CategoryField key={`cat-${product.id}`} label="カテゴリ" categories={categories} selectedId={editCategoryId} onSelect={setEditCategoryId} newName={editNewCategory} onNewName={setEditNewCategory} />
                    {editCategoryId !== product.category_id && (
                      <p className="text-[11px] text-amber-600">カテゴリを変えると、店舗の入力画面では別のタブに移動します。</p>
                    )}
                    <div className="flex gap-2 pt-1">
                      <button onClick={() => setEditingId(null)} className="flex-1 rounded-xl border border-gray-200 py-2.5 text-sm text-gray-600">やめる</button>
                      <button onClick={() => void saveEdit(product)} disabled={saving} className="flex-1 rounded-xl bg-blue-500 py-2.5 text-sm font-bold text-white disabled:opacity-50">{saving ? '保存中...' : '保存'}</button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-[10px] text-gray-400">{product.dealer || 'ディーラー未設定'}／{product.manufacturer || 'メーカー未設定'}</div>
                      <div className="text-xs text-gray-500">{product.brand}</div>
                      <div className="font-medium leading-snug break-words text-gray-800">{product.name}</div>
                    </div>
                    <div className="flex shrink-0 flex-col gap-1.5">
                      <button onClick={() => startEdit(product)} className="rounded-lg bg-blue-50 px-3 py-2 text-xs font-medium text-blue-700">編集</button>
                      <button onClick={() => void setActive(product, !product.is_active)} className={`rounded-lg px-3 py-2 text-xs font-medium ${product.is_active ? 'bg-red-50 text-red-600' : 'bg-green-50 text-green-700'}`}>{product.is_active ? '停止' : '再開'}</button>
                    </div>
                  </div>
                )}
              </div>
            ))}
            {filteredProducts.length === 0 && <p className="py-10 text-center text-sm text-gray-400">該当商品がありません</p>}
          </div>
        </section>
      </div>
    </main>
  )
}

function uniqueValues(values: (string | null)[]) {
  const seen = new Map<string, string>()
  for (const value of values) {
    const trimmed = (value ?? '').trim()
    if (!trimmed) continue
    const key = normalizeSearch(trimmed)
    if (!seen.has(key)) seen.set(key, trimmed)
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, 'ja'))
}

function PickField({ label, value, onChange, options, placeholder }: { label: string; value: string; onChange: (value: string) => void; options: string[]; placeholder: string }) {
  const [creating, setCreating] = useState(() => value.trim() !== '' && !options.includes(value.trim()))
  const clash = creating ? options.find((option) => normalizeSearch(option) === normalizeSearch(value) && option !== value.trim()) : undefined

  if (creating) {
    return (
      <label className="block text-xs font-medium text-gray-500">{label}
        <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} autoFocus className="mt-1 block w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-blue-400" />
        {clash && <span className="mt-1 block text-[11px] font-normal text-amber-600">「{clash}」とほぼ同じです。表記ゆれになるので、一覧から選び直すことをおすすめします。</span>}
        <button type="button" onClick={() => { setCreating(false); onChange('') }} className="mt-1 text-[11px] font-normal text-blue-600 underline">一覧から選ぶ</button>
      </label>
    )
  }

  return (
    <label className="block text-xs font-medium text-gray-500">{label}
      <select
        value={options.includes(value.trim()) ? value.trim() : ''}
        onChange={(event) => {
          if (event.target.value === '__new__') { setCreating(true); onChange('') }
          else onChange(event.target.value)
        }}
        className="mt-1 block w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm"
      >
        <option value="">（未設定）</option>
        {options.map((option) => <option key={option} value={option}>{option}</option>)}
        <option value="__new__">＋ 新しく作る</option>
      </select>
    </label>
  )
}

function CategoryField({ label, categories, selectedId, onSelect, newName, onNewName }: { label: string; categories: Category[]; selectedId: number | null; onSelect: (id: number | null) => void; newName: string; onNewName: (value: string) => void }) {
  const creating = newName !== '' || selectedId === null
  const clash = newName.trim() ? categories.find((category) => normalizeSearch(category.name) === normalizeSearch(newName)) : undefined

  return (
    <label className="block text-xs font-medium text-gray-500">{label}
      <select
        value={creating ? '__new__' : String(selectedId)}
        onChange={(event) => {
          if (event.target.value === '__new__') { onSelect(null); onNewName(' ') }
          else { onNewName(''); onSelect(Number(event.target.value)) }
        }}
        className="mt-1 block w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm"
      >
        {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
        <option value="__new__">＋ 新しく作る</option>
      </select>
      {creating && (
        <>
          <input value={newName.trimStart()} onChange={(event) => onNewName(event.target.value)} placeholder="新しいカテゴリ名" autoFocus className="mt-2 block w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-blue-400" />
          {clash
            ? <span className="mt-1 block text-[11px] font-normal text-amber-600">「{clash.name}」がすでにあります。保存するとそちらにまとめられます。</span>
            : <span className="mt-1 block text-[11px] font-normal text-gray-400">新しいカテゴリは一番後ろに追加されます。</span>}
        </>
      )}
    </label>
  )
}

function TextField({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder: string }) {
  return (
    <label className="block text-xs font-medium text-gray-500">{label}
      <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className="mt-1 block w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-blue-400" />
    </label>
  )
}

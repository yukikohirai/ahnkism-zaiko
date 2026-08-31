'use client'
import { useEffect, useMemo, useState, use } from 'react'
import { useRouter } from 'next/navigation'
import { getCurrentProfile, type UserProfile } from '@/lib/auth'
import { supabase, type Store, type Category, type Product } from '@/lib/supabase'

type ProductWithQty = Product & { qty: number }
type RecentUsage = { product_id: number; date: string; quantity: number }
type InventorySession = { id: string; store_id: number; entry_date: string; status: 'draft' | 'completed' }

function today() {
  return new Date().toLocaleDateString('sv-SE')
}

function normalizeSearch(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, '')
}

export default function InputPage({ params }: { params: Promise<{ storeId: string }> }) {
  const { storeId } = use(params)
  const router = useRouter()
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [store, setStore] = useState<Store | null>(null)
  const [categories, setCategories] = useState<Category[]>([])
  const [activeCat, setActiveCat] = useState<number | null>(null)
  const [products, setProducts] = useState<ProductWithQty[]>([])
  const [productCatalog, setProductCatalog] = useState<Product[]>([])
  const [session, setSession] = useState<InventorySession | null>(null)
  const [draftLoaded, setDraftLoaded] = useState(false)
  const [draftQuantities, setDraftQuantities] = useState<Map<number, number>>(new Map())
  const [confirmedCategories, setConfirmedCategories] = useState<Set<number>>(new Set())
  const [recentUsage, setRecentUsage] = useState<RecentUsage[]>([])
  const [search, setSearch] = useState('')
  const [date, setDate] = useState(today())
  const [saving, setSaving] = useState(false)
  const [pendingWrites, setPendingWrites] = useState(0)
  const [completed, setCompleted] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [showConfirm, setShowConfirm] = useState(false)

  useEffect(() => {
    void authorize()
  }, [storeId])

  async function authorize() {
    const currentProfile = await getCurrentProfile()
    if (!currentProfile) {
      router.replace('/')
      return
    }
    if (currentProfile.role === 'store' && currentProfile.store_id !== Number(storeId)) {
      router.replace(`/${currentProfile.store_id}/input`)
      return
    }
    setProfile(currentProfile)
  }

  useEffect(() => {
    if (!profile) return
    void loadStoreAndDraft()
  }, [storeId, profile])

  async function loadStoreAndDraft() {
    setDraftLoaded(false)
    const [storeResult, categoryResult, assignmentResult] = await Promise.all([
      supabase.from('stores').select('*').eq('id', storeId).single(),
      supabase.from('categories').select('*').order('sort_order'),
      supabase
        .from('store_products')
        .select('products!inner(id, category_id, brand, name, required_qty, sort_order)')
        .eq('store_id', Number(storeId))
        .eq('is_active', true)
        .eq('products.is_active', true),
    ])
    if (storeResult.data) setStore(storeResult.data)

    const catalog = (assignmentResult.data ?? []).flatMap((row) => {
      const product = Array.isArray(row.products) ? row.products[0] : row.products
      return product ? [product as Product] : []
    })
    setProductCatalog(catalog)
    const assignedCategoryIds = new Set(catalog.map((product) => product.category_id))
    const availableCategories = (categoryResult.data ?? []).filter((category) => assignedCategoryIds.has(category.id))
    setCategories(availableCategories)
    setActiveCat(availableCategories[0]?.id ?? null)

    let { data: openSession } = await supabase
      .from('inventory_sessions')
      .select('*')
      .eq('store_id', Number(storeId))
      .eq('status', 'draft')
      .maybeSingle()

    if (!openSession) {
      const completedToday = await supabase
        .from('inventory_sessions')
        .select('*')
        .eq('store_id', Number(storeId))
        .eq('entry_date', today())
        .eq('status', 'completed')
        .maybeSingle()
      openSession = completedToday.data
    }

    if (!openSession) {
      const inserted = await supabase
        .from('inventory_sessions')
        .insert({ store_id: Number(storeId), entry_date: today(), status: 'draft' })
        .select('*')
        .single()
      openSession = inserted.data
      if (!openSession) {
        const retry = await supabase
          .from('inventory_sessions')
          .select('*')
          .eq('store_id', Number(storeId))
          .eq('status', 'draft')
          .maybeSingle()
        openSession = retry.data
      }
    }
    if (!openSession) {
      setSaveError('下書きを開始できませんでした。画面を再読み込みしてください。')
      return
    }

    // 入力は数日分をまとめて行うため、未完了の内容は残しつつ
    // 翌日以降に再開した下書きの日付だけを当日に繰り越す。
    const currentDate = today()
    if (openSession.status === 'draft' && openSession.entry_date !== currentDate) {
      const { data: refreshedSession, error: dateRefreshError } = await supabase
        .from('inventory_sessions')
        .update({ entry_date: currentDate, updated_at: new Date().toISOString() })
        .eq('id', openSession.id)
        .select('*')
        .single()

      if (dateRefreshError) {
        setSaveError('入力日を今日の日付に更新できませんでした。')
      } else if (refreshedSession) {
        openSession = refreshedSession
      }
    }

    setSession(openSession as InventorySession)
    setDate(openSession.entry_date)
    setCompleted(openSession.status === 'completed')
    const [itemResult, confirmationResult] = await Promise.all([
      supabase.from('inventory_session_items').select('product_id, quantity').eq('session_id', openSession.id),
      supabase.from('inventory_session_categories').select('category_id').eq('session_id', openSession.id),
    ])
    const quantities = new Map<number, number>()
    ;(itemResult.data ?? []).forEach((item) => quantities.set(item.product_id, item.quantity))
    setDraftQuantities(quantities)
    setConfirmedCategories(new Set((confirmationResult.data ?? []).map((item) => item.category_id)))
    setDraftLoaded(true)
  }

  useEffect(() => {
    if (!activeCat || !profile || !session || !draftLoaded) return
    supabase
      .from('store_products')
      .select('required_qty, sort_order, products!inner(*)')
      .eq('store_id', Number(storeId))
      .eq('is_active', true)
      .eq('products.category_id', activeCat)
      .eq('products.is_active', true)
      .order('sort_order')
      .then(({ data }) => {
        if (data) {
          const availableProducts = data.flatMap((row) => {
            const product = Array.isArray(row.products) ? row.products[0] : row.products
            return product ? [{
              ...product,
              required_qty: row.required_qty,
              sort_order: row.sort_order,
              qty: draftQuantities.get(product.id) ?? 0,
            }] : []
          }) as ProductWithQty[]
          setProducts(availableProducts)
          loadRecentUsage(availableProducts.map((p) => p.id))
        }
      })
  }, [activeCat, storeId, profile, session, draftLoaded])

  async function handleLogout() {
    await supabase.auth.signOut()
    router.replace('/')
  }

  async function loadRecentUsage(productIds: number[]) {
    const since = new Date()
    since.setDate(since.getDate() - 60)
    const { data } = await supabase
      .from('usage_logs')
      .select('product_id, date, quantity')
      .eq('store_id', storeId)
      .in('product_id', productIds)
      .gte('date', since.toLocaleDateString('sv-SE'))
      .gt('quantity', 0)
      .order('date', { ascending: false })
    if (data) setRecentUsage(data)
  }

  async function adjust(id: number, delta: number) {
    if (!session || completed) return
    const current = draftQuantities.get(id) ?? 0
    const next = Math.max(0, current + delta)
    setDraftQuantities((previous) => new Map(previous).set(id, next))
    setProducts((previous) => previous.map((product) => product.id === id ? { ...product, qty: next } : product))
    setSaveError('')
    setPendingWrites((count) => count + 1)
    const itemResult = await supabase.from('inventory_session_items').upsert({
      session_id: session.id,
      product_id: id,
      quantity: next,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'session_id,product_id' })
    let confirmationError = null
    if (activeCat && confirmedCategories.has(activeCat)) {
      setConfirmedCategories((previous) => {
        const nextSet = new Set(previous)
        nextSet.delete(activeCat)
        return nextSet
      })
      const confirmationResult = await supabase.from('inventory_session_categories').delete()
        .eq('session_id', session.id).eq('category_id', activeCat)
      confirmationError = confirmationResult.error
    }
    setPendingWrites((count) => Math.max(0, count - 1))
    if (itemResult.error || confirmationError) {
      setSaveError('下書きの保存に失敗しました。通信状態を確認してください。')
    }
  }

  async function handleDateChange(nextDate: string) {
    setDate(nextDate)
    if (!session || completed) return
    const { error } = await supabase.from('inventory_sessions')
      .update({ entry_date: nextDate, updated_at: new Date().toISOString() }).eq('id', session.id)
    if (error) setSaveError('入力日の保存に失敗しました。')
  }

  async function confirmCurrentCategory() {
    if (!session || !activeCat || completed || pendingWrites > 0) return
    setSaving(true)
    const { error } = await supabase.from('inventory_session_categories').upsert({
      session_id: session.id,
      category_id: activeCat,
      confirmed_at: new Date().toISOString(),
    }, { onConflict: 'session_id,category_id' })
    setSaving(false)
    if (error) {
      setSaveError('カテゴリの確認状態を保存できませんでした。')
      return
    }
    setConfirmedCategories((previous) => new Set(previous).add(activeCat))
    const currentIndex = categories.findIndex((category) => category.id === activeCat)
    const followingCategories = [
      ...categories.slice(currentIndex + 1),
      ...categories.slice(0, currentIndex),
    ]
    const nextCategory = followingCategories.find((category) => !confirmedCategories.has(category.id))
    if (nextCategory) setActiveCat(nextCategory.id)
  }

  async function handleComplete() {
    if (!session || !allCategoriesConfirmed || pendingWrites > 0) return
    setSaving(true)
    const { error } = await supabase.rpc('complete_inventory_session', { p_session_id: session.id })
    setSaving(false)
    if (error) {
      setSaveError(error.message || '入力を完了できませんでした。')
      return
    }
    setShowConfirm(false)
    setCompleted(true)
  }

  const allCategoriesConfirmed = categories.length > 0 && categories.every((category) => confirmedCategories.has(category.id))
  const confirmedCategoryCount = categories.filter((category) => confirmedCategories.has(category.id)).length
  const summaryProducts = productCatalog.filter((product) => (draftQuantities.get(product.id) ?? 0) > 0)
  const hasInput = summaryProducts.length > 0
  const usageRank = useMemo(() => {
    const map = new Map<number, { count: number; lastDate: string }>()
    recentUsage.forEach((usage) => {
      const current = map.get(usage.product_id) ?? { count: 0, lastDate: '' }
      map.set(usage.product_id, {
        count: current.count + usage.quantity,
        lastDate: current.lastDate > usage.date ? current.lastDate : usage.date,
      })
    })
    return map
  }, [recentUsage])
  const displayedProducts = useMemo(() => {
    const normalized = normalizeSearch(search)
    return products
      .filter((product) => {
        if (!normalized) return true
        return [product.name, product.brand ?? ''].some((value) => normalizeSearch(value).includes(normalized))
      })
      .sort((a, b) => {
        const aRank = usageRank.get(a.id)
        const bRank = usageRank.get(b.id)
        if (!aRank && !bRank) return 0
        if (!aRank) return 1
        if (!bRank) return -1
        if (aRank.lastDate !== bRank.lastDate) return bRank.lastDate.localeCompare(aRank.lastDate)
        return bRank.count - aRank.count
      })
  }, [products, search, usageRank])

  if (!store) return <div className="flex items-center justify-center min-h-screen text-gray-400">読み込み中...</div>

  return (
    <div className="max-w-lg mx-auto pb-64">
      {/* ヘッダー */}
      <div className="sticky top-0 z-10 bg-white shadow-sm">
        <div className="flex items-center justify-between px-4 py-3">
          {profile?.role === 'hq' ? (
            <button onClick={() => router.push('/')} className="text-gray-400 text-2xl leading-none">‹</button>
          ) : (
            <div className="w-6" />
          )}
          <div className="text-center">
            <div className="font-bold text-gray-800">{store.name}</div>
            <input
              type="date"
              value={date}
              onChange={(e) => void handleDateChange(e.target.value)}
              disabled={completed}
              className="text-xs text-blue-600 text-center border-none outline-none bg-transparent"
            />
          </div>
          <button onClick={handleLogout} className="text-xs text-gray-400 underline">退出</button>
        </div>
        {/* カテゴリタブ */}
        <div className="flex overflow-x-auto gap-1 px-3 pb-2 scrollbar-hide">
          {categories.map((cat) => (
            <button
              key={cat.id}
              onClick={() => setActiveCat(cat.id)}
              className={`shrink-0 px-3 py-1.5 rounded-full text-sm font-medium transition-all ${
                activeCat === cat.id
                  ? 'bg-blue-500 text-white'
                  : 'bg-gray-100 text-gray-600'
              }`}
            >
              {confirmedCategories.has(cat.id) ? '✓ ' : ''}{cat.name}
            </button>
          ))}
        </div>
        <label className="block px-3 pb-3">
          <span className="sr-only">商品を検索</span>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="商品名・ブランドで検索"
            className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm outline-none focus:border-blue-400 focus:bg-white"
          />
        </label>
      </div>

      {/* 商品リスト */}
      <div className="px-4 pt-3">
        {completed && (
          <div className="mb-3 rounded-xl bg-green-50 px-4 py-3 text-center text-sm font-medium text-green-700">
            この入力は完了済みです。店舗からは修正できません。
          </div>
        )}
        {recentUsage.length > 0 && !search && (
          <p className="mb-2 text-xs font-medium text-blue-600">最近入力した商品を上に表示しています</p>
        )}
        {products.length === 0 && (
          <p className="text-center text-gray-400 py-12">商品データがありません</p>
        )}
        {products.length > 0 && displayedProducts.length === 0 && (
          <p className="text-center text-gray-400 py-12">該当する商品がありません</p>
        )}
        {displayedProducts.map((product) => (
          <div key={product.id} className="flex items-center justify-between py-3 border-b border-gray-100">
            <div className="flex-1 min-w-0 mr-3">
              {product.brand && <div className="text-xs text-gray-400">{product.brand}</div>}
              <div className="text-base text-gray-800 font-medium truncate">{product.name}</div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => void adjust(product.id, -1)}
                disabled={completed}
                className="w-10 h-10 rounded-full bg-gray-100 text-xl text-gray-600 flex items-center justify-center active:bg-gray-200 disabled:opacity-40"
              >
                −
              </button>
              <span className={`w-8 text-center text-lg font-bold ${product.qty > 0 ? 'text-blue-600' : 'text-gray-300'}`}>
                {product.qty}
              </span>
              <button
                onClick={() => void adjust(product.id, 1)}
                disabled={completed}
                className="w-10 h-10 rounded-full bg-blue-500 text-white text-xl flex items-center justify-center active:bg-blue-600 disabled:opacity-40"
              >
                ＋
              </button>
            </div>
          </div>
        ))}
        {saveError && <p className="mt-3 text-center text-sm text-red-500">{saveError}</p>}
      </div>

      {/* 完了ボタン */}
      <div className="fixed bottom-0 left-0 right-0 z-20 border-t border-gray-200 bg-white p-4 shadow-[0_-4px_12px_rgba(0,0,0,0.06)] max-w-lg mx-auto">
        {completed ? (
          <div className="w-full py-4 rounded-2xl bg-green-500 text-white text-center font-bold text-lg">
            ✓ 入力を完了しました
          </div>
        ) : (
          <div>
            {activeCat && (
              <button
                onClick={() => void confirmCurrentCategory()}
                disabled={saving || pendingWrites > 0 || confirmedCategories.has(activeCat)}
                className={`mb-3 w-full rounded-xl border-2 py-3 text-sm font-bold ${
                  confirmedCategories.has(activeCat)
                    ? 'border-green-200 bg-green-50 text-green-700'
                    : 'border-blue-200 bg-blue-50 text-blue-700'
                } disabled:opacity-70`}
              >
                {confirmedCategories.has(activeCat) ? '✓ このカテゴリは確認済み' : 'このカテゴリを確認済みにする'}
              </button>
            )}
            <p className="mb-2 text-center text-xs text-gray-500">
              {confirmedCategoryCount} / {categories.length} カテゴリ確認済み
            </p>
            <button
              onClick={() => setShowConfirm(true)}
              disabled={!allCategoriesConfirmed || saving || pendingWrites > 0}
              className="w-full py-4 rounded-2xl bg-blue-500 text-white text-lg font-bold active:bg-blue-600 disabled:bg-gray-200 disabled:text-gray-400"
            >
              {allCategoriesConfirmed ? '入力を完了する' : '全カテゴリを確認してください'}
            </button>
          </div>
        )}
      </div>

      {/* 確認モーダル */}
      {showConfirm && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40">
          <div className="w-full max-w-lg bg-white rounded-t-3xl p-6">
            <h2 className="text-lg font-bold text-gray-800 mb-1">入力完了の確認</h2>
            <p className="text-gray-500 text-sm mb-4">{date} の入力を完了します。完了後は店舗から修正できません。</p>
            {hasInput ? (
              <div className="mb-4 max-h-48 overflow-y-auto">
                {summaryProducts.map((p) => (
                  <div key={p.id} className="flex justify-between text-sm py-1 border-b border-gray-100">
                    <span className="text-gray-700">{p.name}</span>
                    <span className="font-bold text-blue-600">{draftQuantities.get(p.id) ?? 0}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-gray-400 mb-4">（使用数は全て 0 です）</p>
            )}
            <div className="flex gap-3">
              <button
                onClick={() => setShowConfirm(false)}
                className="flex-1 py-3 rounded-xl border border-gray-200 text-gray-600 font-medium"
              >
                キャンセル
              </button>
              <button
                onClick={() => void handleComplete()}
                disabled={saving}
                className="flex-1 py-3 rounded-xl bg-blue-500 text-white font-bold disabled:opacity-50"
              >
                {saving ? '完了処理中...' : '完了する'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

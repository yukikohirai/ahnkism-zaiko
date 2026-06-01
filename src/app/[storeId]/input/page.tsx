'use client'
import { useEffect, useState, use } from 'react'
import { useRouter } from 'next/navigation'
import { supabase, type Store, type Category, type Product } from '@/lib/supabase'

type ProductWithQty = Product & { qty: number }

function today() {
  return new Date().toLocaleDateString('sv-SE')
}

export default function InputPage({ params }: { params: Promise<{ storeId: string }> }) {
  const { storeId } = use(params)
  const router = useRouter()
  const [store, setStore] = useState<Store | null>(null)
  const [categories, setCategories] = useState<Category[]>([])
  const [activeCat, setActiveCat] = useState<number | null>(null)
  const [products, setProducts] = useState<ProductWithQty[]>([])
  const [date, setDate] = useState(today())
  const [saving, setSaving] = useState(false)
  const [done, setDone] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)

  useEffect(() => {
    supabase.from('stores').select('*').eq('id', storeId).single().then(({ data }) => {
      if (data) setStore(data)
    })
    supabase.from('categories').select('*').order('sort_order').then(({ data }) => {
      if (data) {
        setCategories(data)
        setActiveCat(data[0]?.id ?? null)
      }
    })
  }, [storeId])

  useEffect(() => {
    if (!activeCat) return
    supabase
      .from('products')
      .select('*')
      .eq('category_id', activeCat)
      .order('sort_order')
      .then(({ data }) => {
        if (data) {
          setProducts(data.map((p) => ({ ...p, qty: 0 })))
          loadExisting(data.map((p) => p.id))
        }
      })
  }, [activeCat, date, storeId])

  async function loadExisting(productIds: number[]) {
    const { data } = await supabase
      .from('usage_logs')
      .select('product_id, quantity')
      .eq('store_id', storeId)
      .eq('date', date)
      .in('product_id', productIds)
    if (data) {
      setProducts((prev) =>
        prev.map((p) => {
          const found = data.find((d) => d.product_id === p.id)
          return found ? { ...p, qty: found.quantity } : p
        })
      )
    }
  }

  function adjust(id: number, delta: number) {
    setProducts((prev) =>
      prev.map((p) => p.id === id ? { ...p, qty: Math.max(0, p.qty + delta) } : p)
    )
  }

  async function handleSubmit() {
    setSaving(true)
    const rows = products.map((p) => ({
      store_id: Number(storeId),
      product_id: p.id,
      date,
      quantity: p.qty,
      updated_at: new Date().toISOString(),
    }))
    await supabase.from('usage_logs').upsert(rows, { onConflict: 'store_id,product_id,date' })
    setSaving(false)
    setShowConfirm(false)
    setDone(true)
    setTimeout(() => setDone(false), 2000)
  }

  const hasInput = products.some((p) => p.qty > 0)

  if (!store) return <div className="flex items-center justify-center min-h-screen text-gray-400">読み込み中...</div>

  return (
    <div className="max-w-lg mx-auto pb-32">
      {/* ヘッダー */}
      <div className="sticky top-0 z-10 bg-white shadow-sm">
        <div className="flex items-center justify-between px-4 py-3">
          <button onClick={() => router.push('/')} className="text-gray-400 text-2xl leading-none">‹</button>
          <div className="text-center">
            <div className="font-bold text-gray-800">{store.name}</div>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="text-xs text-blue-600 text-center border-none outline-none bg-transparent"
            />
          </div>
          <div className="w-6" />
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
              {cat.name}
            </button>
          ))}
        </div>
      </div>

      {/* 商品リスト */}
      <div className="px-4 pt-3">
        {products.length === 0 && (
          <p className="text-center text-gray-400 py-12">商品データがありません</p>
        )}
        {products.map((product) => (
          <div key={product.id} className="flex items-center justify-between py-3 border-b border-gray-100">
            <div className="flex-1 min-w-0 mr-3">
              {product.brand && <div className="text-xs text-gray-400">{product.brand}</div>}
              <div className="text-base text-gray-800 font-medium truncate">{product.name}</div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => adjust(product.id, -1)}
                className="w-10 h-10 rounded-full bg-gray-100 text-xl text-gray-600 flex items-center justify-center active:bg-gray-200"
              >
                −
              </button>
              <span className={`w-8 text-center text-lg font-bold ${product.qty > 0 ? 'text-blue-600' : 'text-gray-300'}`}>
                {product.qty}
              </span>
              <button
                onClick={() => adjust(product.id, 1)}
                className="w-10 h-10 rounded-full bg-blue-500 text-white text-xl flex items-center justify-center active:bg-blue-600"
              >
                ＋
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* 送信ボタン */}
      <div className="fixed bottom-0 left-0 right-0 p-4 bg-white border-t border-gray-200 max-w-lg mx-auto">
        {done ? (
          <div className="w-full py-4 rounded-2xl bg-green-500 text-white text-center font-bold text-lg">
            ✓ 送信しました
          </div>
        ) : (
          <button
            onClick={() => setShowConfirm(true)}
            className="w-full py-4 rounded-2xl bg-blue-500 text-white text-lg font-bold active:bg-blue-600 disabled:opacity-40"
          >
            送信する
          </button>
        )}
      </div>

      {/* 確認モーダル */}
      {showConfirm && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40">
          <div className="w-full max-w-lg bg-white rounded-t-3xl p-6">
            <h2 className="text-lg font-bold text-gray-800 mb-1">送信確認</h2>
            <p className="text-gray-500 text-sm mb-4">{date} の使用数を送信します。</p>
            {hasInput ? (
              <div className="mb-4 max-h-48 overflow-y-auto">
                {products.filter((p) => p.qty > 0).map((p) => (
                  <div key={p.id} className="flex justify-between text-sm py-1 border-b border-gray-100">
                    <span className="text-gray-700">{p.name}</span>
                    <span className="font-bold text-blue-600">{p.qty}</span>
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
                onClick={handleSubmit}
                disabled={saving}
                className="flex-1 py-3 rounded-xl bg-blue-500 text-white font-bold disabled:opacity-50"
              >
                {saving ? '送信中...' : '送信する'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

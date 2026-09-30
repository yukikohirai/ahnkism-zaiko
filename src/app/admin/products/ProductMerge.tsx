'use client'

import { useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'

type MergeProduct = { id: number; brand: string | null; name: string; dealer: string | null; is_active: boolean }
type Store = { id: number; name: string }
type StockRow = { store_id: number; product_id: number; current_stock: number }

function normalize(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, '')
}

function label(product: MergeProduct) {
  return `${product.brand ? `${product.brand} ` : ''}${product.name}${product.is_active ? '' : '（停止中）'}`
}

// 重複している商品を1つにまとめる。在庫・履歴はすべて残す方へ付け替えて合算し、消す方は削除する
export default function ProductMerge({ products, stores, onChanged }: {
  products: MergeProduct[]
  stores: Store[]
  onChanged: () => Promise<void>
}) {
  const [keepId, setKeepId] = useState<number | null>(null)
  const [removeId, setRemoveId] = useState<number | null>(null)
  const [keepSearch, setKeepSearch] = useState('')
  const [removeSearch, setRemoveSearch] = useState('')
  const [stock, setStock] = useState<StockRow[]>([])
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const productMap = useMemo(() => new Map(products.map((product) => [product.id, product])), [products])
  const candidates = (keyword: string, exclude: number | null) => {
    const normalized = normalize(keyword)
    if (!normalized) return []
    return products
      .filter((product) => product.id !== exclude && normalize(`${product.brand ?? ''}${product.name}`).includes(normalized))
      .slice(0, 20)
  }

  useEffect(() => {
    const ids = [keepId, removeId].filter((id): id is number => id !== null)
    if (ids.length === 0) { setStock([]); return }
    void supabase.from('current_store_stock').select('store_id, product_id, current_stock').in('product_id', ids)
      .then(({ data }) => setStock((data ?? []) as StockRow[]))
  }, [keepId, removeId])

  const stockOf = (storeId: number, productId: number | null) => (
    productId === null ? null : stock.find((row) => row.store_id === storeId && row.product_id === productId)?.current_stock ?? null
  )

  async function merge() {
    setError('')
    setMessage('')
    if (!keepId || !removeId) { setError('残す商品と、まとめて消す商品を選んでください。'); return }
    const keep = productMap.get(keepId)!
    const remove = productMap.get(removeId)!
    if (!confirm(`「${label(remove)}」を「${label(keep)}」に統合します。\n\n・在庫と履歴はすべて「${keep.name}」にまとめて合算します\n・名前・価格・仕入れ値・ジャンル・必要数は「${keep.name}」のものを使います\n・「${remove.name}」は商品一覧から削除され、元に戻せません\n\nよろしいですか？`)) return
    setSaving(true)
    const { error: mergeError } = await supabase.rpc('merge_products', { p_keep_id: keepId, p_remove_id: removeId })
    setSaving(false)
    if (mergeError) { setError(`統合できませんでした：${mergeError.message}`); return }
    setMessage(`「${remove.name}」を「${keep.name}」に統合しました。`)
    setRemoveId(null)
    setKeepId(null)
    await onChanged()
  }

  const picker = (title: string, selected: number | null, setSelected: (id: number | null) => void, keyword: string, setKeyword: (value: string) => void, exclude: number | null, tone: string) => (
    <div className={`rounded-xl border p-3 ${tone}`}>
      <p className="text-sm font-bold text-gray-800">{title}</p>
      {selected ? (
        <div className="mt-2 flex items-center justify-between gap-2 rounded-lg bg-white px-3 py-2 text-sm">
          <span className="font-medium">{label(productMap.get(selected)!)}</span>
          <button onClick={() => setSelected(null)} className="shrink-0 text-xs text-blue-600 underline">選び直す</button>
        </div>
      ) : (
        <>
          <input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="商品名・ブランドで検索"
            className="mt-2 block w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-base outline-none focus:border-blue-400" />
          {candidates(keyword, exclude).length > 0 && (
            <ul className="mt-1 max-h-56 divide-y overflow-y-auto rounded-lg border border-gray-200 bg-white text-sm">
              {candidates(keyword, exclude).map((product) => (
                <li key={product.id}>
                  <button onClick={() => { setSelected(product.id); setKeyword('') }} className="w-full px-3 py-2 text-left hover:bg-gray-50">
                    {label(product)}
                    {product.dealer && <span className="ml-2 text-xs text-gray-400">{product.dealer}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )

  return (
    <section className="mb-3 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <p className="text-xs text-gray-500">同じ商品が2つ登録されているときに使います。在庫と履歴はすべて残す方に合算されるので、在庫は狂いません。</p>
      {message && <p className="mt-2 rounded-xl bg-green-50 px-3 py-2 text-sm text-green-700">{message}</p>}
      {error && <p className="mt-2 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {picker('残す商品（この名前・価格を使う）', keepId, setKeepId, keepSearch, setKeepSearch, removeId, 'border-blue-200 bg-blue-50/40')}
        {picker('まとめて消す商品', removeId, setRemoveId, removeSearch, setRemoveSearch, keepId, 'border-red-200 bg-red-50/40')}
      </div>

      {keepId && removeId && (
        <div className="mt-3">
          <p className="text-sm font-bold text-gray-700">統合後の在庫（店舗ごと）</p>
          <table className="mt-1 w-full border-collapse text-sm">
            <thead>
              <tr className="bg-gray-100 text-xs text-gray-500">
                <th className="border border-gray-200 px-2 py-1.5 text-left">店舗</th>
                <th className="border border-gray-200 px-2 py-1.5 text-right">残す方</th>
                <th className="border border-gray-200 px-2 py-1.5 text-right">消す方</th>
                <th className="border border-gray-200 px-2 py-1.5 text-right">統合後</th>
              </tr>
            </thead>
            <tbody>
              {stores.map((store) => {
                const keepStock = stockOf(store.id, keepId)
                const removeStock = stockOf(store.id, removeId)
                if (keepStock === null && removeStock === null) return null
                return (
                  <tr key={store.id}>
                    <td className="border border-gray-200 px-2 py-1.5">{store.name}</td>
                    <td className="border border-gray-200 px-2 py-1.5 text-right">{keepStock ?? '取扱なし'}</td>
                    <td className="border border-gray-200 px-2 py-1.5 text-right">{removeStock ?? '取扱なし'}</td>
                    <td className="border border-gray-200 px-2 py-1.5 text-right font-bold">{(keepStock ?? 0) + (removeStock ?? 0)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <button onClick={() => void merge()} disabled={saving}
            className="mt-3 w-full rounded-xl bg-gray-800 py-3 text-sm font-bold text-white disabled:bg-gray-300">
            {saving ? '統合しています...' : '統合する'}
          </button>
        </div>
      )}
    </section>
  )
}

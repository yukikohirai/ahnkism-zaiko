'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import type { PresaleCampaign } from '@/lib/presale'

type Store = { id: number; name: string }
type Item = { product_id: number; brand: string | null; name: string }

// 先行予約：店舗ごとの商品の並び（本部が設定）。店舗の予約ページの「商品を選ぶ」がこの順になる
export default function ItemOrderSettings({ campaign, stores }: { campaign: PresaleCampaign; stores: Store[] }) {
  const [storeId, setStoreId] = useState<number | null>(stores[0]?.id ?? null)
  const [items, setItems] = useState<Item[]>([])
  const [order, setOrder] = useState<number[]>([])
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const nameOf = (item: Item) => `${item.brand ? `${item.brand} ` : ''}${item.name}`
  const byName = useCallback((list: Item[]) => [...list].sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'ja')), [])

  const load = useCallback(async () => {
    if (!storeId) return
    setError('')
    const [itemResult, sortResult] = await Promise.all([
      supabase.from('presale_items').select('product_id, product:products!inner(brand, name)').eq('campaign_id', campaign.id),
      supabase.from('presale_store_item_sort').select('product_id, sort_order').eq('store_id', storeId),
    ])
    if (itemResult.error || sortResult.error) { setError('読み込めませんでした。'); return }
    const list = (itemResult.data ?? []).map((row) => {
      const product = Array.isArray(row.product) ? row.product[0] : row.product
      return { product_id: row.product_id as number, brand: product.brand as string | null, name: product.name as string }
    })
    const saved = new Map(((sortResult.data ?? []) as { product_id: number; sort_order: number }[]).map((row) => [row.product_id, row.sort_order]))
    const LAST = Number.MAX_SAFE_INTEGER
    const sorted = byName(list).sort((a, b) => (saved.get(a.product_id) ?? LAST) - (saved.get(b.product_id) ?? LAST))
    setItems(list)
    setOrder(sorted.map((item) => item.product_id))
    setDirty(false)
  }, [byName, campaign.id, storeId])

  useEffect(() => { void load() }, [load])

  const itemMap = useMemo(() => new Map(items.map((item) => [item.product_id, item])), [items])

  function move(index: number, delta: number) {
    const next = [...order]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    setOrder(next)
    setDirty(true)
  }

  function moveToTop(index: number) {
    const next = [...order]
    const [picked] = next.splice(index, 1)
    next.unshift(picked)
    setOrder(next)
    setDirty(true)
  }

  function changeStore(id: number) {
    if (dirty && !confirm('保存していない並び替えがあります。保存せずに店舗を切り替えますか？')) return
    setStoreId(id)
    setMessage('')
  }

  async function save() {
    if (!storeId) return
    setSaving(true)
    setError('')
    const { error: saveError } = await supabase.from('presale_store_item_sort').upsert(
      order.map((productId, index) => ({ store_id: storeId, product_id: productId, sort_order: index + 1 })),
      { onConflict: 'store_id,product_id' },
    )
    setSaving(false)
    if (saveError) { setError(`保存できませんでした：${saveError.message}`); return }
    setDirty(false)
    setMessage(`${stores.find((store) => store.id === storeId)?.name ?? ''}の並びを保存しました。`)
  }

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <h2 className="font-bold text-gray-800">店舗ごとの商品の並び</h2>
      <p className="mt-1 text-xs text-gray-500">店舗の予約ページで「商品を選ぶ」を開いたときの順番です。よく出る商品を上にしておくと選びやすくなります。次の企画でも、同じ商品は同じ順で出ます。</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {stores.map((store) => (
          <button key={store.id} onClick={() => changeStore(store.id)}
            className={`rounded-full px-4 py-1.5 text-sm font-bold ${storeId === store.id ? 'bg-pink-600 text-white' : 'border border-gray-200 bg-white text-gray-600'}`}>{store.name}</button>
        ))}
      </div>
      {message && <p className="mt-2 rounded-xl bg-green-50 px-3 py-2 text-sm text-green-700">{message}</p>}
      {error && <p className="mt-2 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

      <ol className="mt-3 divide-y rounded-xl border border-gray-200">
        {order.map((productId, index) => {
          const item = itemMap.get(productId)
          if (!item) return null
          return (
            <li key={productId} className="flex items-center gap-2 px-3 py-2 text-sm">
              <span className="w-6 shrink-0 text-right text-xs text-gray-400">{index + 1}</span>
              <span className="min-w-0 flex-1 break-words">{nameOf(item)}</span>
              <button onClick={() => moveToTop(index)} disabled={index === 0} className="shrink-0 rounded bg-gray-100 px-2 py-1 text-xs text-gray-600 disabled:opacity-30">一番上へ</button>
              <button onClick={() => move(index, -1)} disabled={index === 0} aria-label="上へ" className="shrink-0 rounded bg-gray-100 px-2.5 py-1 text-sm font-bold text-gray-700 disabled:opacity-30">↑</button>
              <button onClick={() => move(index, 1)} disabled={index === order.length - 1} aria-label="下へ" className="shrink-0 rounded bg-gray-100 px-2.5 py-1 text-sm font-bold text-gray-700 disabled:opacity-30">↓</button>
            </li>
          )
        })}
      </ol>
      {order.length === 0 && <p className="py-6 text-center text-sm text-gray-400">この企画の対象商品がありません</p>}

      <div className="mt-3 flex flex-wrap gap-2">
        <button onClick={() => void save()} disabled={saving || !dirty}
          className="flex-1 rounded-xl bg-pink-600 py-3 text-sm font-bold text-white disabled:bg-gray-300">{saving ? '保存しています...' : dirty ? 'この並びで保存' : '保存済み'}</button>
        <button onClick={() => { setOrder(byName(items).map((item) => item.product_id)); setDirty(true) }}
          className="rounded-xl border border-gray-300 px-4 py-3 text-sm text-gray-600">名前順に並べ直す</button>
      </div>
    </section>
  )
}

'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { fetchAll } from '@/lib/fetchAll'
import type { PresaleCampaign } from '@/lib/presale'

type Store = { id: number; name: string }
type Checkpoint = { id: string; campaign_id: number; store_id: number; note: string; created_at: string }
type Line = { product_id: number; quantity: number; needs_order: boolean; order: { id: string; store_id: number; created_at: string; cancelled_at: string | null; customer_name: string } }
type Product = { id: number; brand: string | null; name: string }

function timeLabel(value: string) {
  return new Date(value).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// 先行予約で「発注が必要」にチェックした商品を、店舗ごとにまとめた発注リスト。
// 「発注済み」のメモを入れるとそこで区切られ、そのあとに登録された予約の分だけが次のリストに入る
export default function NeedsOrderList({ campaign, stores }: { campaign: PresaleCampaign; stores: Store[] }) {
  const [storeId, setStoreId] = useState<number | null>(stores[0]?.id ?? null)
  const [lines, setLines] = useState<Line[]>([])
  const [products, setProducts] = useState<Map<number, Product>>(new Map())
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([])
  const [memo, setMemo] = useState('')
  const [openHistory, setOpenHistory] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setError('')
    const [lineResult, checkpointResult] = await Promise.all([
      fetchAll((start, end) => supabase.from('presale_order_lines')
        .select('id, product_id, quantity, needs_order, parent:presale_orders!inner(id, store_id, created_at, cancelled_at, customer_name, campaign_id)')
        .eq('needs_order', true).eq('parent.campaign_id', campaign.id).order('id').range(start, end)),
      supabase.from('presale_order_checkpoints').select('id, campaign_id, store_id, note, created_at').eq('campaign_id', campaign.id).order('created_at'),
    ])
    if (lineResult.error || checkpointResult.error) { setError('読み込めませんでした。'); return }
    const list = ((lineResult.data ?? []) as unknown as (Omit<Line, 'order'> & { parent: Line['order'] | Line['order'][] })[])
      .map(({ parent, ...row }) => ({ ...row, order: Array.isArray(parent) ? parent[0] : parent }))
    setLines(list)
    setCheckpoints((checkpointResult.data ?? []) as Checkpoint[])
    const ids = Array.from(new Set(list.map((row) => row.product_id)))
    if (ids.length > 0) {
      const { data } = await supabase.from('products').select('id, brand, name').in('id', ids)
      setProducts(new Map(((data ?? []) as Product[]).map((product) => [product.id, product])))
    }
  }, [campaign.id])

  useEffect(() => { void load() }, [load])

  const storePoints = useMemo(() => checkpoints.filter((point) => point.store_id === storeId), [checkpoints, storeId])

  // 区切りの間（from より後〜to まで）に登録された予約の「発注が必要」を、商品ごとにまとめる
  const summarize = useCallback((from: string | null, to: string | null) => {
    const map = new Map<number, { product_id: number; quantity: number; customers: string[] }>()
    lines
      .filter((line) => line.order.store_id === storeId && !line.order.cancelled_at)
      .filter((line) => (from === null || line.order.created_at > from) && (to === null || line.order.created_at <= to))
      .forEach((line) => {
        const item = map.get(line.product_id) ?? { product_id: line.product_id, quantity: 0, customers: [] }
        item.quantity += line.quantity
        item.customers.push(`${line.order.customer_name.replace(/\s*様$/, '')}様×${line.quantity}`)
        map.set(line.product_id, item)
      })
    return Array.from(map.values()).sort((a, b) => {
      const pa = products.get(a.product_id); const pb = products.get(b.product_id)
      return `${pa?.brand ?? ''}${pa?.name ?? ''}`.localeCompare(`${pb?.brand ?? ''}${pb?.name ?? ''}`, 'ja')
    })
  }, [lines, products, storeId])

  const lastPoint = storePoints[storePoints.length - 1] ?? null
  const current = summarize(lastPoint?.created_at ?? null, null)
  const history = storePoints.map((point, index) => ({ point, rows: summarize(index > 0 ? storePoints[index - 1].created_at : null, point.created_at) })).reverse()
  const productLabel = (id: number) => {
    const product = products.get(id)
    return product ? `${product.brand ? `${product.brand} ` : ''}${product.name}` : `商品#${id}`
  }

  async function addCheckpoint() {
    setError('')
    setMessage('')
    const note = memo.trim()
    if (!note) { setError('メモを入れてください（例：10/22 発注済み）。'); return }
    if (!storeId) return
    const storeName = stores.find((store) => store.id === storeId)?.name ?? ''
    if (!confirm(`${storeName}のリストを「${note}」で区切ります。\nこれより後に登録された予約の「発注が必要」だけが、新しいリストに入ります。よろしいですか？`)) return
    setSaving(true)
    const { error: insertError } = await supabase.from('presale_order_checkpoints').insert({ campaign_id: campaign.id, store_id: storeId, note })
    setSaving(false)
    if (insertError) { setError(`登録できませんでした：${insertError.message}`); return }
    setMemo('')
    setMessage(`${storeName}のリストを「${note}」で区切りました。予約一覧にも区切り線が入ります。`)
    await load()
  }

  async function removeCheckpoint(point: Checkpoint) {
    if (!confirm(`区切り「${point.note}」を取り消します。前後のリストが1つにまとまります。よろしいですか？`)) return
    const { error: deleteError } = await supabase.from('presale_order_checkpoints').delete().eq('id', point.id)
    if (deleteError) { setError(`取り消せませんでした：${deleteError.message}`); return }
    await load()
  }

  const table = (rows: ReturnType<typeof summarize>) => (
    <table className="mt-1 w-full border-collapse text-sm">
      <thead>
        <tr className="bg-gray-100 text-xs text-gray-500">
          <th className="border border-gray-200 px-2 py-1.5 text-left">商品</th>
          <th className="w-16 border border-gray-200 px-2 py-1.5 text-right">数</th>
          <th className="border border-gray-200 px-2 py-1.5 text-left">予約（お客様）</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.product_id}>
            <td className="border border-gray-200 px-2 py-1.5">{productLabel(row.product_id)}</td>
            <td className="border border-gray-200 px-2 py-1.5 text-right text-base font-bold">{row.quantity}</td>
            <td className="border border-gray-200 px-2 py-1.5 text-xs text-gray-500">{row.customers.join('、')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <h2 className="font-bold text-gray-800">発注が必要なもの</h2>
      <p className="mt-1 text-xs text-gray-500">予約一覧で「発注」にチェックした商品を、店舗ごとにまとめています（キャンセルは除く）。発注したら下のメモを入れると、そこで区切られて次のリストは0から始まります。</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {stores.map((store) => (
          <button key={store.id} onClick={() => { setStoreId(store.id); setMessage('') }}
            className={`rounded-full px-4 py-1.5 text-sm font-bold ${storeId === store.id ? 'bg-orange-500 text-white' : 'border border-gray-200 bg-white text-gray-600'}`}>{store.name}</button>
        ))}
      </div>
      {message && <p className="mt-2 rounded-xl bg-green-50 px-3 py-2 text-sm text-green-700">{message}</p>}
      {error && <p className="mt-2 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

      <div className="mt-3 rounded-xl border-2 border-orange-200 p-3">
        <p className="text-sm font-bold text-orange-800">
          今回の発注リスト
          <span className="ml-2 text-xs font-normal text-gray-500">{lastPoint ? `「${lastPoint.note}」（${timeLabel(lastPoint.created_at)}）より後の予約` : 'まだ区切りなし（この企画の最初から）'}</span>
        </p>
        {current.length === 0 ? <p className="py-4 text-center text-sm text-gray-400">発注が必要な商品はまだありません</p> : table(current)}
        <div className="mt-3 flex flex-wrap gap-2">
          <input value={memo} onChange={(event) => setMemo(event.target.value)} placeholder="例：10/22 発注済み"
            className="min-w-0 flex-1 rounded-lg border border-gray-200 px-3 py-2 text-base" />
          <button onClick={() => void addCheckpoint()} disabled={saving} className="shrink-0 rounded-lg bg-orange-500 px-4 py-2 text-sm font-bold text-white disabled:bg-gray-300">
            {saving ? '登録しています...' : '発注済みにして区切る'}
          </button>
        </div>
      </div>

      {history.length > 0 && (
        <div className="mt-4">
          <p className="text-sm font-bold text-gray-700">これまでの発注（新しい順）</p>
          <ul className="mt-1 space-y-2">
            {history.map(({ point, rows }) => (
              <li key={point.id} className="rounded-xl border border-gray-200 p-2">
                <div className="flex items-center justify-between gap-2 text-sm">
                  <button onClick={() => setOpenHistory(openHistory === point.id ? null : point.id)} className="text-left">
                    <b>「{point.note}」</b>
                    <span className="ml-2 text-xs text-gray-500">{timeLabel(point.created_at)}・{rows.length}商品 {rows.reduce((sum, row) => sum + row.quantity, 0)}個</span>
                    <span className="ml-2 text-xs text-blue-600 underline">{openHistory === point.id ? '閉じる' : '中身を見る'}</span>
                  </button>
                  <button onClick={() => void removeCheckpoint(point)} className="shrink-0 text-xs text-red-500">区切りを取消</button>
                </div>
                {openHistory === point.id && (rows.length === 0 ? <p className="py-2 text-center text-xs text-gray-400">この区切りの中に発注が必要な商品はありません</p> : table(rows))}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

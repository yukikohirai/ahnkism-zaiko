'use client'

import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { yen } from '@/lib/tax'

type Campaign = { id: number; name: string; is_active: boolean; reception_start: string | null; reception_end: string | null }
type Store = { id: number; name: string }
type Staff = { id: number; store_id: number | null; name: string; sort_order: number; is_active: boolean }
type Goal = { campaign_id: number; staff_id: number; goal_amount: number }
type Product = { id: number; brand: string | null; name: string }
type Order = {
  id: string
  campaign_id: number
  store_id: number
  reserved_on: string
  customer_name: string
  stylist_id: number | null
  staff_id: number | null
  total_amount: number
  delivered_at: string | null
  cancelled_at: string | null
  note: string | null
  lines: { product_id: number; quantity: number; reserved_qty?: number | null }[]
}
type ViewData = { campaigns: Campaign[]; stores: Store[]; staff: Staff[]; goals: Goal[]; products: Product[]; orders: Order[] }

// 先行予約の「見るだけ」ページ（スタッフ全員用）。URLだけで開ける。入力・修正・お渡しはできない
// 企画は自動で選択肢に出るので、企画のたびにページを作る必要はない
export default function PresaleViewPage() {
  const { token } = useParams<{ token: string }>()
  const [data, setData] = useState<ViewData | null>(null)
  const [error, setError] = useState('')
  const [campaignId, setCampaignId] = useState<number | null>(null)
  const [storeId, setStoreId] = useState<number | 'all'>('all')
  const [staffFilter, setStaffFilter] = useState<number | 'all'>('all')
  const [showCancelled, setShowCancelled] = useState(false)

  useEffect(() => {
    void supabase.rpc('presale_view_data', { p_token: token }).then(({ data: result, error: loadError }) => {
      if (loadError) { setError(loadError.message.includes('URL') ? 'このページのURLは使えません。本部に新しいURLを確認してください。' : '読み込めませんでした。'); return }
      const view = result as ViewData
      setData(view)
      const latest = view.campaigns.find((campaign) => campaign.is_active) ?? view.campaigns[0]
      setCampaignId(latest?.id ?? null)
    })
  }, [token])

  const staffMap = useMemo(() => new Map((data?.staff ?? []).map((person) => [person.id, person])), [data])
  const productMap = useMemo(() => new Map((data?.products ?? []).map((product) => [product.id, product])), [data])
  const storeName = useMemo(() => new Map((data?.stores ?? []).map((store) => [store.id, store.name])), [data])
  const campaignOrders = useMemo(() => (data?.orders ?? []).filter((order) => order.campaign_id === campaignId), [campaignId, data])

  // スタッフの目標と予約金額：目標を入れた人だけ。ヘルプで他店で取った予約も本人の実績に入れる
  const progress = useMemo(() => {
    if (!data || campaignId === null) return []
    const goals = data.goals.filter((goal) => goal.campaign_id === campaignId && goal.goal_amount > 0)
    return goals
      .map((goal) => {
        const person = staffMap.get(goal.staff_id)
        const mine = campaignOrders.filter((order) => !order.cancelled_at && order.staff_id === goal.staff_id)
        return {
          person,
          goal: goal.goal_amount,
          reserved: mine.reduce((sum, order) => sum + order.total_amount, 0),
          delivered: mine.filter((order) => order.delivered_at).reduce((sum, order) => sum + order.total_amount, 0),
          count: mine.length,
        }
      })
      .filter((row) => row.person && (storeId === 'all' || row.person.store_id === storeId))
      .sort((a, b) => (a.person!.store_id ?? 0) - (b.person!.store_id ?? 0) || a.person!.sort_order - b.person!.sort_order)
  }, [campaignId, campaignOrders, data, staffMap, storeId])

  const storeOrders = campaignOrders.filter((order) => storeId === 'all' || order.store_id === storeId)
  const recommenders = useMemo(() => {
    const ids = Array.from(new Set(storeOrders.map((order) => order.staff_id).filter((id): id is number => id !== null)))
    return ids.map((id) => staffMap.get(id)).filter((person): person is Staff => Boolean(person))
      .sort((a, b) => (a.store_id ?? 0) - (b.store_id ?? 0) || a.sort_order - b.sort_order)
  }, [staffMap, storeOrders])
  const listOrders = storeOrders
    .filter((order) => staffFilter === 'all' || order.staff_id === staffFilter)
    .filter((order) => showCancelled || !order.cancelled_at)
    .sort((a, b) => b.reserved_on.localeCompare(a.reserved_on))
  const activeOrders = listOrders.filter((order) => !order.cancelled_at)
  const listTotal = activeOrders.reduce((sum, order) => sum + order.total_amount, 0)

  useEffect(() => { setStaffFilter('all') }, [storeId, campaignId])

  if (error) return <main className="flex min-h-[100dvh] items-center justify-center bg-gray-50 p-6 text-center text-sm text-gray-500">{error}</main>
  if (!data) return <main className="flex min-h-[100dvh] items-center justify-center bg-gray-50 text-gray-400">読み込み中...</main>

  const campaign = data.campaigns.find((item) => item.id === campaignId)
  const staffLabel = (id: number | null) => {
    if (id === null) return '−'
    const person = staffMap.get(id)
    if (!person) return '−'
    const store = person.store_id !== null ? storeName.get(person.store_id) : null
    return storeId !== 'all' && person.store_id !== storeId && store ? `${person.name}（${store}）` : person.name
  }

  return (
    <main className="min-h-[100dvh] bg-pink-50/40 pb-16">
      <header className="sticky top-0 z-20 border-b bg-white px-4 py-3 shadow-sm">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="font-bold text-gray-800">先行予約（見るだけ）</h1>
            <p className="text-xs text-gray-400">予約の入力・修正は各店舗の予約ページから行います</p>
          </div>
          <select value={campaignId ?? ''} onChange={(event) => setCampaignId(Number(event.target.value))}
            className="rounded-xl border border-pink-200 bg-white px-3 py-2 text-base font-bold text-pink-800">
            {data.campaigns.map((item) => <option key={item.id} value={item.id}>{item.name}{item.is_active ? '' : '（受付終了）'}</option>)}
          </select>
        </div>
      </header>

      <div className="mx-auto max-w-4xl space-y-4 p-4">
        {campaign && (campaign.reception_start || campaign.reception_end) && (
          <p className="text-xs text-gray-500">受付期間：{campaign.reception_start?.replaceAll('-', '/') ?? ''} 〜 {campaign.reception_end?.replaceAll('-', '/') ?? ''}</p>
        )}
        <div className="flex flex-wrap gap-2">
          {([['all', '全店'], ...data.stores.map((store) => [store.id, store.name])] as [number | 'all', string][]).map(([id, label]) => (
            <button key={String(id)} onClick={() => setStoreId(id)}
              className={`rounded-full px-4 py-1.5 text-sm font-bold ${storeId === id ? 'bg-pink-600 text-white' : 'border border-gray-200 bg-white text-gray-600'}`}>{label}</button>
          ))}
        </div>

        <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
          <h2 className="font-bold text-gray-800">スタッフの目標と予約金額</h2>
          <p className="text-xs text-gray-400">お勧めしたスタッフで集計（キャンセルを除く・割引後の税込）。目標を入れた人だけ表示しています</p>
          {progress.length === 0 ? (
            <p className="py-6 text-center text-sm text-gray-400">目標が入っているスタッフはいません</p>
          ) : (
            <ul className="mt-3 space-y-2.5">
              {progress.map((row) => {
                const rate = row.goal > 0 ? Math.round((row.reserved / row.goal) * 100) : 0
                return (
                  <li key={row.person!.id}>
                    <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                      <span className="font-bold text-gray-800">
                        {row.person!.name}
                        {storeId === 'all' && <span className="ml-1.5 text-xs font-normal text-gray-400">{storeName.get(row.person!.store_id ?? -1)}</span>}
                      </span>
                      <span className="text-gray-600">
                        予約 <b className="text-pink-700">{yen(row.reserved)}</b> ／ 目標 {yen(row.goal)}
                        <span className={`ml-2 font-bold ${rate >= 100 ? 'text-green-700' : 'text-gray-700'}`}>{rate}%</span>
                        <span className="ml-2 text-xs text-gray-400">{row.count}件・お渡し済み {yen(row.delivered)}</span>
                      </span>
                    </div>
                    <div className="mt-1 h-2 overflow-hidden rounded-full bg-gray-100">
                      <div className={`h-full rounded-full ${rate >= 100 ? 'bg-green-500' : 'bg-pink-500'}`} style={{ width: `${Math.min(100, rate)}%` }} />
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <h2 className="font-bold text-gray-800">予約一覧</h2>
            <div className="flex flex-wrap items-center gap-3 text-xs text-gray-500">
              <label>お勧めした人
                <select value={staffFilter} onChange={(event) => setStaffFilter(event.target.value === 'all' ? 'all' : Number(event.target.value))}
                  className="ml-1 rounded-lg border border-gray-200 px-2 py-1.5 text-base text-gray-700">
                  <option value="all">全員</option>
                  {recommenders.map((person) => <option key={person.id} value={person.id}>{staffLabel(person.id)}</option>)}
                </select>
              </label>
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={showCancelled} onChange={(event) => setShowCancelled(event.target.checked)} className="h-4 w-4" />キャンセルも表示
              </label>
            </div>
          </div>
          <p className="mt-2 text-sm text-gray-600">{activeOrders.length}件・合計 <b className="text-pink-700">{yen(listTotal)}</b></p>
          <ul className="mt-2 divide-y divide-gray-100">
            {listOrders.map((order) => {
              const cancelled = Boolean(order.cancelled_at)
              return (
                <li key={order.id} className={`py-2.5 ${cancelled ? 'opacity-50' : ''}`}>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className={`font-bold text-gray-800 ${cancelled ? 'line-through' : ''}`}>{order.customer_name.replace(/\s*様$/, '')} 様</span>
                    <span className="text-sm font-bold text-pink-700">{yen(order.total_amount)}</span>
                  </div>
                  <div className="text-xs text-gray-500">
                    {order.reserved_on.slice(5).replace('-', '/')}・{storeName.get(order.store_id)}・お勧め {staffLabel(order.staff_id)}・担当 {staffLabel(order.stylist_id)}
                    {cancelled ? <span className="ml-1 text-red-500">キャンセル</span> : order.delivered_at ? <span className="ml-1 text-green-700">お渡し済み</span> : <span className="ml-1 text-amber-600">お渡し前</span>}
                  </div>
                  {order.note && <p className="mt-0.5 whitespace-pre-wrap rounded-md bg-yellow-50 px-2 py-1 text-xs text-yellow-900">メモ：{order.note}</p>}
                  <ul className="mt-0.5 text-sm text-gray-700">
                    {order.lines.map((line, index) => {
                      const product = productMap.get(line.product_id)
                      return (
                        <li key={index} className="break-words">
                          {product ? `${product.brand ? `${product.brand} ` : ''}${product.name}` : '商品'}
                          {line.reserved_qty != null && line.reserved_qty !== line.quantity
                            ? <span className="ml-1">予約{line.reserved_qty} → お渡し{line.quantity}（{line.reserved_qty - line.quantity}個キャンセル）</span>
                            : <> × {line.quantity}</>}
                        </li>
                      )
                    })}
                  </ul>
                </li>
              )
            })}
          </ul>
          {listOrders.length === 0 && <p className="py-6 text-center text-sm text-gray-400">予約はまだありません</p>}
        </section>
      </div>
    </main>
  )
}

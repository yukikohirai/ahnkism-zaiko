'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { fetchAll } from '@/lib/fetchAll'
import { yen } from '@/lib/tax'
import {
  discountLabel, priceOrder, regularPriceWithTax, todayInTokyo,
  type BulkTier, type PortalAccess, type PresaleCampaign, type PresaleItemWithProduct, type PresaleOrder, type Staff, type StaffGoal,
} from '@/lib/presale'

type Store = { id: number; name: string }
type DraftLine = { product_id: string; quantity: string; discount_type: '' | 'percent' | 'yen'; discount_value: string }
type Draft = {
  id: string | null
  store_id: number | null
  reserved_on: string
  customer_name: string
  stylist_id: string
  staff_id: string
  lines: DraftLine[]
}

function emptyDraft(storeId: number | null): Draft {
  return { id: null, store_id: storeId, reserved_on: todayInTokyo(), customer_name: '', stylist_id: '', staff_id: '', lines: [{ product_id: '', quantity: '1', discount_type: '', discount_value: '' }] }
}

function normalize(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, '')
}

type PortalData = {
  campaigns: PresaleCampaign[]
  items: PresaleItemWithProduct[]
  tiers: BulkTier[]
  staff: Staff[]
  goals: StaffGoal[]
  orders: PresaleOrder[]
  item_sort?: ItemSort[]
}

type ItemSort = { store_id: number; product_id: number; sort_order: number }

// 先行予約の入力・一覧・スタッフの目標と実績。
// 本部画面（access = null、全店）と店舗の予約ページ（合言葉＋暗証番号、自店だけ）で共用する
export default function ReservationPanel({ campaign, storeId, stores, access }: {
  campaign: PresaleCampaign
  storeId: number | null
  stores: Store[]
  access: PortalAccess
}) {
  const [items, setItems] = useState<PresaleItemWithProduct[]>([])
  const [tiers, setTiers] = useState<BulkTier[]>([])
  const [staff, setStaff] = useState<Staff[]>([])
  const [goals, setGoals] = useState<StaffGoal[]>([])
  const [orders, setOrders] = useState<PresaleOrder[]>([])
  // 店舗ごとの商品の並び（本部が設定）。設定していない商品は後ろに名前順
  const [itemSort, setItemSort] = useState<ItemSort[]>([])
  const [draft, setDraft] = useState<Draft>(emptyDraft(storeId))
  const [filterStore, setFilterStore] = useState<number | 'all'>('all')
  const [search, setSearch] = useState('')
  const [onlyOpen, setOnlyOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (access) {
      const { data, error: loadError } = await supabase.rpc('presale_portal_data', { p_token: access.token, p_pin: access.pin })
      if (loadError) { setError(loadError.message); return }
      const portal = data as PortalData
      setItems(portal.items.filter((item) => item.campaign_id === campaign.id))
      setTiers(portal.tiers.filter((tier) => tier.campaign_id === campaign.id))
      setStaff(portal.staff)
      setGoals(portal.goals.filter((goal) => goal.campaign_id === campaign.id))
      setOrders(portal.orders.filter((order) => order.campaign_id === campaign.id))
      setItemSort(portal.item_sort ?? [])
      return
    }
    const [itemResult, tierResult, staffResult, goalResult, orderResult, lineResult, sortResult] = await Promise.all([
      supabase.from('presale_items').select('*, product:products!inner(brand, name, sale_price)').eq('campaign_id', campaign.id),
      supabase.from('presale_bulk_tiers').select('*').eq('campaign_id', campaign.id),
      supabase.from('staff').select('*').order('sort_order').order('id'),
      supabase.from('presale_staff_goals').select('*').eq('campaign_id', campaign.id),
      fetchAll((start, end) => supabase.from('presale_orders').select('*').eq('campaign_id', campaign.id).order('id').range(start, end)),
      fetchAll((start, end) => supabase.from('presale_order_lines').select('*, presale_orders!inner(campaign_id)')
        .eq('presale_orders.campaign_id', campaign.id).order('id').range(start, end)),
      supabase.from('presale_store_item_sort').select('store_id, product_id, sort_order'),
    ])
    if (itemResult.error || tierResult.error || staffResult.error || goalResult.error || orderResult.error || lineResult.error) {
      setError('データを読み込めませんでした。')
    }
    setItems((itemResult.data ?? []).map((row) => {
      const product = Array.isArray(row.product) ? row.product[0] : row.product
      return { ...row, brand: product.brand, name: product.name, sale_price: product.sale_price } as PresaleItemWithProduct
    }))
    setTiers((tierResult.data ?? []) as BulkTier[])
    setItemSort((sortResult.data ?? []) as ItemSort[])
    setStaff((staffResult.data ?? []) as Staff[])
    setGoals((goalResult.data ?? []) as StaffGoal[])
    const linesByOrder = new Map<string, PresaleOrder['lines']>()
    ;(lineResult.data ?? []).forEach((line) => linesByOrder.set(line.order_id, [...(linesByOrder.get(line.order_id) ?? []), line]))
    setOrders(((orderResult.data ?? []) as PresaleOrder[]).map((order) => ({ ...order, lines: linesByOrder.get(order.id) ?? [] })))
  }, [access, campaign.id])

  useEffect(() => { void load() }, [load])

  const itemMap = useMemo(() => new Map(items.map((item) => [item.product_id, item])), [items])
  const sortedItems = useMemo(() => {
    const order = new Map(itemSort.filter((row) => row.store_id === draft.store_id).map((row) => [row.product_id, row.sort_order]))
    const LAST = Number.MAX_SAFE_INTEGER
    return [...items].sort((a, b) => (order.get(a.product_id) ?? LAST) - (order.get(b.product_id) ?? LAST)
      || `${a.brand ?? ''}${a.name}`.localeCompare(`${b.brand ?? ''}${b.name}`, 'ja'))
  }, [draft.store_id, itemSort, items])
  const staffMap = useMemo(() => new Map(staff.map((person) => [person.id, person])), [staff])
  const storeName = useMemo(() => new Map(stores.map((store) => [store.id, store.name])), [stores])
  const formStaff = staff.filter((person) => person.is_active && person.store_id === draft.store_id)
  const rpcAccess = { p_token: access?.token ?? null, p_pin: access?.pin ?? null }

  const draftLines = draft.lines
    .filter((line) => line.product_id && parseInt(line.quantity, 10) > 0)
    .map((line) => ({
      product_id: Number(line.product_id),
      quantity: parseInt(line.quantity, 10),
      discount_type: line.discount_type || null,
      discount_value: line.discount_type ? Number(line.discount_value || 0) : null,
    }))
  const estimate = priceOrder(draftLines, itemMap, tiers)
  const sortedTiers = [...tiers].sort((a, b) => a.min_qty - b.min_qty)
  const nextTier = sortedTiers.find((tier) => tier.min_qty > estimate.count)

  function setLine(index: number, patch: Partial<DraftLine>) {
    setDraft((previous) => ({ ...previous, lines: previous.lines.map((line, i) => i === index ? { ...line, ...patch } : line) }))
  }

  function startEdit(order: PresaleOrder) {
    setDraft({
      id: order.id,
      store_id: order.store_id,
      reserved_on: order.reserved_on,
      customer_name: order.customer_name,
      stylist_id: order.stylist_id ? String(order.stylist_id) : '',
      staff_id: order.staff_id ? String(order.staff_id) : '',
      lines: order.lines.map((line) => ({
        product_id: String(line.product_id),
        quantity: String(line.quantity),
        discount_type: line.line_discount_type ?? '',
        discount_value: line.line_discount_value != null ? String(line.line_discount_value) : '',
      })),
    })
    setMessage('')
    setError('')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  async function save() {
    if (!draft.store_id) { setError('店舗を選んでください。'); return }
    if (!draft.customer_name.trim()) { setError('お客様の氏名を入力してください。'); return }
    if (!draft.stylist_id) { setError('担当スタイリストを選んでください。'); return }
    if (!draft.staff_id) { setError('お勧めしたスタッフを選んでください。'); return }
    if (draftLines.length === 0) { setError('商品と数量を入れてください。'); return }
    if (estimate.missingPrice) { setError('販売価格が未入力の商品があります。本部に価格の入力を依頼してください。'); return }
    setSaving(true)
    setError('')
    const { error: saveError } = await supabase.rpc('save_presale_order', {
      p_store_id: draft.store_id,
      ...rpcAccess,
      p_order: {
        id: draft.id,
        campaign_id: campaign.id,
        reserved_on: draft.reserved_on,
        customer_name: draft.customer_name.trim(),
        stylist_id: draft.stylist_id,
        staff_id: draft.staff_id,
        lines: draftLines,
      },
    })
    setSaving(false)
    if (saveError) { setError(saveError.message); return }
    setMessage(draft.id ? '予約を修正しました。' : `${draft.customer_name.trim()}様の予約を登録しました（${yen(estimate.total)}）。`)
    // 続けて入力しやすいよう、日付とお勧めしたスタッフは残す
    setDraft((previous) => ({ ...emptyDraft(storeId), store_id: previous.store_id, reserved_on: previous.reserved_on, staff_id: previous.staff_id }))
    await load()
  }

  async function toggleDelivered(order: PresaleOrder) {
    const next = !order.delivered_at
    if (!next && !confirm('お渡し済みを取り消します。在庫も元に戻ります。よろしいですか？')) return
    setBusyId(order.id)
    setError('')
    const { error: rpcError } = await supabase.rpc('set_presale_order_delivered', { p_store_id: order.store_id, ...rpcAccess, p_order_id: order.id, p_delivered: next })
    setBusyId('')
    if (rpcError) { setError(rpcError.message); return }
    await load()
  }

  async function toggleCancelled(order: PresaleOrder) {
    const cancelling = !order.cancelled_at
    if (!confirm(cancelling ? `${order.customer_name}様の予約をキャンセルにします。よろしいですか？` : 'キャンセルを取り消して、予約に戻します。よろしいですか？')) return
    setBusyId(order.id)
    setError('')
    const { error: rpcError } = await supabase.rpc('set_presale_order_cancelled', { p_store_id: order.store_id, ...rpcAccess, p_order_id: order.id, p_cancelled: cancelling })
    setBusyId('')
    if (rpcError) { setError(rpcError.message); return }
    await load()
  }

  const scopedOrders = orders.filter((order) => filterStore === 'all' || order.store_id === filterStore)

  // 未渡し → お渡し済み → キャンセル の順。同じ中では予約日の新しい順
  const visible = useMemo(() => {
    const keyword = normalize(search)
    const rank = (order: PresaleOrder) => (order.cancelled_at ? 2 : order.delivered_at ? 1 : 0)
    return scopedOrders
      .filter((order) => !onlyOpen || (!order.delivered_at && !order.cancelled_at))
      .filter((order) => !keyword || normalize(`${order.customer_name}${order.lines.map((line) => itemMap.get(line.product_id)?.name ?? '').join('')}`).includes(keyword))
      .sort((a, b) => rank(a) - rank(b) || b.reserved_on.localeCompare(a.reserved_on) || b.created_at.localeCompare(a.created_at))
  }, [itemMap, onlyOpen, scopedOrders, search])

  const active = scopedOrders.filter((order) => !order.cancelled_at)
  const totals = {
    count: active.length,
    delivered: active.filter((order) => order.delivered_at).length,
    amount: active.reduce((sum, order) => sum + order.total_amount, 0),
  }

  // スタッフごとの目標と実績（お勧めしたスタッフで集計、キャンセル除く、割引後の税込）
  const progress = useMemo(() => {
    const goalMap = new Map(goals.map((goal) => [goal.staff_id, goal.goal_amount]))
    const targetStores = storeId !== null ? [storeId] : filterStore === 'all' ? stores.map((store) => store.id) : [filterStore]
    return staff
      .filter((person) => targetStores.includes(person.store_id))
      .map((person) => {
        const mine = orders.filter((order) => !order.cancelled_at && order.staff_id === person.id)
        return {
          person,
          goal: goalMap.get(person.id) ?? 0,
          reserved: mine.reduce((sum, order) => sum + order.total_amount, 0),
          delivered: mine.filter((order) => order.delivered_at).reduce((sum, order) => sum + order.total_amount, 0),
          count: mine.length,
        }
      })
      .filter((row) => row.person.is_active || row.count > 0)
  }, [filterStore, goals, orders, staff, storeId, stores])

  return (
    <div className="space-y-4">
      <section className={`rounded-2xl border bg-white p-4 shadow-sm ${draft.id ? 'border-amber-300' : 'border-gray-200'}`}>
        <h2 className="mb-1 font-bold text-gray-800">{draft.id ? '予約を修正' : '予約を登録'}</h2>
        {sortedTiers.length > 0 && (
          <p className="mb-3 text-xs text-pink-700">まとめ買い：{sortedTiers.map((tier) => `${tier.min_qty}個以上で${Number(tier.percent)}%オフ`).join('／')}（美容機器は個数に含みません）</p>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          {storeId === null && (
            <label className="block text-xs font-medium text-gray-500">店舗
              <select value={draft.store_id ?? ''} onChange={(event) => setDraft({ ...draft, store_id: Number(event.target.value), stylist_id: '', staff_id: '' })}
                className="mt-1 block w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-base">
                <option value="">選んでください</option>
                {stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}
              </select>
            </label>
          )}
          <label className="block text-xs font-medium text-gray-500">予約を取った日
            <input type="date" value={draft.reserved_on} onChange={(event) => setDraft({ ...draft, reserved_on: event.target.value })}
              className="mt-1 block w-full rounded-xl border border-gray-200 px-3 py-2.5 text-base" />
          </label>
          <label className="block text-xs font-medium text-gray-500">お客様の氏名
            <input value={draft.customer_name} onChange={(event) => setDraft({ ...draft, customer_name: event.target.value })} placeholder="例：山田 花子"
              className="mt-1 block w-full rounded-xl border border-gray-200 px-3 py-2.5 text-base" />
          </label>
          <label className="block text-xs font-medium text-gray-500">担当スタイリスト
            <select value={draft.stylist_id} onChange={(event) => setDraft({ ...draft, stylist_id: event.target.value })}
              className="mt-1 block w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-base">
              <option value="">選んでください</option>
              {formStaff.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
            </select>
          </label>
          <label className="block text-xs font-medium text-gray-500">お勧めしたスタッフ
            <select value={draft.staff_id} onChange={(event) => setDraft({ ...draft, staff_id: event.target.value })}
              className="mt-1 block w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-base">
              <option value="">選んでください</option>
              {formStaff.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
            </select>
          </label>
        </div>
        {draft.store_id !== null && formStaff.length === 0 && (
          <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">この店舗のスタッフ名簿がまだありません。本部に登録を依頼してください。</p>
        )}

        <div className="mt-4 space-y-2">
          <div className="text-xs font-medium text-gray-500">商品と数量</div>
          {draft.lines.map((line, index) => {
            const pricedIndex = draft.lines.slice(0, index).filter((item) => item.product_id && parseInt(item.quantity, 10) > 0).length
            const priced = line.product_id && parseInt(line.quantity, 10) > 0 ? estimate.lines[pricedIndex] : undefined
            const item = line.product_id ? itemMap.get(Number(line.product_id)) : undefined
            return (
              <div key={index} className="rounded-xl border border-gray-100 bg-gray-50 p-2">
                <div className="flex gap-2">
                  <select value={line.product_id} onChange={(event) => setLine(index, { product_id: event.target.value })}
                    className="min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-2 py-2 text-base">
                    <option value="">商品を選ぶ</option>
                    {sortedItems.map((option) => (
                      <option key={option.product_id} value={option.product_id}>{option.brand ? `${option.brand} ` : ''}{option.name}</option>
                    ))}
                  </select>
                  <input inputMode="numeric" value={line.quantity} onChange={(event) => setLine(index, { quantity: event.target.value })}
                    className="w-16 rounded-lg border border-gray-200 bg-white px-2 py-2 text-center text-base font-bold" />
                  <button onClick={() => setDraft((previous) => ({ ...previous, lines: previous.lines.length > 1 ? previous.lines.filter((_, i) => i !== index) : [{ product_id: '', quantity: '1', discount_type: '', discount_value: '' }] }))}
                    className="shrink-0 rounded-lg px-2 text-lg text-gray-400" aria-label="この行を削除">×</button>
                </div>
                {item && (
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 px-1 text-xs">
                    <span className="text-gray-400">この行だけの割引</span>
                    <div className="flex rounded-md bg-white p-0.5 shadow-sm">
                      {(['', 'percent', 'yen'] as const).map((type) => (
                        <button key={type || 'none'} onClick={() => setLine(index, { discount_type: type, discount_value: type ? line.discount_value : '' })}
                          className={`rounded px-2 py-0.5 font-bold ${line.discount_type === type ? 'bg-pink-500 text-white' : 'text-gray-500'}`}>
                          {type === '' ? 'なし' : type === 'percent' ? '%' : '円'}
                        </button>
                      ))}
                    </div>
                    {line.discount_type && (
                      <input inputMode="decimal" value={line.discount_value} onChange={(event) => setLine(index, { discount_value: event.target.value })}
                        placeholder="0" className="w-16 rounded-md border border-pink-200 bg-white px-1.5 py-0.5 text-right text-base" />
                    )}
                    {line.discount_type && <span className="text-gray-500">{line.discount_type === 'percent' ? '%オフ' : '円引き'}</span>}
                  </div>
                )}
                {item && (
                  <div className="mt-1 flex flex-wrap items-center justify-between gap-2 px-1 text-xs">
                    <span className="text-gray-500">
                      通常 {yen(regularPriceWithTax(item.sale_price))}・{item.bulk_excluded ? '美容機器（まとめ買い対象外）・' : ''}
                      {line.discount_type ? `この行だけ${discountLabel(line.discount_type, Number(line.discount_value || 0))}`
                        : estimate.percent !== null && !item.bulk_excluded ? `まとめ買い${estimate.percent}%オフ` : discountLabel(item.discount_type, Number(item.discount_value))}
                    </span>
                    <span className="font-bold text-blue-700">{priced ? `${yen(priced.unit_price)} × ${priced.quantity} ＝ ${yen((priced.unit_price ?? 0) * priced.quantity)}` : ''}</span>
                  </div>
                )}
              </div>
            )
          })}
          <button onClick={() => setDraft((previous) => ({ ...previous, lines: [...previous.lines, { product_id: '', quantity: '1', discount_type: '', discount_value: '' }] }))}
            className="w-full rounded-xl border border-dashed border-gray-300 py-2 text-sm text-gray-600">＋ 商品を追加</button>
        </div>

        <div className="mt-3 flex flex-wrap items-end justify-between gap-2 rounded-xl bg-blue-50 px-4 py-3">
          <div className="text-xs text-gray-600">
            まとめ買いの個数 {estimate.count}個{estimate.percent !== null ? `（${estimate.percent}%オフ適用）` : ''}
            {nextTier && <div className="text-pink-700">あと{nextTier.min_qty - estimate.count}個で{Number(nextTier.percent)}%オフ</div>}
          </div>
          <div className="text-xl font-bold text-blue-700">合計 {yen(estimate.total)}<span className="ml-1 text-xs font-normal">（税込）</span></div>
        </div>
        {message && <p className="mt-3 rounded-xl bg-green-50 px-3 py-2 text-sm text-green-700">{message}</p>}
        {error && <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
        <div className="mt-4 flex gap-2">
          {draft.id && <button onClick={() => setDraft(emptyDraft(storeId))} className="flex-1 rounded-xl border border-gray-200 py-3 text-sm text-gray-600">やめる</button>}
          <button onClick={() => void save()} disabled={saving} className="flex-1 rounded-xl bg-blue-500 py-3 font-bold text-white disabled:opacity-50">
            {saving ? '保存中...' : draft.id ? '修正を保存' : '予約を登録'}
          </button>
        </div>
      </section>

      <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        <h2 className="mb-3 font-bold text-gray-800">スタッフの目標と予約金額</h2>
        <div className="space-y-2">
          {progress.map(({ person, goal, reserved, delivered, count }) => {
            const ratio = goal > 0 ? Math.min(100, Math.round((reserved / goal) * 100)) : 0
            return (
              <div key={person.id}>
                <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                  <span className="font-bold text-gray-800">{person.name}{storeId === null && <span className="ml-1 text-[11px] font-normal text-gray-400">{storeName.get(person.store_id)}</span>}</span>
                  <span className="text-xs text-gray-600">
                    予約 <b className="text-blue-700">{yen(reserved)}</b>（{count}件）／目標 {goal > 0 ? yen(goal) : '未設定'}
                    {goal > 0 && <b className="ml-1 text-pink-700">{Math.round((reserved / goal) * 100)}%</b>}
                    <span className="ml-2 text-green-700">お渡し済み {yen(delivered)}</span>
                  </span>
                </div>
                {goal > 0 && <div className="mt-1 h-2 overflow-hidden rounded-full bg-gray-100"><div className="h-full rounded-full bg-pink-500" style={{ width: `${ratio}%` }} /></div>}
              </div>
            )
          })}
          {progress.length === 0 && <p className="py-4 text-center text-sm text-gray-400">スタッフ名簿がありません</p>}
        </div>
      </section>

      <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-bold text-gray-800">予約一覧</h2>
          <span className="text-xs text-gray-500">予約 {totals.count}件（お渡し済み {totals.delivered}件）・合計 {yen(totals.amount)}</span>
        </div>
        <div className="mb-3 grid gap-2 sm:grid-cols-3">
          {storeId === null && (
            <select value={filterStore} onChange={(event) => setFilterStore(event.target.value === 'all' ? 'all' : Number(event.target.value))}
              className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-base">
              <option value="all">全店舗</option>
              {stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}
            </select>
          )}
          <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="お客様名・商品名で検索"
            className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-base outline-none focus:border-blue-400" />
          <label className="flex items-center gap-2 rounded-xl bg-gray-50 px-3 py-2 text-sm text-gray-600">
            <input type="checkbox" checked={onlyOpen} onChange={(event) => setOnlyOpen(event.target.checked)} className="h-4 w-4" />
            まだお渡ししていない予約だけ
          </label>
        </div>
        <div className="divide-y divide-gray-100">
          {visible.map((order) => {
            const delivered = !!order.delivered_at
            const cancelled = !!order.cancelled_at
            return (
              <div key={order.id} className={`flex items-start gap-3 px-2 py-3 ${cancelled ? 'bg-gray-50 opacity-50' : delivered ? 'bg-green-50' : ''}`}>
                <label className="flex shrink-0 flex-col items-center gap-0.5 pt-0.5 text-[10px] text-gray-500">
                  <input type="checkbox" checked={delivered} disabled={cancelled || busyId === order.id} onChange={() => void toggleDelivered(order)} className="h-6 w-6 accent-green-600" />
                  お渡し
                </label>
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] text-gray-400">
                    {order.reserved_on}{storeId === null && `・${storeName.get(order.store_id) ?? ''}`}
                    ・担当 {staffMap.get(order.stylist_id ?? 0)?.name ?? '−'}・お勧め {staffMap.get(order.staff_id ?? 0)?.name ?? '−'}
                  </div>
                  <div className={`font-bold text-gray-800 ${cancelled ? 'line-through' : ''}`}>
                    {order.customer_name} 様
                    {order.applied_percent !== null && <span className="ml-2 rounded bg-pink-100 px-1.5 py-0.5 text-[10px] text-pink-700">まとめ買い{Number(order.applied_percent)}%</span>}
                  </div>
                  <ul className="mt-0.5 space-y-0.5 text-sm text-gray-700">
                    {order.lines.map((line) => {
                      const item = itemMap.get(line.product_id)
                      return (
                        <li key={line.id ?? line.product_id} className="break-words">
                          {item ? `${item.brand ? `${item.brand} ` : ''}${item.name}` : '（対象外になった商品）'} × {line.quantity}
                          <span className="ml-1 text-xs text-gray-500">{yen(line.unit_price)}</span>
                          {line.line_discount_type && <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] text-amber-700">個別{discountLabel(line.line_discount_type, Number(line.line_discount_value ?? 0))}</span>}
                        </li>
                      )
                    })}
                  </ul>
                  <div className="text-sm font-bold text-gray-800">合計 {yen(order.total_amount)}</div>
                  {delivered && <div className="mt-0.5 text-[11px] font-bold text-green-700">お渡し済み（{new Date(order.delivered_at!).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' })}）</div>}
                  {cancelled && <div className="mt-0.5 text-[11px] font-bold text-gray-500">キャンセル</div>}
                </div>
                <div className="flex shrink-0 flex-col gap-1.5">
                  {!delivered && !cancelled && <button onClick={() => startEdit(order)} className="rounded-lg bg-blue-50 px-2.5 py-1.5 text-xs font-medium text-blue-700">修正</button>}
                  {!delivered && (
                    <button onClick={() => void toggleCancelled(order)} disabled={busyId === order.id} className="rounded-lg bg-gray-100 px-2.5 py-1.5 text-xs text-gray-600">
                      {cancelled ? '予約に戻す' : 'キャンセル'}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
          {visible.length === 0 && <p className="py-8 text-center text-sm text-gray-400">予約はまだありません</p>}
        </div>
      </section>
    </div>
  )
}

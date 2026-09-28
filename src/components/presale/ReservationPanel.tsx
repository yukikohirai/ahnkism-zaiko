'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { fetchAll } from '@/lib/fetchAll'
import { yen } from '@/lib/tax'
import {
  discountedPrice, discountLabel, regularPriceWithTax, todayInTokyo,
  type PresaleCampaign, type PresaleItem, type Reservation, type Staff,
} from '@/lib/presale'

type Store = { id: number; name: string }
type ItemProduct = PresaleItem & { product: { id: number; brand: string | null; name: string; sale_price: number | null } }

type Draft = {
  store_id: number | null
  reserved_on: string
  customer_name: string
  stylist_id: string
  staff_id: string
  product_id: string
  quantity: string
}

function emptyDraft(storeId: number | null): Draft {
  return { store_id: storeId, reserved_on: todayInTokyo(), customer_name: '', stylist_id: '', staff_id: '', product_id: '', quantity: '1' }
}

function normalize(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, '')
}

// 先行予約の入力と一覧。店舗画面（storeId 固定）と本部画面（全店）で共用する
export default function ReservationPanel({ campaign, storeId, stores }: { campaign: PresaleCampaign; storeId: number | null; stores: Store[] }) {
  const [items, setItems] = useState<ItemProduct[]>([])
  const [staff, setStaff] = useState<Staff[]>([])
  const [reservations, setReservations] = useState<Reservation[]>([])
  const [draft, setDraft] = useState<Draft>(emptyDraft(storeId))
  const [editingId, setEditingId] = useState<string | null>(null)
  const [filterStore, setFilterStore] = useState<number | 'all'>('all')
  const [search, setSearch] = useState('')
  const [onlyOpen, setOnlyOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    const [itemResult, staffResult, reservationResult] = await Promise.all([
      supabase.from('presale_items')
        .select('campaign_id, product_id, discount_type, discount_value, product:products!inner(id, brand, name, sale_price)')
        .eq('campaign_id', campaign.id),
      supabase.from('staff').select('id, store_id, name, sort_order, is_active').order('sort_order').order('id'),
      fetchAll((start, end) => {
        let query = supabase.from('presale_reservations').select('*').eq('campaign_id', campaign.id)
        if (storeId !== null) query = query.eq('store_id', storeId)
        return query.order('created_at').order('id').range(start, end)
      }),
    ])
    if (itemResult.error || staffResult.error || reservationResult.error) setError('データを読み込めませんでした。')
    setItems(((itemResult.data ?? []) as unknown as ItemProduct[]).map((item) => ({
      ...item,
      discount_value: Number(item.discount_value),
      product: Array.isArray(item.product) ? item.product[0] : item.product,
    })).sort((a, b) => `${a.product.brand ?? ''}${a.product.name}`.localeCompare(`${b.product.brand ?? ''}${b.product.name}`, 'ja')))
    setStaff((staffResult.data ?? []) as Staff[])
    setReservations((reservationResult.data ?? []) as Reservation[])
  }, [campaign.id, storeId])

  useEffect(() => { void load() }, [load])

  const itemMap = useMemo(() => new Map(items.map((item) => [item.product_id, item])), [items])
  const staffMap = useMemo(() => new Map(staff.map((person) => [person.id, person])), [staff])
  const storeName = useMemo(() => new Map(stores.map((store) => [store.id, store.name])), [stores])
  const staffForStore = (id: number | null) => staff.filter((person) => person.is_active && person.store_id === id)

  const selectedItem = draft.product_id ? itemMap.get(Number(draft.product_id)) : undefined
  const regular = selectedItem ? regularPriceWithTax(selectedItem.product.sale_price) : null
  const unit = selectedItem ? discountedPrice(regular, selectedItem.discount_type, selectedItem.discount_value) : null
  const quantity = parseInt(draft.quantity, 10)

  function startEdit(row: Reservation) {
    setEditingId(row.id)
    setDraft({
      store_id: row.store_id,
      reserved_on: row.reserved_on,
      customer_name: row.customer_name,
      stylist_id: row.stylist_id ? String(row.stylist_id) : '',
      staff_id: row.staff_id ? String(row.staff_id) : '',
      product_id: String(row.product_id),
      quantity: String(row.quantity),
    })
    setMessage('')
    setError('')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function cancelEdit() {
    setEditingId(null)
    setDraft(emptyDraft(storeId))
  }

  async function save() {
    if (!draft.store_id) { setError('店舗を選んでください。'); return }
    if (!draft.customer_name.trim()) { setError('お客様の名前を入力してください。'); return }
    if (!draft.stylist_id) { setError('担当スタイリストを選んでください。'); return }
    if (!draft.staff_id) { setError('登録スタッフを選んでください。'); return }
    if (!selectedItem) { setError('商品を選んでください。'); return }
    if (!Number.isFinite(quantity) || quantity < 1) { setError('数量は1以上で入力してください。'); return }
    if (unit === null) { setError('この商品は販売価格が未入力です。本部に価格の入力を依頼してください。'); return }
    setSaving(true)
    setError('')
    const editing = editingId ? reservations.find((row) => row.id === editingId) : undefined
    // 修正で商品を変えなければ、予約時の金額はそのまま（あとで割引が変わっても予約済みの金額は変えない）
    const keepPrice = editing && editing.product_id === selectedItem.product_id
    const payload = {
      campaign_id: campaign.id,
      store_id: draft.store_id,
      reserved_on: draft.reserved_on,
      customer_name: draft.customer_name.trim(),
      stylist_id: Number(draft.stylist_id),
      staff_id: Number(draft.staff_id),
      product_id: selectedItem.product_id,
      quantity,
      regular_price: keepPrice ? editing.regular_price : regular,
      unit_price: keepPrice ? editing.unit_price : unit,
      updated_at: new Date().toISOString(),
    }
    const { error: saveError } = editingId
      ? await supabase.from('presale_reservations').update(payload).eq('id', editingId)
      : await supabase.from('presale_reservations').insert(payload)
    setSaving(false)
    if (saveError) { setError(saveError.message); return }
    setMessage(editingId ? '予約を修正しました。' : `${payload.customer_name}様の予約を登録しました。`)
    // 続けて入力しやすいよう、日付・スタッフは残す
    setDraft((previous) => ({ ...emptyDraft(storeId), store_id: previous.store_id, reserved_on: previous.reserved_on, staff_id: previous.staff_id }))
    setEditingId(null)
    await load()
  }

  async function toggleDelivered(row: Reservation) {
    const next = !row.delivered_at
    if (!next && !confirm('お渡し済みを取り消します。在庫も元に戻ります。よろしいですか？')) return
    setBusyId(row.id)
    setError('')
    const { error: rpcError } = await supabase.rpc('set_presale_delivered', { p_id: row.id, p_delivered: next })
    setBusyId('')
    if (rpcError) { setError(rpcError.message); return }
    await load()
  }

  async function toggleCancelled(row: Reservation) {
    const cancelling = !row.cancelled_at
    if (!confirm(cancelling ? `${row.customer_name}様の予約をキャンセルにします。よろしいですか？` : 'キャンセルを取り消して、予約に戻します。よろしいですか？')) return
    setBusyId(row.id)
    setError('')
    const { error: updateError } = await supabase.from('presale_reservations')
      .update({ cancelled_at: cancelling ? new Date().toISOString() : null, updated_at: new Date().toISOString() }).eq('id', row.id)
    setBusyId('')
    if (updateError) { setError(updateError.message); return }
    await load()
  }

  // 未渡し → お渡し済み → キャンセル の順。同じ中では予約日の新しい順
  const visible = useMemo(() => {
    const keyword = normalize(search)
    const rank = (row: Reservation) => (row.cancelled_at ? 2 : row.delivered_at ? 1 : 0)
    return reservations
      .filter((row) => filterStore === 'all' || row.store_id === filterStore)
      .filter((row) => !onlyOpen || (!row.delivered_at && !row.cancelled_at))
      .filter((row) => !keyword || normalize(`${row.customer_name}${itemMap.get(row.product_id)?.product.name ?? ''}`).includes(keyword))
      .sort((a, b) => rank(a) - rank(b) || b.reserved_on.localeCompare(a.reserved_on) || b.created_at.localeCompare(a.created_at))
  }, [filterStore, itemMap, onlyOpen, reservations, search])

  const counts = useMemo(() => {
    const active = reservations.filter((row) => !row.cancelled_at && (filterStore === 'all' || row.store_id === filterStore))
    return {
      total: active.length,
      delivered: active.filter((row) => row.delivered_at).length,
      amount: active.reduce((sum, row) => sum + (row.unit_price ?? 0) * row.quantity, 0),
    }
  }, [filterStore, reservations])

  const formStaff = staffForStore(draft.store_id)

  return (
    <div className="space-y-4">
      <section className={`rounded-2xl border bg-white p-4 shadow-sm ${editingId ? 'border-amber-300' : 'border-gray-200'}`}>
        <h2 className="mb-3 font-bold text-gray-800">{editingId ? '予約を修正' : '予約を登録'}</h2>
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
          <label className="block text-xs font-medium text-gray-500">登録したスタッフ
            <select value={draft.staff_id} onChange={(event) => setDraft({ ...draft, staff_id: event.target.value })}
              className="mt-1 block w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-base">
              <option value="">選んでください</option>
              {formStaff.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
            </select>
          </label>
        </div>
        {draft.store_id !== null && formStaff.length === 0 && (
          <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">この店舗のスタッフ名簿がまだ登録されていません。本部の「先行予約」→「スタッフ名簿」で登録してください。</p>
        )}
        <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_6rem]">
          <label className="block text-xs font-medium text-gray-500">商品
            <select value={draft.product_id} onChange={(event) => setDraft({ ...draft, product_id: event.target.value })}
              className="mt-1 block w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-base">
              <option value="">選んでください</option>
              {items.map((item) => (
                <option key={item.product_id} value={item.product_id}>{item.product.brand ? `${item.product.brand} ` : ''}{item.product.name}</option>
              ))}
            </select>
          </label>
          <label className="block text-xs font-medium text-gray-500">数量
            <input inputMode="numeric" value={draft.quantity} onChange={(event) => setDraft({ ...draft, quantity: event.target.value })}
              className="mt-1 block w-full rounded-xl border border-gray-200 px-3 py-2.5 text-center text-base font-bold" />
          </label>
        </div>
        {selectedItem && (
          <div className="mt-3 flex flex-wrap items-baseline justify-between gap-2 rounded-xl bg-blue-50 px-4 py-3">
            <div className="text-xs text-gray-500">
              通常 <span className="line-through">{yen(regular)}</span>（税込）・{discountLabel(selectedItem.discount_type, selectedItem.discount_value)}
            </div>
            <div className="text-right">
              <div className="text-xs text-gray-500">1個 {yen(unit)}</div>
              <div className="text-xl font-bold text-blue-700">合計 {unit === null || !Number.isFinite(quantity) ? '−' : yen(unit * quantity)}</div>
            </div>
          </div>
        )}
        {message && <p className="mt-3 rounded-xl bg-green-50 px-3 py-2 text-sm text-green-700">{message}</p>}
        {error && <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
        <div className="mt-4 flex gap-2">
          {editingId && <button onClick={cancelEdit} className="flex-1 rounded-xl border border-gray-200 py-3 text-sm text-gray-600">やめる</button>}
          <button onClick={() => void save()} disabled={saving} className="flex-1 rounded-xl bg-blue-500 py-3 font-bold text-white disabled:opacity-50">
            {saving ? '保存中...' : editingId ? '修正を保存' : '予約を登録'}
          </button>
        </div>
      </section>

      <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-bold text-gray-800">予約一覧</h2>
          <span className="text-xs text-gray-500">予約 {counts.total}件（お渡し済み {counts.delivered}件）・合計 {yen(counts.amount)}</span>
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
          {visible.map((row) => {
            const item = itemMap.get(row.product_id)
            const delivered = !!row.delivered_at
            const cancelled = !!row.cancelled_at
            return (
              <div key={row.id} className={`flex items-start gap-3 px-2 py-3 ${cancelled ? 'bg-gray-50 opacity-50' : delivered ? 'bg-green-50' : ''}`}>
                <label className="flex shrink-0 flex-col items-center gap-0.5 pt-0.5 text-[10px] text-gray-500">
                  <input type="checkbox" checked={delivered} disabled={cancelled || busyId === row.id} onChange={() => void toggleDelivered(row)} className="h-6 w-6 accent-green-600" />
                  お渡し
                </label>
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] text-gray-400">
                    {row.reserved_on}{storeId === null && `・${storeName.get(row.store_id) ?? ''}`}
                    ・担当 {staffMap.get(row.stylist_id ?? 0)?.name ?? '−'}・登録 {staffMap.get(row.staff_id ?? 0)?.name ?? '−'}
                  </div>
                  <div className={`font-bold text-gray-800 ${cancelled ? 'line-through' : ''}`}>{row.customer_name} 様</div>
                  <div className="break-words text-sm text-gray-700">{item?.product.brand} {item?.product.name ?? '（対象外になった商品）'} × {row.quantity}</div>
                  <div className="text-xs text-gray-500">{yen(row.unit_price)} × {row.quantity} ＝ <span className="font-bold text-gray-700">{yen((row.unit_price ?? 0) * row.quantity)}</span></div>
                  {delivered && <div className="mt-0.5 text-[11px] font-bold text-green-700">お渡し済み（{new Date(row.delivered_at!).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' })}）</div>}
                  {cancelled && <div className="mt-0.5 text-[11px] font-bold text-gray-500">キャンセル</div>}
                </div>
                <div className="flex shrink-0 flex-col gap-1.5">
                  {!delivered && !cancelled && (
                    <button onClick={() => startEdit(row)} className="rounded-lg bg-blue-50 px-2.5 py-1.5 text-xs font-medium text-blue-700">修正</button>
                  )}
                  {!delivered && (
                    <button onClick={() => void toggleCancelled(row)} disabled={busyId === row.id} className="rounded-lg bg-gray-100 px-2.5 py-1.5 text-xs text-gray-600">
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

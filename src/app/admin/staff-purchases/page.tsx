'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getCurrentProfile } from '@/lib/auth'
import { supabase } from '@/lib/supabase'
import { fetchAll } from '@/lib/fetchAll'
import { withTax, yen } from '@/lib/tax'
import { todayInTokyo } from '@/lib/presale'

type Store = { id: number; name: string }
type Staff = { id: number; store_id: number; name: string; sort_order: number }
type Product = { id: number; brand: string | null; name: string; cost_price: number | null; dealer: string | null }
type Kind = 'store_stock' | 'personal_order'
type Purchase = {
  id: string
  purchased_on: string
  staff_id: number
  store_id: number
  product_id: number | null
  item_name: string | null
  dealer: string | null
  quantity: number
  unit_price: number
  kind: Kind
  collected_on: string | null
  note: string | null
}
type Payout = { id: string; box: 'safe' | 'dealer'; dealer: string | null; paid_at: string; amount: number; note: string | null }
type Tab = 'entry' | 'summary' | 'cash'

// スタッフ購入は2026年10月から
const START_DATE = '2026-10-01'
const KIND_LABEL: Record<Kind, string> = { store_stock: '店舗在庫から', personal_order: '個人発注' }
const BOX_LABEL = { safe: '金庫（オーナー渡し用）', dealer: 'ディーラー支払い用' }

function normalize(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, '')
}

function monthRange(date: string) {
  const [y, m] = date.split('-').map(Number)
  const last = new Date(y, m, 0).getDate()
  const ym = `${y}-${String(m).padStart(2, '0')}`
  return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, '0')}` }
}

function nowLocalInput() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`
}

function parseYen(raw: string) {
  const trimmed = raw.replace(/[,，¥円\s]/g, '')
  if (trimmed === '') return null
  const value = Number(trimmed)
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : null
}

export default function StaffPurchasesPage() {
  const router = useRouter()
  const today = todayInTokyo()
  const [authorized, setAuthorized] = useState(false)
  const [tab, setTab] = useState<Tab>('entry')
  const [stores, setStores] = useState<Store[]>([])
  const [staff, setStaff] = useState<Staff[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [assignments, setAssignments] = useState<Set<string>>(new Set())
  const [purchases, setPurchases] = useState<Purchase[]>([])
  const [payouts, setPayouts] = useState<Payout[]>([])
  const [threshold, setThreshold] = useState(100000)
  const [thresholdDraft, setThresholdDraft] = useState('')
  const [minDate, setMinDate] = useState(START_DATE)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  // 登録フォーム
  const [date, setDate] = useState(today < START_DATE ? START_DATE : today)
  const [storeId, setStoreId] = useState<number | null>(null)
  const [staffId, setStaffId] = useState<number | null>(null)
  const [kind, setKind] = useState<Kind>('store_stock')
  const [search, setSearch] = useState('')
  const [productId, setProductId] = useState<number | null>(null)
  // 個人発注で商品一覧にない商品は、商品名を手で書く
  const [freeItem, setFreeItem] = useState(false)
  const [itemName, setItemName] = useState('')
  const [dealer, setDealer] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [unitPrice, setUnitPrice] = useState('')
  const [collected, setCollected] = useState(false)
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  // 一覧の絞り込み
  const initialRange = monthRange(today < START_DATE ? START_DATE : today)
  const [listFrom, setListFrom] = useState(initialRange.from)
  const [listTo, setListTo] = useState(initialRange.to)
  const [listStaff, setListStaff] = useState<number | 'all'>('all')
  const [listKind, setListKind] = useState<Kind | 'all'>('all')
  const [listDealer, setListDealer] = useState('all')
  const [onlyUnpaid, setOnlyUnpaid] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editQuantity, setEditQuantity] = useState('')
  const [editPrice, setEditPrice] = useState('')
  const [editNote, setEditNote] = useState('')
  const [editDealer, setEditDealer] = useState('')

  // 集計
  const [sumStaff, setSumStaff] = useState<number | null>(null)
  const [sumFrom, setSumFrom] = useState(initialRange.from)
  const [sumTo, setSumTo] = useState(initialRange.to)

  // 渡した記録
  const [payBox, setPayBox] = useState<'safe' | 'dealer'>('safe')
  const [payAt, setPayAt] = useState(nowLocalInput())
  const [payAmount, setPayAmount] = useState('')
  const [payNote, setPayNote] = useState('')
  const [payDealer, setPayDealer] = useState('')

  useEffect(() => {
    void (async () => {
      const profile = await getCurrentProfile()
      if (!profile) { router.replace('/'); return }
      if (profile.role !== 'hq') { router.replace(`/${profile.store_id}/input`); return }
      setAuthorized(true)
    })()
  }, [router])

  const load = useCallback(async () => {
    if (!authorized) return
    setLoading(true)
    const [storeResult, staffResult, productResult, assignmentResult, purchaseResult, payoutResult, settingResult, closedResult] = await Promise.all([
      supabase.from('stores').select('id, name').order('sort_order'),
      supabase.from('staff').select('id, store_id, name, sort_order').eq('is_active', true).order('sort_order').order('id'),
      fetchAll((from, to) => supabase.from('products').select('id, brand, name, cost_price, dealer').eq('is_active', true).order('id').range(from, to)),
      fetchAll((from, to) => supabase.from('store_products').select('store_id, product_id').order('store_id').order('product_id').range(from, to)),
      fetchAll((from, to) => supabase.from('staff_purchases')
        .select('id, purchased_on, staff_id, store_id, product_id, item_name, dealer, quantity, unit_price, kind, collected_on, note')
        .order('purchased_on', { ascending: false }).order('created_at', { ascending: false }).order('id').range(from, to)),
      supabase.from('cash_payouts').select('id, box, dealer, paid_at, amount, note').order('paid_at', { ascending: false }),
      supabase.from('app_settings').select('value').eq('key', 'safe_threshold').maybeSingle(),
      supabase.rpc('closed_through'),
    ])
    if (storeResult.error || staffResult.error || productResult.error || assignmentResult.error || purchaseResult.error || payoutResult.error) {
      setError('読み込めませんでした。ページを開き直してください。')
    }
    const storeRows = (storeResult.data ?? []) as Store[]
    setStores(storeRows)
    setStoreId((current) => current ?? storeRows[0]?.id ?? null)
    setStaff((staffResult.data ?? []) as Staff[])
    setProducts((productResult.data ?? []) as Product[])
    setAssignments(new Set(((assignmentResult.data ?? []) as { store_id: number; product_id: number }[]).map((row) => `${row.store_id}_${row.product_id}`)))
    setPurchases((purchaseResult.data ?? []) as Purchase[])
    setPayouts((payoutResult.data ?? []) as Payout[])
    if (settingResult.data?.value != null) setThreshold(Number(settingResult.data.value))
    if (closedResult.data) {
      const next = new Date(`${closedResult.data}T00:00:00Z`)
      next.setUTCDate(next.getUTCDate() + 1)
      const nextDate = next.toISOString().slice(0, 10)
      setMinDate(nextDate > START_DATE ? nextDate : START_DATE)
    }
    setLoading(false)
  }, [authorized])

  useEffect(() => { void load() }, [load])

  const storeMap = useMemo(() => new Map(stores.map((store) => [store.id, store])), [stores])
  const staffMap = useMemo(() => new Map(staff.map((person) => [person.id, person])), [staff])
  const productMap = useMemo(() => new Map(products.map((product) => [product.id, product])), [products])
  const productLabel = (id: number) => {
    const product = productMap.get(id)
    return product ? `${product.brand ? `${product.brand} ` : ''}${product.name}` : `商品#${id}`
  }
  const rowLabel = (row: { product_id: number | null; item_name: string | null }) => (
    row.product_id !== null ? productLabel(row.product_id) : `${row.item_name ?? ''}（一覧外）`
  )
  const staffName = (id: number) => staffMap.get(id)?.name ?? `（名簿にいない #${id}）`

  // 預かり金の残高：集金済みの合計 − 渡した合計
  const balances = useMemo(() => {
    const collectedOf = (target: Kind) => purchases
      .filter((row) => row.kind === target && row.collected_on)
      .reduce((sum, row) => sum + row.quantity * row.unit_price, 0)
    const paidOf = (box: 'safe' | 'dealer') => payouts.filter((row) => row.box === box).reduce((sum, row) => sum + row.amount, 0)
    const safeIn = collectedOf('store_stock')
    const dealerIn = collectedOf('personal_order')
    const safeOut = paidOf('safe')
    const dealerOut = paidOf('dealer')
    const unpaid = purchases.filter((row) => !row.collected_on).reduce((sum, row) => sum + row.quantity * row.unit_price, 0)
    return { safeIn, safeOut, safe: safeIn - safeOut, dealerIn, dealerOut, dealer: dealerIn - dealerOut, unpaid }
  }, [payouts, purchases])

  const candidates = useMemo(() => {
    const keyword = normalize(search)
    if (!keyword) return []
    return products
      .filter((product) => kind === 'personal_order' || (storeId !== null && assignments.has(`${storeId}_${product.id}`)))
      .filter((product) => normalize(`${product.brand ?? ''}${product.name}`).includes(keyword))
      .slice(0, 30)
  }, [assignments, kind, products, search, storeId])

  function chooseProduct(product: Product) {
    setProductId(product.id)
    setSearch('')
    setUnitPrice(product.cost_price === null ? '' : String(withTax(product.cost_price)))
    setDealer(product.dealer ?? '')
  }

  async function addPurchase() {
    setError('')
    setMessage('')
    const qty = Number(quantity)
    const price = parseYen(unitPrice)
    const useFreeItem = kind === 'personal_order' && freeItem
    if (!storeId || !staffId) { setError('店舗とスタッフを選んでください。'); return }
    if (kind === 'personal_order' && !dealer.trim()) { setError('個人発注はディーラーを選んでください。'); return }
    if (useFreeItem ? !itemName.trim() : !productId) { setError(useFreeItem ? '商品名を入力してください。' : '商品を選んでください。'); return }
    if (!Number.isInteger(qty) || qty <= 0) { setError('数は1以上の整数で入力してください。'); return }
    if (price === null) { setError('単価（税込）を入力してください。'); return }
    if (date < minDate) { setError(`${minDate.replaceAll('-', '/')} より前の日付では登録できません。`); return }
    setSaving(true)
    const { error: saveError } = await supabase.rpc('add_staff_purchase', {
      p_purchased_on: date, p_staff_id: staffId, p_store_id: storeId, p_product_id: useFreeItem ? null : productId,
      p_quantity: qty, p_unit_price: price, p_kind: kind, p_collected: collected, p_note: note || null,
      p_item_name: useFreeItem ? itemName.trim() : null,
      p_dealer: kind === 'personal_order' ? dealer.trim() : null,
    })
    setSaving(false)
    if (saveError) { setError(`登録できませんでした：${saveError.message}`); return }
    setMessage(`${staffName(staffId)}：${useFreeItem ? itemName.trim() : productLabel(productId!)} ×${qty}（${yen(qty * price)}）を登録しました。`)
    setProductId(null)
    setItemName('')
    setQuantity('1')
    setUnitPrice('')
    setNote('')
    setCollected(false)
    await load()
  }

  async function setCollectedFor(ids: string[], value: boolean) {
    if (ids.length === 0) return
    setError('')
    const { error: updateError } = await supabase.rpc('set_staff_purchase_collected', { p_ids: ids, p_collected: value })
    if (updateError) { setError(`集金の記録を変更できませんでした：${updateError.message}`); return }
    await load()
  }

  function startEdit(row: Purchase) {
    setEditingId(row.id)
    setEditQuantity(String(row.quantity))
    setEditPrice(String(row.unit_price))
    setEditNote(row.note ?? '')
    setEditDealer(row.dealer ?? '')
  }

  async function saveEdit(row: Purchase) {
    const qty = Number(editQuantity)
    const price = parseYen(editPrice)
    if (!Number.isInteger(qty) || qty <= 0 || price === null) { setError('数と単価を正しく入力してください。'); return }
    const { error: updateError } = await supabase.rpc('update_staff_purchase', {
      p_id: row.id, p_quantity: qty, p_unit_price: price, p_note: editNote || null, p_dealer: row.kind === 'personal_order' ? editDealer.trim() : null,
    })
    if (updateError) { setError(`修正できませんでした：${updateError.message}`); return }
    setEditingId(null)
    await load()
  }

  async function cancelPurchase(row: Purchase) {
    const stockNote = row.kind === 'store_stock' ? '\n店舗の在庫も元に戻ります。' : ''
    if (!confirm(`この記録を取り消します。\n${row.purchased_on} ${staffName(row.staff_id)}：${rowLabel(row)} ×${row.quantity}${stockNote}\nよろしいですか？`)) return
    const { error: cancelError } = await supabase.rpc('cancel_staff_purchase', { p_id: row.id })
    if (cancelError) { setError(`取り消せませんでした：${cancelError.message}`); return }
    setEditingId(null)
    await load()
  }

  async function addPayout() {
    setError('')
    setMessage('')
    const amount = parseYen(payAmount)
    if (!amount) { setError('渡した金額を入力してください。'); return }
    if (!payAt) { setError('日時を入力してください。'); return }
    if (payBox === 'dealer' && !payDealer.trim()) { setError('どのディーラーに渡したか選んでください。'); return }
    const { error: insertError } = await supabase.from('cash_payouts').insert({
      box: payBox, dealer: payBox === 'dealer' ? payDealer.trim() : null, paid_at: new Date(`${payAt}:00+09:00`).toISOString(), amount, note: payNote.trim() || null,
    })
    if (insertError) { setError(`登録できませんでした：${insertError.message}`); return }
    setMessage(`${BOX_LABEL[payBox]}から ${yen(amount)} を渡した記録を登録しました。`)
    setPayAmount('')
    setPayNote('')
    setPayAt(nowLocalInput())
    await load()
  }

  async function deletePayout(row: Payout) {
    if (!confirm(`この記録を取り消します。\n${new Date(row.paid_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} ${yen(row.amount)}\nよろしいですか？`)) return
    const { error: deleteError } = await supabase.from('cash_payouts').delete().eq('id', row.id)
    if (deleteError) { setError(`取り消せませんでした：${deleteError.message}`); return }
    await load()
  }

  async function saveThreshold() {
    const value = parseYen(thresholdDraft)
    if (!value) { setError('目安額を入力してください。'); return }
    const { error: saveError } = await supabase.from('app_settings').upsert({ key: 'safe_threshold', value, updated_at: new Date().toISOString() })
    if (saveError) { setError(`保存できませんでした：${saveError.message}`); return }
    setThreshold(value)
    setThresholdDraft('')
  }

  const listRows = useMemo(() => purchases.filter((row) => (
    row.purchased_on >= listFrom && row.purchased_on <= listTo
    && (listStaff === 'all' || row.staff_id === listStaff)
    && (listKind === 'all' || row.kind === listKind)
    && (listDealer === 'all' || row.dealer === listDealer)
    && (!onlyUnpaid || !row.collected_on)
  )), [listDealer, listFrom, listKind, listStaff, listTo, onlyUnpaid, purchases])

  // ディーラーの候補：商品一覧に登録されているディーラーと、これまで個人発注で使ったディーラー
  const dealerNames = useMemo(() => Array.from(new Set([
    ...products.map((product) => product.dealer?.trim()).filter((name): name is string => Boolean(name)),
    ...purchases.map((row) => row.dealer).filter((name): name is string => Boolean(name)),
    ...payouts.map((row) => row.dealer).filter((name): name is string => Boolean(name)),
  ])).sort((a, b) => a.localeCompare(b, 'ja')), [payouts, products, purchases])

  // ディーラーごと（個人発注だけ）：注文の合計・集金済み・渡した・手元にある分・未集金
  const dealerSummary = useMemo(() => {
    const names = Array.from(new Set([
      ...purchases.filter((row) => row.kind === 'personal_order' && row.dealer).map((row) => row.dealer!),
      ...payouts.filter((row) => row.box === 'dealer' && row.dealer).map((row) => row.dealer!),
    ])).sort((a, b) => a.localeCompare(b, 'ja'))
    return names.map((name) => {
      const rows = purchases.filter((row) => row.kind === 'personal_order' && row.dealer === name)
      const ordered = rows.reduce((sum, row) => sum + row.quantity * row.unit_price, 0)
      const collected = rows.filter((row) => row.collected_on).reduce((sum, row) => sum + row.quantity * row.unit_price, 0)
      const paid = payouts.filter((row) => row.box === 'dealer' && row.dealer === name).reduce((sum, row) => sum + row.amount, 0)
      return { name, ordered, collected, paid, onHand: collected - paid, unpaid: ordered - collected }
    })
  }, [payouts, purchases])
  const listTotal = listRows.reduce((sum, row) => sum + row.quantity * row.unit_price, 0)
  const listUnpaid = listRows.filter((row) => !row.collected_on).reduce((sum, row) => sum + row.quantity * row.unit_price, 0)

  const summary = useMemo(() => {
    if (sumStaff === null) return null
    const rows = purchases.filter((row) => row.staff_id === sumStaff && row.purchased_on >= sumFrom && row.purchased_on <= sumTo)
    const grouped = new Map<string, { product_id: number | null; item_name: string | null; kind: Kind; unit_price: number; quantity: number; amount: number; unpaid: number }>()
    rows.forEach((row) => {
      const key = `${row.product_id ?? `name:${row.item_name}`}_${row.kind}_${row.unit_price}`
      const item = grouped.get(key) ?? { product_id: row.product_id, item_name: row.item_name, kind: row.kind, unit_price: row.unit_price, quantity: 0, amount: 0, unpaid: 0 }
      item.quantity += row.quantity
      item.amount += row.quantity * row.unit_price
      if (!row.collected_on) item.unpaid += row.quantity * row.unit_price
      grouped.set(key, item)
    })
    const total = rows.reduce((sum, row) => sum + row.quantity * row.unit_price, 0)
    const unpaidRows = rows.filter((row) => !row.collected_on)
    const unpaid = unpaidRows.reduce((sum, row) => sum + row.quantity * row.unit_price, 0)
    return { items: Array.from(grouped.values()), total, unpaid, collected: total - unpaid, unpaidIds: unpaidRows.map((row) => row.id) }
  }, [purchases, sumFrom, sumStaff, sumTo])

  const staffOptions = (
    <>
      {stores.map((store) => {
        const members = staff.filter((person) => person.store_id === store.id)
        if (members.length === 0) return null
        return (
          <optgroup key={store.id} label={store.name}>
            {members.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
          </optgroup>
        )
      })}
    </>
  )

  if (!authorized) return <div className="flex min-h-[100dvh] items-center justify-center text-gray-400">権限を確認しています...</div>

  const selectedProduct = productId ? productMap.get(productId) : null
  const overThreshold = balances.safe >= threshold

  return (
    <main className="min-h-[100dvh] bg-gray-50 pb-16">
      <header className="sticky top-0 z-20 border-b bg-white px-4 py-3 shadow-sm">
        <div className="mx-auto flex max-w-5xl items-center justify-between">
          <div><h1 className="font-bold text-gray-800">スタッフ購入</h1><p className="text-xs text-gray-400">個人購入・個人発注と集金（金額はすべて税込）</p></div>
          <Link href="/admin" className="rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-600">管理へ戻る</Link>
        </div>
      </header>

      <div className="mx-auto max-w-5xl space-y-4 p-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className={`rounded-2xl border p-4 shadow-sm ${overThreshold ? 'border-red-300 bg-red-50' : 'border-gray-200 bg-white'}`}>
            <p className="text-xs text-gray-500">金庫（オーナー渡し用）の残高</p>
            <p className={`text-2xl font-bold ${overThreshold ? 'text-red-600' : 'text-gray-800'}`}>{yen(balances.safe)}</p>
            <p className="mt-1 text-[11px] text-gray-400">集金 {yen(balances.safeIn)} − 渡した {yen(balances.safeOut)}</p>
            {overThreshold && <p className="mt-1 text-xs font-bold text-red-600">目安 {yen(threshold)} を超えています。オーナーに渡してください</p>}
            <div className="mt-2 flex items-center gap-1 text-[11px] text-gray-500">
              目安 {yen(threshold)}
              <input value={thresholdDraft} onChange={(event) => setThresholdDraft(event.target.value)} placeholder="変更" inputMode="numeric"
                className="ml-1 w-20 rounded border border-gray-200 px-1 py-0.5 text-base" />
              {thresholdDraft && <button onClick={() => void saveThreshold()} className="rounded bg-gray-800 px-2 py-0.5 text-white">保存</button>}
            </div>
          </div>
          <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
            <p className="text-xs text-gray-500">ディーラー支払い用の残高</p>
            <p className="text-2xl font-bold text-gray-800">{yen(balances.dealer)}</p>
            <p className="mt-1 text-[11px] text-gray-400">集金 {yen(balances.dealerIn)} − 渡した {yen(balances.dealerOut)}</p>
          </div>
          <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
            <p className="text-xs text-gray-500">まだ集金していない金額（全員）</p>
            <p className={`text-2xl font-bold ${balances.unpaid > 0 ? 'text-amber-600' : 'text-gray-800'}`}>{yen(balances.unpaid)}</p>
          </div>
        </div>

        <div className="flex gap-1 rounded-xl bg-gray-100 p-1 text-sm font-medium">
          {([['entry', '登録と一覧'], ['summary', 'スタッフ別の集計'], ['cash', '渡した記録']] as [Tab, string][]).map(([key, label]) => (
            <button key={key} onClick={() => setTab(key)} className={`flex-1 rounded-lg px-3 py-2 ${tab === key ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500'}`}>{label}</button>
          ))}
        </div>

        {error && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
        {message && <p className="rounded-xl bg-green-50 px-3 py-2 text-sm text-green-700">{message}</p>}
        {loading && <p className="py-6 text-center text-sm text-gray-400">読み込み中...</p>}

        {!loading && tab === 'entry' && (
          <>
            <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
              <h2 className="font-bold text-gray-800">購入を登録</h2>
              <div className="mt-3 flex rounded-lg bg-gray-100 p-0.5 text-sm font-medium">
                {(['store_stock', 'personal_order'] as Kind[]).map((value) => (
                  <button key={value} onClick={() => { setKind(value); setProductId(null); setFreeItem(false) }}
                    className={`flex-1 rounded-md px-3 py-2 ${kind === value ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500'}`}>
                    {KIND_LABEL[value]}
                    <span className="block text-[10px] font-normal text-gray-400">{value === 'store_stock' ? '店舗の在庫が減る・集金は金庫へ' : '在庫は動かない・集金はディーラー支払い用へ'}</span>
                  </button>
                ))}
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                <label className="text-xs text-gray-500">日付
                  <input type="date" value={date} min={minDate} onChange={(event) => setDate(event.target.value)} className="mt-1 block w-full rounded-lg border border-gray-200 px-2 py-2 text-base" />
                </label>
                <label className="text-xs text-gray-500">店舗
                  <select value={storeId ?? ''} onChange={(event) => { setStoreId(Number(event.target.value)); setProductId(null) }} className="mt-1 block w-full rounded-lg border border-gray-200 px-2 py-2 text-base">
                    {stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}
                  </select>
                </label>
                <label className="text-xs text-gray-500">スタッフ
                  <select value={staffId ?? ''} onChange={(event) => setStaffId(event.target.value ? Number(event.target.value) : null)} className="mt-1 block w-full rounded-lg border border-gray-200 px-2 py-2 text-base">
                    <option value="">選んでください</option>
                    {staffOptions}
                  </select>
                </label>
              </div>

              <div className="mt-3">
                <p className="text-xs text-gray-500">商品{kind === 'store_stock' && '（この店舗の取扱商品から）'}</p>
                {kind === 'personal_order' && freeItem ? (
                  <div className="mt-1">
                    <input value={itemName} onChange={(event) => setItemName(event.target.value)} placeholder="商品名（ブランドも一緒に）"
                      className="block w-full rounded-lg border border-purple-300 bg-purple-50/40 px-3 py-2 text-base outline-none focus:border-purple-500" />
                    <button onClick={() => { setFreeItem(false); setItemName('') }} className="mt-1 text-xs text-blue-600 underline">一覧から選ぶ</button>
                  </div>
                ) : selectedProduct ? (
                  <div className="mt-1 flex items-center justify-between rounded-lg bg-blue-50 px-3 py-2 text-sm">
                    <span className="font-medium text-blue-800">{productLabel(selectedProduct.id)}</span>
                    <button onClick={() => setProductId(null)} className="text-xs text-blue-600 underline">選び直す</button>
                  </div>
                ) : (
                  <>
                    <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="商品名・ブランドで検索"
                      className="mt-1 block w-full rounded-lg border border-gray-200 px-3 py-2 text-base outline-none focus:border-blue-400" />
                    {candidates.length > 0 && (
                      <ul className="mt-1 max-h-60 divide-y overflow-y-auto rounded-lg border border-gray-200 bg-white text-sm">
                        {candidates.map((product) => (
                          <li key={product.id}>
                            <button onClick={() => chooseProduct(product)} className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-gray-50">
                              <span>{product.brand ? <span className="text-gray-400">{product.brand} </span> : null}{product.name}</span>
                              <span className="shrink-0 text-xs text-gray-400">{product.cost_price === null ? '仕入れ値なし' : `${yen(withTax(product.cost_price))}（税込）`}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    {normalize(search) && candidates.length === 0 && <p className="mt-1 text-xs text-gray-400">見つかりません</p>}
                    {kind === 'personal_order' && (
                      <button onClick={() => { setFreeItem(true); setItemName(search); setSearch(''); setUnitPrice('') }} className="mt-1 text-xs text-purple-700 underline">
                        一覧にない商品を入力する
                      </button>
                    )}
                  </>
                )}
              </div>

              {kind === 'personal_order' && (
                <label className="mt-3 block text-xs text-gray-500">ディーラー（一覧から選ぶか、入力）
                  <input list="dealer-names" value={dealer} onChange={(event) => setDealer(event.target.value)} placeholder="例：きくや"
                    className="mt-1 block w-full rounded-lg border border-gray-200 px-3 py-2 text-base sm:w-64" />
                </label>
              )}
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                <label className="text-xs text-gray-500">数
                  <input value={quantity} onChange={(event) => setQuantity(event.target.value)} inputMode="numeric" className="mt-1 block w-full rounded-lg border border-gray-200 px-2 py-2 text-right text-base" />
                </label>
                <label className="text-xs text-gray-500">単価（税込）
                  <input value={unitPrice} onChange={(event) => setUnitPrice(event.target.value)} inputMode="numeric" placeholder={selectedProduct && selectedProduct.cost_price === null ? '仕入れ値なし・入力' : ''}
                    className="mt-1 block w-full rounded-lg border border-gray-200 px-2 py-2 text-right text-base" />
                </label>
                <div className="text-xs text-gray-500">金額
                  <p className="mt-1 rounded-lg bg-gray-50 px-2 py-2 text-right text-base font-bold text-gray-800">
                    {parseYen(unitPrice) !== null && Number(quantity) > 0 ? yen(parseYen(unitPrice)! * Number(quantity)) : '−'}
                  </p>
                </div>
                <label className="flex items-end gap-2 pb-2 text-sm text-gray-700">
                  <input type="checkbox" checked={collected} onChange={(event) => setCollected(event.target.checked)} className="h-5 w-5" />
                  その場で集金した
                </label>
              </div>
              <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="メモ（任意）"
                className="mt-2 block w-full rounded-lg border border-gray-200 px-3 py-2 text-base" />
              <button onClick={() => void addPurchase()} disabled={saving}
                className="mt-3 w-full rounded-xl bg-blue-600 py-3 text-sm font-bold text-white disabled:bg-gray-300">
                {saving ? '登録しています...' : '登録する'}
              </button>
            </section>

            <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
              <h2 className="font-bold text-gray-800">一覧</h2>
              <div className="mt-2 flex flex-wrap items-end gap-2 text-xs text-gray-500">
                <label>いつから<input type="date" value={listFrom} onChange={(event) => setListFrom(event.target.value)} className="block rounded-lg border border-gray-200 px-2 py-1.5 text-base" /></label>
                <label>いつまで<input type="date" value={listTo} onChange={(event) => setListTo(event.target.value)} className="block rounded-lg border border-gray-200 px-2 py-1.5 text-base" /></label>
                <label>スタッフ
                  <select value={listStaff} onChange={(event) => setListStaff(event.target.value === 'all' ? 'all' : Number(event.target.value))} className="block rounded-lg border border-gray-200 px-2 py-1.5 text-base">
                    <option value="all">全員</option>
                    {staffOptions}
                  </select>
                </label>
                <label>種類
                  <select value={listKind} onChange={(event) => setListKind(event.target.value as Kind | 'all')} className="block rounded-lg border border-gray-200 px-2 py-1.5 text-base">
                    <option value="all">すべて</option>
                    <option value="store_stock">店舗在庫から</option>
                    <option value="personal_order">個人発注</option>
                  </select>
                </label>
                <label>ディーラー
                  <select value={listDealer} onChange={(event) => setListDealer(event.target.value)} className="block rounded-lg border border-gray-200 px-2 py-1.5 text-base">
                    <option value="all">すべて</option>
                    {dealerNames.map((name) => <option key={name} value={name}>{name}</option>)}
                  </select>
                </label>
                <label className="flex items-center gap-1 pb-2 text-sm text-gray-700">
                  <input type="checkbox" checked={onlyUnpaid} onChange={(event) => setOnlyUnpaid(event.target.checked)} className="h-4 w-4" />未集金のみ
                </label>
              </div>
              <p className="mt-2 text-sm text-gray-600">{listRows.length}件・合計 <b>{yen(listTotal)}</b>・未集金 <b className="text-amber-600">{yen(listUnpaid)}</b></p>

              <div className="mt-2 overflow-x-auto">
                <table className="w-full min-w-max border-collapse text-sm">
                  <thead>
                    <tr className="bg-gray-100 text-xs text-gray-500">
                      <th className="border border-gray-200 px-2 py-1.5 text-left">日付</th>
                      <th className="border border-gray-200 px-2 py-1.5 text-left">スタッフ</th>
                      <th className="border border-gray-200 px-2 py-1.5 text-left">種類</th>
                      <th className="border border-gray-200 px-2 py-1.5 text-left">商品</th>
                      <th className="border border-gray-200 px-2 py-1.5 text-right">数</th>
                      <th className="border border-gray-200 px-2 py-1.5 text-right">単価</th>
                      <th className="border border-gray-200 px-2 py-1.5 text-right">金額</th>
                      <th className="border border-gray-200 px-2 py-1.5 text-center">集金</th>
                      <th className="border border-gray-200 px-2 py-1.5"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {listRows.map((row) => {
                      const editing = editingId === row.id
                      return (
                        <tr key={row.id} className={row.collected_on ? '' : 'bg-amber-50/40'}>
                          <td className="border border-gray-200 px-2 py-1.5 text-xs">{row.purchased_on.slice(5).replace('-', '/')}<span className="ml-1 text-gray-400">{storeMap.get(row.store_id)?.name}</span></td>
                          <td className="border border-gray-200 px-2 py-1.5">{staffName(row.staff_id)}</td>
                          <td className="border border-gray-200 px-2 py-1.5 text-xs">
                            <span className={`rounded px-1.5 py-0.5 ${row.kind === 'store_stock' ? 'bg-green-50 text-green-700' : 'bg-purple-50 text-purple-700'}`}>{KIND_LABEL[row.kind]}</span>
                            {row.kind === 'personal_order' && (editing
                              ? <input list="dealer-names" value={editDealer} onChange={(event) => setEditDealer(event.target.value)} placeholder="ディーラー" className="mt-1 block w-28 rounded border border-gray-200 px-1 py-0.5 text-base" />
                              : <span className="mt-0.5 block text-[11px] text-purple-700">{row.dealer}</span>)}
                          </td>
                          <td className="border border-gray-200 px-2 py-1.5">
                            {rowLabel(row)}
                            {editing
                              ? <input value={editNote} onChange={(event) => setEditNote(event.target.value)} placeholder="メモ" className="mt-1 block w-full rounded border border-gray-200 px-1 py-0.5 text-base" />
                              : row.note && <span className="block text-[11px] text-gray-400">{row.note}</span>}
                          </td>
                          <td className="border border-gray-200 px-2 py-1.5 text-right">
                            {editing ? <input value={editQuantity} onChange={(event) => setEditQuantity(event.target.value)} inputMode="numeric" className="w-14 rounded border border-gray-200 px-1 py-0.5 text-right text-base" /> : row.quantity}
                          </td>
                          <td className="border border-gray-200 px-2 py-1.5 text-right">
                            {editing ? <input value={editPrice} onChange={(event) => setEditPrice(event.target.value)} inputMode="numeric" className="w-20 rounded border border-gray-200 px-1 py-0.5 text-right text-base" /> : yen(row.unit_price)}
                          </td>
                          <td className="border border-gray-200 px-2 py-1.5 text-right font-medium">{yen(row.quantity * row.unit_price)}</td>
                          <td className="border border-gray-200 px-2 py-1.5 text-center">
                            <label className="flex items-center justify-center gap-1 text-xs">
                              <input type="checkbox" checked={Boolean(row.collected_on)} onChange={(event) => void setCollectedFor([row.id], event.target.checked)} className="h-4 w-4" />
                              {row.collected_on ? <span className="text-gray-500">{row.collected_on.slice(5).replace('-', '/')}</span> : <span className="text-amber-600">未</span>}
                            </label>
                          </td>
                          <td className="border border-gray-200 px-2 py-1.5 text-xs">
                            {editing ? (
                              <div className="flex gap-1">
                                <button onClick={() => void saveEdit(row)} className="rounded bg-blue-600 px-2 py-1 text-white">保存</button>
                                <button onClick={() => void cancelPurchase(row)} className="rounded bg-red-50 px-2 py-1 text-red-600">取消</button>
                                <button onClick={() => setEditingId(null)} className="rounded bg-gray-100 px-2 py-1 text-gray-600">閉じる</button>
                              </div>
                            ) : (
                              <button onClick={() => startEdit(row)} className="rounded bg-gray-100 px-2 py-1 text-gray-600">修正</button>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                {listRows.length === 0 && <p className="py-6 text-center text-sm text-gray-400">この条件の記録はありません</p>}
              </div>
            </section>
          </>
        )}

        {!loading && tab === 'summary' && (
          <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
            <h2 className="font-bold text-gray-800">スタッフ別の集計</h2>
            <div className="mt-2 flex flex-wrap items-end gap-2 text-xs text-gray-500">
              <label>スタッフ
                <select value={sumStaff ?? ''} onChange={(event) => setSumStaff(event.target.value ? Number(event.target.value) : null)} className="block rounded-lg border border-gray-200 px-2 py-1.5 text-base">
                  <option value="">選んでください</option>
                  {staffOptions}
                </select>
              </label>
              <label>いつから<input type="date" value={sumFrom} onChange={(event) => setSumFrom(event.target.value)} className="block rounded-lg border border-gray-200 px-2 py-1.5 text-base" /></label>
              <label>いつまで<input type="date" value={sumTo} onChange={(event) => setSumTo(event.target.value)} className="block rounded-lg border border-gray-200 px-2 py-1.5 text-base" /></label>
            </div>

            {summary && (
              <div className="mt-3 space-y-3">
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-xl bg-gray-50 p-2"><p className="text-xs text-gray-500">合計</p><p className="text-lg font-bold">{yen(summary.total)}</p></div>
                  <div className="rounded-xl bg-gray-50 p-2"><p className="text-xs text-gray-500">集金済み</p><p className="text-lg font-bold">{yen(summary.collected)}</p></div>
                  <div className="rounded-xl bg-amber-50 p-2"><p className="text-xs text-amber-700">支払いが必要</p><p className="text-lg font-bold text-amber-700">{yen(summary.unpaid)}</p></div>
                </div>
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="bg-gray-100 text-xs text-gray-500">
                      <th className="border border-gray-200 px-2 py-1.5 text-left">商品</th>
                      <th className="border border-gray-200 px-2 py-1.5 text-left">種類</th>
                      <th className="border border-gray-200 px-2 py-1.5 text-right">単価</th>
                      <th className="border border-gray-200 px-2 py-1.5 text-right">数</th>
                      <th className="border border-gray-200 px-2 py-1.5 text-right">金額</th>
                      <th className="border border-gray-200 px-2 py-1.5 text-right">うち未集金</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.items.map((item) => (
                      <tr key={`${item.product_id ?? `name:${item.item_name}`}_${item.kind}_${item.unit_price}`}>
                        <td className="border border-gray-200 px-2 py-1.5">{rowLabel(item)}</td>
                        <td className="border border-gray-200 px-2 py-1.5 text-xs">{KIND_LABEL[item.kind]}</td>
                        <td className="border border-gray-200 px-2 py-1.5 text-right">{yen(item.unit_price)}</td>
                        <td className="border border-gray-200 px-2 py-1.5 text-right">{item.quantity}</td>
                        <td className="border border-gray-200 px-2 py-1.5 text-right font-medium">{yen(item.amount)}</td>
                        <td className={`border border-gray-200 px-2 py-1.5 text-right ${item.unpaid > 0 ? 'text-amber-600' : 'text-gray-300'}`}>{item.unpaid > 0 ? yen(item.unpaid) : '−'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {summary.items.length === 0 && <p className="py-4 text-center text-sm text-gray-400">この期間の購入はありません</p>}
                {summary.unpaidIds.length > 0 && (
                  <button onClick={() => {
                    if (confirm(`${staffName(sumStaff!)}さんの未集金 ${summary.unpaidIds.length}件（${yen(summary.unpaid)}）を、今日の日付で集金済みにします。よろしいですか？`)) {
                      void setCollectedFor(summary.unpaidIds, true)
                    }
                  }} className="w-full rounded-xl bg-amber-500 py-3 text-sm font-bold text-white">
                    {yen(summary.unpaid)} を集金した（{summary.unpaidIds.length}件を集金済みにする）
                  </button>
                )}
              </div>
            )}
          </section>
        )}

        {!loading && tab === 'cash' && (
          <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
            <h2 className="font-bold text-gray-800">渡した記録</h2>
            <p className="mt-1 text-xs text-gray-500">オーナーやディーラーにお金を渡したら登録します。残高から自動で引かれます。</p>
            <div className="mt-3 grid gap-2 sm:grid-cols-5">
              <label className="text-xs text-gray-500">どこから
                <select value={payBox} onChange={(event) => setPayBox(event.target.value as 'safe' | 'dealer')} className="mt-1 block w-full rounded-lg border border-gray-200 px-2 py-2 text-base">
                  <option value="safe">金庫 → オーナー</option>
                  <option value="dealer">ディーラー支払い用 → ディーラー</option>
                </select>
              </label>
              <label className="text-xs text-gray-500">支払い日時
                <input type="datetime-local" value={payAt} onChange={(event) => setPayAt(event.target.value)} className="mt-1 block w-full rounded-lg border border-gray-200 px-2 py-2 text-base" />
              </label>
              <label className="text-xs text-gray-500">金額
                <input value={payAmount} onChange={(event) => setPayAmount(event.target.value)} inputMode="numeric" className="mt-1 block w-full rounded-lg border border-gray-200 px-2 py-2 text-right text-base" />
              </label>
              {payBox === 'dealer' && (
                <label className="text-xs text-gray-500">ディーラー
                  <input list="dealer-names" value={payDealer} onChange={(event) => setPayDealer(event.target.value)} placeholder="例：きくや"
                    className="mt-1 block w-full rounded-lg border border-gray-200 px-2 py-2 text-base" />
                </label>
              )}
              <label className="text-xs text-gray-500">メモ
                <input value={payNote} onChange={(event) => setPayNote(event.target.value)} placeholder="任意" className="mt-1 block w-full rounded-lg border border-gray-200 px-2 py-2 text-base" />
              </label>
            </div>
            <button onClick={() => void addPayout()} className="mt-3 w-full rounded-xl bg-gray-800 py-3 text-sm font-bold text-white">渡した記録を登録</button>

            {(['safe', 'dealer'] as const).map((box) => {
              const rows = payouts.filter((row) => row.box === box)
              return (
                <div key={box} className="mt-5">
                  <h3 className="text-sm font-bold text-gray-700">{BOX_LABEL[box]}</h3>
                  <p className="text-xs text-gray-500">
                    集金 {yen(box === 'safe' ? balances.safeIn : balances.dealerIn)} − 渡した {yen(box === 'safe' ? balances.safeOut : balances.dealerOut)} ＝ 残高 <b className="text-gray-800">{yen(box === 'safe' ? balances.safe : balances.dealer)}</b>
                  </p>
                  {box === 'dealer' && (
                    <div className="mt-2 overflow-x-auto">
                      <p className="text-xs font-bold text-gray-600">ディーラーごと（個人発注）</p>
                      <table className="mt-1 w-full min-w-max border-collapse text-sm">
                        <thead>
                          <tr className="bg-purple-50 text-xs text-purple-800">
                            <th className="border border-gray-200 px-2 py-1.5 text-left">ディーラー</th>
                            <th className="border border-gray-200 px-2 py-1.5 text-right">注文の合計</th>
                            <th className="border border-gray-200 px-2 py-1.5 text-right">集金済み</th>
                            <th className="border border-gray-200 px-2 py-1.5 text-right">渡した</th>
                            <th className="border border-gray-200 px-2 py-1.5 text-right">手元にある分</th>
                            <th className="border border-gray-200 px-2 py-1.5 text-right">未集金</th>
                          </tr>
                        </thead>
                        <tbody>
                          {dealerSummary.map((row) => (
                            <tr key={row.name}>
                              <td className="border border-gray-200 px-2 py-1.5 font-medium">{row.name}</td>
                              <td className="border border-gray-200 px-2 py-1.5 text-right">{yen(row.ordered)}</td>
                              <td className="border border-gray-200 px-2 py-1.5 text-right">{yen(row.collected)}</td>
                              <td className="border border-gray-200 px-2 py-1.5 text-right">{yen(row.paid)}</td>
                              <td className={`border border-gray-200 px-2 py-1.5 text-right font-bold ${row.onHand < 0 ? 'text-red-600' : 'text-gray-900'}`}>{yen(row.onHand)}</td>
                              <td className={`border border-gray-200 px-2 py-1.5 text-right ${row.unpaid > 0 ? 'text-amber-600' : 'text-gray-300'}`}>{row.unpaid > 0 ? yen(row.unpaid) : '−'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {dealerSummary.length === 0 && <p className="py-2 text-center text-xs text-gray-400">まだありません</p>}
                    </div>
                  )}
                  <table className="mt-1 w-full border-collapse text-sm">
                    <thead>
                      <tr className="bg-gray-100 text-xs text-gray-500">
                        <th className="border border-gray-200 px-2 py-1.5 text-left">支払い日時</th>
                        {box === 'dealer' && <th className="border border-gray-200 px-2 py-1.5 text-left">ディーラー</th>}
                        <th className="border border-gray-200 px-2 py-1.5 text-right">金額</th>
                        <th className="border border-gray-200 px-2 py-1.5 text-left">メモ</th>
                        <th className="border border-gray-200 px-2 py-1.5"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr key={row.id}>
                          <td className="border border-gray-200 px-2 py-1.5">{new Date(row.paid_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
                          {box === 'dealer' && <td className="border border-gray-200 px-2 py-1.5">{row.dealer}</td>}
                          <td className="border border-gray-200 px-2 py-1.5 text-right font-medium">{yen(row.amount)}</td>
                          <td className="border border-gray-200 px-2 py-1.5 text-gray-600">{row.note}</td>
                          <td className="border border-gray-200 px-2 py-1.5 text-center"><button onClick={() => void deletePayout(row)} className="text-xs text-red-500">取消</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {rows.length === 0 && <p className="py-3 text-center text-xs text-gray-400">まだありません</p>}
                </div>
              )
            })}
          </section>
        )}
      </div>
      <datalist id="dealer-names">
        {dealerNames.map((name) => <option key={name} value={name} />)}
      </datalist>
    </main>
  )
}

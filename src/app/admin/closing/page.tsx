'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getCurrentProfile } from '@/lib/auth'
import { supabase } from '@/lib/supabase'
import { fetchAll } from '@/lib/fetchAll'
import { todayInTokyo } from '@/lib/presale'

type Store = { id: number; name: string }
type Closing = { year_month: string; month_end: string; cut_date: string; closed_at: string }
type Assignment = { store_id: number; product_id: number; opening_stock: number; products: { brand: string | null; name: string } }
type Movement = { store_id: number; product_id: number; quantity: number }

// 繰越（opening_stock）は2026年8月末の在庫なので、最初に締めるのは2026年9月
const FIRST_YEAR_MONTH = '2026-09'

function monthEndOf(yearMonth: string) {
  const [y, m] = yearMonth.split('-').map(Number)
  return `${yearMonth}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`
}

function nextYearMonth(yearMonth: string) {
  const [y, m] = yearMonth.split('-').map(Number)
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
}

function monthLabel(yearMonth: string) {
  const [y, m] = yearMonth.split('-').map(Number)
  return `${y}年${m}月`
}

export default function ClosingPage() {
  const router = useRouter()
  const [authorized, setAuthorized] = useState(false)
  const [stores, setStores] = useState<Store[]>([])
  const [closings, setClosings] = useState<Closing[]>([])
  const [assignments, setAssignments] = useState<Assignment[]>([])
  const [movements, setMovements] = useState<Movement[]>([])
  const [draftCount, setDraftCount] = useState(0)
  const [laterCount, setLaterCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  useEffect(() => {
    void (async () => {
      const profile = await getCurrentProfile()
      if (!profile) { router.replace('/'); return }
      if (profile.role !== 'hq') { router.replace(`/${profile.store_id}/input`); return }
      setAuthorized(true)
    })()
  }, [router])

  const target = useMemo(() => {
    const last = [...closings].sort((a, b) => b.year_month.localeCompare(a.year_month))[0]
    return last ? nextYearMonth(last.year_month) : FIRST_YEAR_MONTH
  }, [closings])
  const targetEnd = monthEndOf(target)
  const today = todayInTokyo()
  // 月締めはその月に入っていればいつでも押せる。押した日（月末を過ぎていれば月末）が締め日
  const canClose = today >= `${target}-01`
  const cut = today < targetEnd ? today : targetEnd
  const cutLabel = cut.slice(5).replace('-', '/')
  const nextFirstLabel = `${Number(nextYearMonth(target).slice(5))}/1`

  const load = useCallback(async () => {
    if (!authorized) return
    setLoading(true)
    setError('')
    const [storeResult, closingResult] = await Promise.all([
      supabase.from('stores').select('id, name').order('sort_order'),
      supabase.from('month_closings').select('year_month, month_end, cut_date, closed_at').order('year_month'),
    ])
    if (storeResult.error || closingResult.error) {
      setError('読み込めませんでした。ページを開き直してください。')
      setLoading(false)
      return
    }
    const closed = (closingResult.data ?? []) as Closing[]
    const last = closed[closed.length - 1]
    const month = last ? nextYearMonth(last.year_month) : FIRST_YEAR_MONTH
    const monthEnd = monthEndOf(month)
    const todayNow = todayInTokyo()
    // 締め日より後（〜月末）の記録は、締めると翌月1日に移るので、月末在庫の見込みには入れない
    const end = todayNow < monthEnd ? todayNow : monthEnd
    const [assignmentResult, movementResult, draftResult, laterResult] = await Promise.all([
      fetchAll((from, to) => supabase.from('store_products')
        .select('store_id, product_id, opening_stock, products!inner(brand, name)')
        .order('store_id').order('product_id').range(from, to)),
      fetchAll((from, to) => supabase.from('inventory_movements')
        .select('id, store_id, product_id, quantity')
        .lte('occurred_on', end)
        .order('id').range(from, to)),
      supabase.from('inventory_sessions').select('id, inventory_session_items!inner(quantity)')
        .eq('status', 'draft').lte('entry_date', end).gt('inventory_session_items.quantity', 0),
      supabase.from('inventory_movements').select('id', { count: 'exact', head: true }).gt('occurred_on', end).lte('occurred_on', monthEnd),
    ])
    if (assignmentResult.error || movementResult.error || draftResult.error || laterResult.error) {
      setError('在庫を読み込めませんでした。ページを開き直してください。')
    }
    setStores((storeResult.data ?? []) as Store[])
    setClosings(closed)
    setAssignments((assignmentResult.data ?? []) as unknown as Assignment[])
    setMovements((movementResult.data ?? []) as Movement[])
    setDraftCount((draftResult.data ?? []).length)
    setLaterCount(laterResult.count ?? 0)
    setLoading(false)
  }, [authorized])

  useEffect(() => { void load() }, [load])

  // 締めたときに保存される月末在庫（＝翌月の繰越）の見込み
  const stockRows = useMemo(() => {
    const net = new Map<string, number>()
    movements.forEach((row) => {
      const key = `${row.store_id}_${row.product_id}`
      net.set(key, (net.get(key) ?? 0) + row.quantity)
    })
    return assignments.map((row) => ({
      ...row,
      stock: row.opening_stock + (net.get(`${row.store_id}_${row.product_id}`) ?? 0),
    }))
  }, [assignments, movements])

  const storeSummary = useMemo(() => stores.map((store) => {
    const rows = stockRows.filter((row) => row.store_id === store.id)
    return {
      store,
      items: rows.length,
      total: rows.reduce((sum, row) => sum + row.stock, 0),
      negatives: rows.filter((row) => row.stock < 0),
    }
  }), [stockRows, stores])
  const negativeCount = storeSummary.reduce((sum, row) => sum + row.negatives.length, 0)

  async function handleClose() {
    if (!canClose || draftCount > 0) return
    const ok = confirm(
      `${monthLabel(target)}を締めます。\n\n`
      + `・今日（${cutLabel}）までの記録で締め、在庫が翌月の「繰越」として保存されます\n`
      + `・${cutLabel}までの記録は、誰も入力・修正・取り消しできなくなります\n`
      + (cut < targetEnd ? `・${cutLabel}より後の入力（店舗・本部とも）は、${nextFirstLabel}の記録になります\n` : '')
      + '・締めは元に戻せません。違いが見つかったら翌月の「誤差調整」で直します\n\n'
      + '店舗の入力がすべて終わっていることを確認しましたか？',
    )
    if (!ok) return
    setRunning(true)
    setError('')
    setMessage('')
    const { data, error: closeError } = await supabase.rpc('close_month', { p_year_month: target })
    setRunning(false)
    if (closeError) {
      setError(`締められませんでした：${closeError.message}`)
      return
    }
    setMessage(`${monthLabel(target)}を締めました（${data}件の月末在庫を保存）。`)
    await load()
  }

  if (!authorized) {
    return <div className="flex min-h-[100dvh] items-center justify-center text-gray-400">権限を確認しています...</div>
  }

  return (
    <div className="min-h-[100dvh] bg-gray-50 pb-16">
      <div className="sticky top-0 z-20 border-b bg-white shadow-sm">
        <div className="flex items-center gap-3 px-4 py-3">
          <Link href="/admin" className="text-xs text-blue-500">← 管理</Link>
          <h1 className="text-base font-bold text-gray-800">月締め</h1>
        </div>
      </div>

      <div className="mx-auto max-w-3xl space-y-4 px-4 py-4">
        {error && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
        {message && <p className="rounded-xl bg-green-50 px-3 py-2 text-sm font-medium text-green-700">{message}</p>}

        <section className="rounded-2xl bg-white p-4 shadow-sm">
          <h2 className="text-sm font-bold text-gray-800">締めた月</h2>
          {closings.length === 0 ? (
            <p className="mt-2 text-sm text-gray-400">まだありません</p>
          ) : (
            <ul className="mt-2 space-y-1 text-sm text-gray-700">
              {closings.map((row) => (
                <li key={row.year_month}>
                  {monthLabel(row.year_month)}
                  <span className="ml-2 text-xs text-gray-500">締め日 {row.cut_date.slice(5).replace('-', '/')}</span>
                  <span className="ml-2 text-xs text-gray-400">
                    {new Date(row.closed_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} に締め
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-2xl bg-white p-4 shadow-sm">
          <h2 className="text-base font-bold text-gray-800">次に締める月：{monthLabel(target)}</h2>
          <p className="mt-1 text-xs leading-relaxed text-gray-500">
            いつでも締められます。押した日が締め日になり、そこまでの在庫が翌月の「繰越」になります。締め日までの記録は店舗・本部とも入力・修正できません（元に戻せません）。締め日の翌日〜月末に入った記録は、自動で翌月1日の記録になります。
          </p>

          {loading ? (
            <p className="py-8 text-center text-sm text-gray-400">確認中...</p>
          ) : (
            <>
              <div className="mt-3 space-y-2 text-sm">
                <p className={draftCount > 0 ? 'font-bold text-red-600' : 'text-gray-600'}>
                  {draftCount > 0
                    ? `✕ まだ送信されていない店舗の使用報告が ${draftCount} 件あります。送信してもらってから締めてください。`
                    : '✓ 送信されていない店舗の使用報告はありません'}
                </p>
                <p className={negativeCount > 0 ? 'text-amber-700' : 'text-gray-600'}>
                  {negativeCount > 0
                    ? `△ 在庫がマイナスの商品が ${negativeCount} 件あります（締めることはできます。直すなら締める前に誤差調整を）`
                    : '✓ 在庫がマイナスの商品はありません'}
                </p>
                {laterCount > 0 && (
                  <p className="text-gray-600">・{cutLabel}より後（月末まで）の日付の記録が {laterCount} 件あります。締めると{nextFirstLabel}の記録に移ります</p>
                )}
              </div>

              <table className="mt-3 w-full border-collapse text-sm">
                <thead>
                  <tr className="bg-gray-100 text-xs text-gray-500">
                    <th className="border border-gray-200 px-2 py-1 text-left">店舗</th>
                    <th className="border border-gray-200 px-2 py-1 text-right">商品数</th>
                    <th className="border border-gray-200 px-2 py-1 text-right">月末在庫の合計</th>
                    <th className="border border-gray-200 px-2 py-1 text-right">マイナス</th>
                  </tr>
                </thead>
                <tbody>
                  {storeSummary.map((row) => (
                    <tr key={row.store.id}>
                      <td className="border border-gray-200 px-2 py-1">{row.store.name}</td>
                      <td className="border border-gray-200 px-2 py-1 text-right">{row.items}</td>
                      <td className="border border-gray-200 px-2 py-1 text-right font-bold">{row.total}</td>
                      <td className={`border border-gray-200 px-2 py-1 text-right ${row.negatives.length > 0 ? 'font-bold text-red-600' : 'text-gray-300'}`}>
                        {row.negatives.length || '−'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {negativeCount > 0 && (
                <div className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  <p className="font-bold">在庫がマイナスの商品</p>
                  <ul className="mt-1 space-y-0.5">
                    {storeSummary.flatMap((row) => row.negatives.map((item) => (
                      <li key={`${item.store_id}_${item.product_id}`}>
                        {row.store.name}：{item.products.brand ? `${item.products.brand} ` : ''}{item.products.name}（{item.stock}）
                      </li>
                    )))}
                  </ul>
                </div>
              )}

              <button
                type="button"
                onClick={() => void handleClose()}
                disabled={running || !canClose || draftCount > 0}
                className="mt-4 w-full rounded-xl bg-gray-800 py-3 text-sm font-bold text-white disabled:bg-gray-300"
              >
                {running ? '締めています...' : !canClose ? `${Number(target.slice(5))}/1 から締められます` : `${monthLabel(target)}を${cutLabel}で締める`}
              </button>
            </>
          )}
        </section>
      </div>
    </div>
  )
}

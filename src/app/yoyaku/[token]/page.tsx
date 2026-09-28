'use client'

import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import ReservationPanel from '@/components/presale/ReservationPanel'
import type { PresaleCampaign } from '@/lib/presale'

type Store = { id: number; name: string }

// 店舗スタッフ用の先行予約ページ。ログイン不要で、店舗ごとのURL＋暗証番号で入る（在庫の画面には入れない）
export default function PresalePortalPage() {
  const { token } = useParams<{ token: string }>()
  const storageKey = `presale-pin-${token}`
  const [pin, setPin] = useState('')
  const [input, setInput] = useState('')
  const [store, setStore] = useState<Store | null>(null)
  const [campaigns, setCampaigns] = useState<PresaleCampaign[]>([])
  const [campaignId, setCampaignId] = useState<number | null>(null)
  const [checking, setChecking] = useState(true)
  const [error, setError] = useState('')

  const enter = useCallback(async (candidate: string, remember: boolean) => {
    setChecking(true)
    setError('')
    const { data: login, error: loginError } = await supabase.rpc('presale_portal_login', { p_token: token, p_pin: candidate })
    if (loginError || !login?.ok) {
      setChecking(false)
      if (remember) setError(login?.message ?? '確認できませんでした。')
      try { sessionStorage.removeItem(storageKey) } catch {}
      return
    }
    const { data, error: dataError } = await supabase.rpc('presale_portal_data', { p_token: token, p_pin: candidate })
    setChecking(false)
    if (dataError) { setError(dataError.message); return }
    setStore(data.store as Store)
    const list = data.campaigns as PresaleCampaign[]
    setCampaigns(list)
    setCampaignId(list[0]?.id ?? null)
    setPin(candidate)
    // 同じタブで開き直しても入り直さなくて済むよう、このタブの間だけ覚えておく
    try { sessionStorage.setItem(storageKey, candidate) } catch {}
  }, [storageKey, token])

  useEffect(() => {
    let saved = ''
    try { saved = sessionStorage.getItem(storageKey) ?? '' } catch {}
    if (saved) void enter(saved, false)
    else setChecking(false)
  }, [enter, storageKey])

  function logout() {
    try { sessionStorage.removeItem(storageKey) } catch {}
    setPin('')
    setInput('')
    setStore(null)
  }

  if (!pin || !store) {
    return (
      <main className="flex min-h-[100dvh] items-center justify-center bg-gray-50 p-6">
        <div className="w-full max-w-xs rounded-2xl bg-white p-6 shadow-sm">
          <h1 className="mb-1 text-center font-bold text-gray-800">先行予約</h1>
          <p className="mb-4 text-center text-xs text-gray-400">暗証番号を入れてください</p>
          <input type="password" inputMode="numeric" autoComplete="off" value={input} onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && input) void enter(input, true) }}
            className="w-full rounded-xl border border-gray-200 px-3 py-3 text-center text-2xl tracking-[0.5em]" />
          {error && <p className="mt-3 text-center text-sm text-red-600">{error}</p>}
          <button onClick={() => void enter(input, true)} disabled={!input || checking}
            className="mt-4 w-full rounded-xl bg-pink-500 py-3 font-bold text-white disabled:opacity-40">{checking ? '確認中...' : '入る'}</button>
        </div>
      </main>
    )
  }

  const campaign = campaigns.find((item) => item.id === campaignId)

  return (
    <main className="min-h-[100dvh] bg-gray-50 pb-16">
      <header className="sticky top-0 z-20 border-b bg-white px-4 py-3 shadow-sm">
        <div className="mx-auto flex max-w-3xl items-center justify-between">
          <div>
            <h1 className="font-bold text-gray-800">先行予約・{store.name}</h1>
            {campaign && <p className="text-xs text-gray-400">{campaign.name}{campaign.delivery_month ? `（お渡し ${campaign.delivery_month}）` : ''}</p>}
          </div>
          <button onClick={logout} className="text-xs text-gray-400 underline">閉じる</button>
        </div>
      </header>
      <div className="mx-auto max-w-3xl space-y-3 p-4">
        {campaigns.length > 1 && (
          <div className="flex gap-1 overflow-x-auto">
            {campaigns.map((item) => (
              <button key={item.id} onClick={() => setCampaignId(item.id)}
                className={`shrink-0 rounded-full px-4 py-2 text-sm font-bold ${campaignId === item.id ? 'bg-pink-500 text-white' : 'border border-gray-200 bg-white text-gray-600'}`}>{item.name}</button>
            ))}
          </div>
        )}
        {campaign
          ? <ReservationPanel key={campaign.id} campaign={campaign} storeId={store.id} stores={[store]} access={{ token, pin }} />
          : <p className="rounded-2xl bg-white py-12 text-center text-sm text-gray-400">いま受付中の先行予約はありません</p>}
      </div>
    </main>
  )
}

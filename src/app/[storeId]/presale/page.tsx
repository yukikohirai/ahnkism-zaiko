'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { getCurrentProfile } from '@/lib/auth'
import { supabase } from '@/lib/supabase'
import ReservationPanel from '@/components/presale/ReservationPanel'
import type { PresaleCampaign } from '@/lib/presale'

type Store = { id: number; name: string }

export default function StorePresalePage() {
  const router = useRouter()
  const { storeId } = useParams<{ storeId: string }>()
  const [ready, setReady] = useState(false)
  const [stores, setStores] = useState<Store[]>([])
  const [campaigns, setCampaigns] = useState<PresaleCampaign[]>([])
  const [campaignId, setCampaignId] = useState<number | null>(null)

  useEffect(() => {
    void (async () => {
      const profile = await getCurrentProfile()
      if (!profile) { router.replace('/'); return }
      if (profile.role === 'store' && profile.store_id !== Number(storeId)) { router.replace(`/${profile.store_id}/presale`); return }
      const [storeResult, campaignResult] = await Promise.all([
        supabase.from('stores').select('id, name').order('sort_order'),
        supabase.from('presale_campaigns').select('*').eq('is_active', true).order('id', { ascending: false }),
      ])
      setStores((storeResult.data ?? []) as Store[])
      const list = (campaignResult.data ?? []) as PresaleCampaign[]
      setCampaigns(list)
      setCampaignId(list[0]?.id ?? null)
      setReady(true)
    })()
  }, [router, storeId])

  const store = stores.find((item) => item.id === Number(storeId))
  const campaign = campaigns.find((item) => item.id === campaignId)

  if (!ready) return <div className="flex min-h-[100dvh] items-center justify-center text-gray-400">読み込み中...</div>

  return (
    <main className="min-h-[100dvh] bg-gray-50 pb-16">
      <header className="sticky top-0 z-20 border-b bg-white px-4 py-3 shadow-sm">
        <div className="mx-auto flex max-w-3xl items-center justify-between">
          <div>
            <h1 className="font-bold text-gray-800">先行予約 {store ? `・${store.name}` : ''}</h1>
            {campaign && <p className="text-xs text-gray-400">{campaign.name}{campaign.delivery_month ? `（お渡し ${campaign.delivery_month}）` : ''}</p>}
          </div>
          <Link href={`/${storeId}/input`} className="rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-600">入力へ戻る</Link>
        </div>
      </header>
      <div className="mx-auto max-w-3xl space-y-3 p-4">
        {campaigns.length > 1 && (
          <div className="flex gap-1 overflow-x-auto">
            {campaigns.map((item) => (
              <button key={item.id} onClick={() => setCampaignId(item.id)}
                className={`shrink-0 rounded-full px-4 py-2 text-sm font-bold ${campaignId === item.id ? 'bg-blue-500 text-white' : 'border border-gray-200 bg-white text-gray-600'}`}>{item.name}</button>
            ))}
          </div>
        )}
        {campaign && store ? (
          <ReservationPanel key={campaign.id} campaign={campaign} storeId={store.id} stores={stores} />
        ) : (
          <p className="rounded-2xl bg-white py-12 text-center text-sm text-gray-400">いま受付中の先行予約はありません</p>
        )}
      </div>
    </main>
  )
}

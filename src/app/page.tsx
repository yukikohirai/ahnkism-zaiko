'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase, type Store } from '@/lib/supabase'

export default function Home() {
  const router = useRouter()
  const [stores, setStores] = useState<Store[]>([])

  useEffect(() => {
    supabase.from('stores').select('*').order('sort_order').then(({ data }) => {
      if (data) setStores(data)
    })
  }, [])

  return (
    <main className="flex flex-col items-center justify-center min-h-screen p-6">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-bold text-center mb-2 text-gray-800">アンキシム 在庫管理</h1>
        <p className="text-center text-gray-500 mb-8 text-sm">店舗を選んでください</p>
        <div className="flex flex-col gap-3">
          {stores.map((store) => (
            <button
              key={store.id}
              onClick={() => router.push(`/${store.id}/input`)}
              className="w-full bg-white border-2 border-gray-200 rounded-2xl py-5 text-xl font-semibold text-gray-700 hover:border-blue-400 hover:text-blue-600 active:bg-blue-50 transition-all shadow-sm"
            >
              {store.name}
            </button>
          ))}
        </div>
        <div className="mt-12 text-center">
          <a href="/admin" className="text-xs text-gray-400 underline">管理者ページ</a>
        </div>
      </div>
    </main>
  )
}

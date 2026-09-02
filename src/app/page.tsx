'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { emailForLoginId, getCurrentProfile, type UserProfile } from '@/lib/auth'
import { supabase, type Store } from '@/lib/supabase'

export default function Home() {
  const router = useRouter()
  const [stores, setStores] = useState<Store[]>([])
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [inputId, setInputId] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(false)

  useEffect(() => {
    void restoreSession()
  }, [])

  async function restoreSession() {
    const currentProfile = await getCurrentProfile()
    if (!currentProfile) {
      setLoading(false)
      return
    }
    await enterForProfile(currentProfile)
  }

  async function enterForProfile(currentProfile: UserProfile) {
    if (currentProfile.role === 'store' && currentProfile.store_id) {
      router.replace(`/${currentProfile.store_id}/input`)
      return
    }

    setProfile(currentProfile)
    const { data } = await supabase.from('stores').select('*').order('sort_order')
    if (data) setStores(data)
    setLoading(false)
  }

  async function handleLogin(event: React.FormEvent) {
    event.preventDefault()
    const email = emailForLoginId(inputId)
    if (!email) {
      setError(true)
      return
    }

    setSubmitting(true)
    setError(false)
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password })
    if (signInError) {
      setSubmitting(false)
      setError(true)
      return
    }

    const currentProfile = await getCurrentProfile()
    if (!currentProfile) {
      await supabase.auth.signOut()
      setSubmitting(false)
      setError(true)
      return
    }
    await enterForProfile(currentProfile)
    setSubmitting(false)
  }

  async function handleLogout() {
    await supabase.auth.signOut()
    setProfile(null)
    setStores([])
    setPassword('')
    setLoading(false)
  }

  if (loading) {
    return <main className="flex min-h-[100dvh] items-center justify-center text-gray-400">ログインを確認しています...</main>
  }

  if (!profile) {
    return (
      <main className="flex min-h-[100dvh] flex-col items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <h1 className="mb-2 text-center text-2xl font-bold text-gray-800">アンキシム 在庫管理</h1>
          <p className="mb-8 text-center text-sm text-gray-500">店舗または本部のアカウントでログイン</p>
          <form onSubmit={handleLogin} className="flex flex-col gap-3">
            <input
              type="text"
              value={inputId}
              onChange={(event) => { setInputId(event.target.value); setError(false) }}
              placeholder="ログインID"
              autoFocus
              autoCapitalize="none"
              autoComplete="username"
              className="w-full rounded-2xl border-2 border-gray-200 px-5 py-4 text-center text-lg outline-none focus:border-blue-400"
            />
            <input
              type="password"
              value={password}
              onChange={(event) => { setPassword(event.target.value); setError(false) }}
              placeholder="パスワード"
              autoComplete="current-password"
              className="w-full rounded-2xl border-2 border-gray-200 px-5 py-4 text-center text-lg outline-none focus:border-blue-400"
            />
            {error && <p className="text-center text-sm text-red-500">ログインIDまたはパスワードが違います</p>}
            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-2xl bg-blue-500 py-4 text-lg font-bold text-white disabled:opacity-50"
            >
              {submitting ? 'ログイン中...' : 'ログイン'}
            </button>
          </form>
        </div>
      </main>
    )
  }

  return (
    <main className="flex min-h-[100dvh] flex-col items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <h1 className="mb-2 text-center text-2xl font-bold text-gray-800">アンキシム 在庫管理</h1>
        <p className="mb-8 text-center text-sm text-gray-500">本部：確認する店舗を選択</p>
        <div className="flex flex-col gap-3">
          {stores.map((store) => (
            <button
              key={store.id}
              onClick={() => router.push(`/${store.id}/input`)}
              className="w-full rounded-2xl border-2 border-gray-200 bg-white py-5 text-xl font-semibold text-gray-700 shadow-sm transition-all hover:border-blue-400 hover:text-blue-600"
            >
              {store.name}
            </button>
          ))}
        </div>
        <div className="mt-10 flex items-center justify-center gap-5 text-xs">
          <Link href="/admin" className="text-blue-600 underline">本部管理ページ</Link>
          <button onClick={handleLogout} className="text-gray-400 underline">ログアウト</button>
        </div>
      </div>
    </main>
  )
}

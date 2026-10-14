'use client'

import { useState } from 'react'
import { supabase } from '@/lib/supabase'

type Store = { id: number; name: string }
type Staff = { id: number; store_id: number | null; name: string; sort_order: number; is_active: boolean }

function normalize(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, '')
}

// スタッフ名簿の追加・削除（先行予約の名簿と同じもの）
export default function RosterManager({ stores, staff, onChanged }: {
  stores: Store[]
  staff: Staff[]
  onChanged: () => Promise<void>
}) {
  const [newNames, setNewNames] = useState<Record<number, string>>({})
  const [showHidden, setShowHidden] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  async function add(storeId: number) {
    const name = (newNames[storeId] ?? '').trim()
    setError('')
    setMessage('')
    if (!name) { setError('名前を入力してください。'); return }
    if (staff.some((person) => person.is_active && person.store_id === storeId && normalize(person.name) === normalize(name))) {
      setError(`「${name}」はすでにこの店舗の名簿にいます。`)
      return
    }
    setBusy(true)
    const nextSort = Math.max(0, ...staff.filter((person) => person.store_id === storeId).map((person) => person.sort_order)) + 1
    const { error: insertError } = await supabase.from('staff').insert({ store_id: storeId, name, sort_order: nextSort, is_active: true })
    setBusy(false)
    if (insertError) { setError(`追加できませんでした：${insertError.message}`); return }
    setNewNames((previous) => ({ ...previous, [storeId]: '' }))
    setMessage(`「${name}」を追加しました。`)
    await onChanged()
  }

  async function remove(person: Staff) {
    setError('')
    setMessage('')
    if (!confirm(`「${person.name}」を名簿から削除します。\n購入や先行予約の記録がある場合は、記録を残すため「名簿から外す」（選択肢に出なくなる）になります。\nよろしいですか？`)) return
    setBusy(true)
    const { data, error: removeError } = await supabase.rpc('remove_staff', { p_id: person.id })
    setBusy(false)
    if (removeError) { setError(`削除できませんでした：${removeError.message}`); return }
    setMessage(data === 'hidden'
      ? `「${person.name}」は記録があるため、名簿から外しました（選択肢に出なくなりました。記録の名前はそのまま残ります）。`
      : `「${person.name}」を削除しました。`)
    await onChanged()
  }

  async function restore(person: Staff) {
    setError('')
    const { error: updateError } = await supabase.from('staff').update({ is_active: true }).eq('id', person.id)
    if (updateError) { setError(`戻せませんでした：${updateError.message}`); return }
    setMessage(`「${person.name}」を名簿に戻しました。`)
    await onChanged()
  }

  const hidden = staff.filter((person) => !person.is_active && person.store_id !== null)

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <h2 className="font-bold text-gray-800">スタッフ名簿</h2>
      <p className="mt-1 text-xs text-gray-500">ここで追加・削除した名簿は、先行予約のスタッフ名簿と同じものです。</p>
      {message && <p className="mt-2 rounded-xl bg-green-50 px-3 py-2 text-sm text-green-700">{message}</p>}
      {error && <p className="mt-2 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        {stores.map((store) => {
          const members = staff.filter((person) => person.is_active && person.store_id === store.id)
          return (
            <div key={store.id} className="rounded-xl border border-gray-200 p-3">
              <p className="text-sm font-bold text-gray-800">{store.name} <span className="text-xs font-normal text-gray-400">{members.length}人</span></p>
              <ul className="mt-2 divide-y divide-gray-100">
                {members.map((person) => (
                  <li key={person.id} className="flex items-center justify-between py-1.5 text-sm">
                    <span>{person.name}</span>
                    <button onClick={() => void remove(person)} disabled={busy} className="rounded bg-red-50 px-2 py-1 text-xs text-red-600 disabled:opacity-40">削除</button>
                  </li>
                ))}
              </ul>
              <div className="mt-2 flex gap-1.5">
                <input value={newNames[store.id] ?? ''} onChange={(event) => setNewNames((previous) => ({ ...previous, [store.id]: event.target.value }))}
                  onKeyDown={(event) => { if (event.key === 'Enter') void add(store.id) }}
                  placeholder="名前" className="min-w-0 flex-1 rounded-lg border border-gray-200 px-2 py-1.5 text-base" />
                <button onClick={() => void add(store.id)} disabled={busy} className="shrink-0 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-bold text-white disabled:bg-gray-300">追加</button>
              </div>
            </div>
          )
        })}
      </div>

      {hidden.length > 0 && (
        <div className="mt-3">
          <button onClick={() => setShowHidden((value) => !value)} className="text-xs text-gray-500 underline">
            {showHidden ? '名簿から外した人を閉じる' : `名簿から外した人（${hidden.length}人）を見る`}
          </button>
          {showHidden && (
            <ul className="mt-1 flex flex-wrap gap-1.5">
              {hidden.map((person) => (
                <li key={person.id} className="flex items-center gap-1 rounded-full bg-gray-100 px-3 py-1 text-xs text-gray-600">
                  {stores.find((store) => store.id === person.store_id)?.name}・{person.name}
                  <button onClick={() => void restore(person)} className="ml-1 text-blue-600 underline">戻す</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}

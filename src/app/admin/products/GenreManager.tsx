'use client'

import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { fetchAll } from '@/lib/fetchAll'

type Genre = { id: number; name: string; sort_order: number; count: number }

function normalize(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, '')
}

// 月次レポートの材料費ジャンル（カラー・ストレート…）の追加・名称変更・削除
export default function GenreManager() {
  const [genres, setGenres] = useState<Genre[]>([])
  const [newName, setNewName] = useState('')
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editName, setEditName] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    const [genreResult, productResult] = await Promise.all([
      supabase.from('product_genres').select('id, name, sort_order').order('sort_order').order('id'),
      fetchAll((start, end) => supabase.from('products').select('id, genre_id').eq('is_active', true).not('genre_id', 'is', null)
        .order('id').range(start, end)),
    ])
    if (genreResult.error) { setError('ジャンルを読み込めませんでした。'); return }
    const counts = new Map<number, number>()
    ;(productResult.data ?? []).forEach((row) => counts.set(row.genre_id, (counts.get(row.genre_id) ?? 0) + 1))
    setGenres((genreResult.data ?? []).map((genre) => ({ ...genre, count: counts.get(genre.id) ?? 0 })))
  }, [])

  useEffect(() => { void load() }, [load])

  function duplicateOf(name: string, exceptId?: number) {
    return genres.find((genre) => genre.id !== exceptId && normalize(genre.name) === normalize(name))
  }

  async function add() {
    const trimmed = newName.trim()
    if (!trimmed) return
    if (duplicateOf(trimmed)) { setError(`「${trimmed}」はすでにあります。`); return }
    setSaving(true)
    setError('')
    const nextSort = genres.reduce((max, genre) => Math.max(max, genre.sort_order), 0) + 1
    const { error: insertError } = await supabase.from('product_genres').insert({ name: trimmed, sort_order: nextSort })
    setSaving(false)
    if (insertError) { setError(insertError.message); return }
    setNewName('')
    setMessage(`ジャンル「${trimmed}」を追加しました。`)
    await load()
  }

  async function rename(genre: Genre) {
    const trimmed = editName.trim()
    if (!trimmed || trimmed === genre.name) { setEditingId(null); return }
    if (duplicateOf(trimmed, genre.id)) { setError(`「${trimmed}」はすでにあります。`); return }
    setSaving(true)
    setError('')
    const { error: updateError } = await supabase.from('product_genres').update({ name: trimmed }).eq('id', genre.id)
    setSaving(false)
    if (updateError) { setError(updateError.message); return }
    setEditingId(null)
    setMessage(`「${genre.name}」を「${trimmed}」に変更しました。`)
    await load()
  }

  async function remove(genre: Genre) {
    if (!confirm(`ジャンル「${genre.name}」を削除します。${genre.count > 0 ? `\n付いていた${genre.count}件の商品は「未分類」に戻ります。` : ''}\nよろしいですか？`)) return
    setSaving(true)
    setError('')
    const { error: deleteError } = await supabase.from('product_genres').delete().eq('id', genre.id)
    setSaving(false)
    if (deleteError) { setError(deleteError.message); return }
    setMessage(`「${genre.name}」を削除しました。`)
    await load()
  }

  async function move(index: number, delta: number) {
    const target = index + delta
    if (target < 0 || target >= genres.length) return
    const next = [...genres]
    ;[next[index], next[target]] = [next[target], next[index]]
    setSaving(true)
    const results = await Promise.all(next.map((genre, order) => supabase.from('product_genres').update({ sort_order: order + 1 }).eq('id', genre.id)))
    setSaving(false)
    const failed = results.find((result) => result.error)
    if (failed?.error) { setError(failed.error.message); return }
    await load()
  }

  return (
    <div>
      <p className="mb-2 text-xs text-gray-400">月次レポートの材料費をこのジャンルごとに集計します。商品ごとのジャンルは「価格をまとめて入力」の表で選びます。</p>
      {message && <p className="mb-2 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">{message}</p>}
      {error && <p className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
      <div className="mb-3 flex gap-2">
        <input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="新しいジャンル名"
          onKeyDown={(event) => { if (event.key === 'Enter') void add() }}
          className="min-w-0 flex-1 rounded-lg border border-gray-200 px-3 py-2 text-base" />
        <button onClick={() => void add()} disabled={saving || !newName.trim()} className="shrink-0 rounded-lg bg-slate-700 px-4 py-2 text-sm font-bold text-white disabled:opacity-40">追加</button>
      </div>
      <div className="divide-y divide-gray-100 rounded-xl border border-gray-100">
        {genres.map((genre, index) => (
          <div key={genre.id} className="px-3 py-2.5">
            {editingId === genre.id ? (
              <div className="flex gap-2">
                <input value={editName} onChange={(event) => setEditName(event.target.value)} autoFocus
                  onKeyDown={(event) => { if (event.key === 'Enter') void rename(genre) }}
                  className="min-w-0 flex-1 rounded-lg border border-gray-200 px-3 py-2 text-base" />
                <button onClick={() => setEditingId(null)} className="rounded-lg border border-gray-200 px-3 py-2 text-xs text-gray-600">やめる</button>
                <button onClick={() => void rename(genre)} disabled={saving} className="rounded-lg bg-blue-500 px-3 py-2 text-xs font-bold text-white disabled:opacity-40">変更</button>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="font-medium text-gray-800">{genre.name}</div>
                  <div className="text-[11px] text-gray-400">取扱中 {genre.count}件</div>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <button onClick={() => void move(index, -1)} disabled={saving || index === 0} className="rounded bg-gray-100 px-2 py-1.5 text-xs font-bold text-gray-600 disabled:opacity-30">↑</button>
                  <button onClick={() => void move(index, 1)} disabled={saving || index === genres.length - 1} className="rounded bg-gray-100 px-2 py-1.5 text-xs font-bold text-gray-600 disabled:opacity-30">↓</button>
                  <button onClick={() => { setEditingId(genre.id); setEditName(genre.name); setError(''); setMessage('') }} className="rounded-lg bg-blue-50 px-2.5 py-1.5 text-xs font-medium text-blue-700">名称変更</button>
                  <button onClick={() => void remove(genre)} disabled={saving} className="rounded-lg bg-red-50 px-2.5 py-1.5 text-xs font-medium text-red-600">削除</button>
                </div>
              </div>
            )}
          </div>
        ))}
        {genres.length === 0 && <p className="py-6 text-center text-sm text-gray-400">ジャンルがありません</p>}
      </div>
    </div>
  )
}

'use client'

import { useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'

type Field = 'dealer' | 'manufacturer' | 'brand'
type Tab = Field | 'category'
type Category = { id: number; name: string }
type MasterProduct = { id: number; category_id: number; dealer: string | null; manufacturer: string | null; brand: string | null; is_active: boolean }

const TAB_LABELS: Record<Tab, string> = { dealer: '発注先', manufacturer: 'メーカー', brand: 'ブランド', category: 'カテゴリ' }

function normalize(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, '')
}

export default function MasterManager({ products, categories, onChanged }: {
  products: MasterProduct[]
  categories: Category[]
  onChanged: () => Promise<void>
}) {
  const [tab, setTab] = useState<Tab>('dealer')
  const [editing, setEditing] = useState<{ key: string; mode: 'rename' | 'delete' } | null>(null)
  const [newName, setNewName] = useState('')
  const [replaceWith, setReplaceWith] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  // 停止中の商品も含めて数える（名前を変えると停止中の商品にも反映される）
  const values = useMemo(() => {
    if (tab === 'category') {
      return categories.map((category) => {
        const used = products.filter((product) => product.category_id === category.id)
        return { key: String(category.id), label: category.name, total: used.length, active: used.filter((product) => product.is_active).length }
      })
    }
    const counts = new Map<string, { total: number; active: number }>()
    products.forEach((product) => {
      const value = product[tab]
      if (!value) return
      const current = counts.get(value) ?? { total: 0, active: 0 }
      current.total += 1
      if (product.is_active) current.active += 1
      counts.set(value, current)
    })
    return Array.from(counts.entries())
      .map(([value, count]) => ({ key: value, label: value, ...count }))
      .sort((a, b) => a.label.localeCompare(b.label, 'ja'))
  }, [categories, products, tab])

  function open(key: string, mode: 'rename' | 'delete', label: string) {
    setEditing({ key, mode })
    setNewName(mode === 'rename' ? label : '')
    setReplaceWith('')
    setError('')
    setMessage('')
  }

  async function finish(text: string) {
    setEditing(null)
    setMessage(text)
    await onChanged()
  }

  async function rename(item: { key: string; label: string; total: number }) {
    const trimmed = newName.trim()
    if (!trimmed) { setError('新しい名前を入力してください。'); return }
    if (trimmed === item.label) { setEditing(null); return }
    setError('')
    if (tab === 'category') {
      const duplicate = categories.find((category) => String(category.id) !== item.key && normalize(category.name) === normalize(trimmed))
      if (duplicate) { setError(`「${duplicate.name}」というカテゴリがすでにあります。まとめたい場合は「削除」で移動先に選んでください。`); return }
      setSaving(true)
      const { error: updateError } = await supabase.from('categories').update({ name: trimmed }).eq('id', Number(item.key))
      setSaving(false)
      if (updateError) { setError(updateError.message); return }
      await finish(`カテゴリ名を「${trimmed}」に変更しました。`)
      return
    }
    const existing = values.find((value) => value.key !== item.key && normalize(value.label) === normalize(trimmed))
    if (existing && !confirm(`「${existing.label}」はすでにあります。${item.total}件の商品を「${existing.label}」にまとめます。よろしいですか？`)) return
    setSaving(true)
    const target = existing?.label ?? trimmed
    const { error: updateError } = await supabase.from('products').update({ [tab]: target }).eq(tab, item.key)
    setSaving(false)
    if (updateError) { setError(updateError.message); return }
    await finish(existing ? `${item.total}件の商品を「${target}」にまとめました。` : `「${item.label}」を「${target}」に変更しました（${item.total}件）。`)
  }

  async function remove(item: { key: string; label: string; total: number }) {
    setError('')
    if (tab === 'category') {
      const moveTo = replaceWith ? Number(replaceWith) : null
      if (item.total > 0 && !moveTo) { setError('商品の移動先カテゴリを選んでください。'); return }
      const moveName = categories.find((category) => category.id === moveTo)?.name
      if (!confirm(item.total > 0
        ? `カテゴリ「${item.label}」を削除し、${item.total}件の商品を「${moveName}」へ移します。よろしいですか？`
        : `カテゴリ「${item.label}」を削除します。よろしいですか？`)) return
      setSaving(true)
      const { error: deleteError } = await supabase.rpc('delete_category', { p_category_id: Number(item.key), p_move_to: moveTo })
      setSaving(false)
      if (deleteError) { setError(deleteError.message); return }
      await finish(`カテゴリ「${item.label}」を削除しました。`)
      return
    }
    if (!replaceWith) { setError('置き換え先を選んでください。'); return }
    const target = replaceWith === '__blank__' ? null : replaceWith
    if (!confirm(target
      ? `「${item.label}」を削除し、${item.total}件の商品を「${target}」に置き換えます。よろしいですか？`
      : `「${item.label}」を削除し、${item.total}件の商品の${TAB_LABELS[tab]}を空欄にします。よろしいですか？`)) return
    setSaving(true)
    const { error: updateError } = await supabase.from('products').update({ [tab]: target }).eq(tab, item.key)
    setSaving(false)
    if (updateError) { setError(updateError.message); return }
    await finish(`「${item.label}」を削除しました（${item.total}件）。`)
  }

  return (
    <section className="mb-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="font-bold text-gray-800">発注先・メーカー・ブランド・カテゴリの整理</h2>
      <p className="mb-3 text-xs text-gray-400">名前を変えると、その名前を使っている商品（停止中も含む）がまとめて変わります</p>
      <div className="mb-3 flex gap-1 overflow-x-auto">
        {(Object.keys(TAB_LABELS) as Tab[]).map((key) => (
          <button key={key} onClick={() => { setTab(key); setEditing(null); setError(''); setMessage('') }}
            className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium ${tab === key ? 'bg-slate-700 text-white' : 'bg-gray-100 text-gray-600'}`}>
            {TAB_LABELS[key]}
          </button>
        ))}
      </div>
      {message && <p className="mb-2 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">{message}</p>}
      {error && <p className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
      <div className="max-h-[60vh] divide-y divide-gray-100 overflow-auto rounded-xl border border-gray-100">
        {values.map((item) => (
          <div key={item.key} className="px-3 py-2.5">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="break-words font-medium text-gray-800">{item.label}</div>
                <div className="text-[11px] text-gray-400">取扱中 {item.active}件{item.total !== item.active ? `・停止中 ${item.total - item.active}件` : ''}</div>
              </div>
              {editing?.key !== item.key && (
                <div className="flex shrink-0 gap-1.5">
                  <button onClick={() => open(item.key, 'rename', item.label)} className="rounded-lg bg-blue-50 px-2.5 py-1.5 text-xs font-medium text-blue-700">名称変更</button>
                  <button onClick={() => open(item.key, 'delete', item.label)} className="rounded-lg bg-red-50 px-2.5 py-1.5 text-xs font-medium text-red-600">削除</button>
                </div>
              )}
            </div>
            {editing?.key === item.key && editing.mode === 'rename' && (
              <div className="mt-2 space-y-2 rounded-xl bg-blue-50/50 p-3">
                <input value={newName} onChange={(event) => setNewName(event.target.value)} className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-base" autoFocus />
                <div className="flex gap-2">
                  <button onClick={() => setEditing(null)} className="flex-1 rounded-lg border border-gray-200 bg-white py-2 text-sm text-gray-600">やめる</button>
                  <button onClick={() => void rename(item)} disabled={saving} className="flex-1 rounded-lg bg-blue-500 py-2 text-sm font-bold text-white disabled:opacity-50">{saving ? '変更中...' : '変更する'}</button>
                </div>
              </div>
            )}
            {editing?.key === item.key && editing.mode === 'delete' && (
              <div className="mt-2 space-y-2 rounded-xl bg-red-50/50 p-3">
                {tab === 'category' ? (
                  item.total > 0 ? (
                    <label className="block text-xs text-gray-600">{item.total}件の商品の移動先
                      <select value={replaceWith} onChange={(event) => setReplaceWith(event.target.value)} className="mt-1 block w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-base">
                        <option value="">選んでください</option>
                        {categories.filter((category) => String(category.id) !== item.key).map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
                      </select>
                    </label>
                  ) : <p className="text-xs text-gray-600">このカテゴリに商品はありません。</p>
                ) : (
                  <label className="block text-xs text-gray-600">使っている{item.total}件の商品をどうしますか？
                    <select value={replaceWith} onChange={(event) => setReplaceWith(event.target.value)} className="mt-1 block w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-base">
                      <option value="">選んでください</option>
                      <option value="__blank__">空欄にする（{TAB_LABELS[tab]}未設定）</option>
                      {values.filter((value) => value.key !== item.key).map((value) => <option key={value.key} value={value.key}>「{value.label}」に置き換える</option>)}
                    </select>
                  </label>
                )}
                <div className="flex gap-2">
                  <button onClick={() => setEditing(null)} className="flex-1 rounded-lg border border-gray-200 bg-white py-2 text-sm text-gray-600">やめる</button>
                  <button onClick={() => void remove(item)} disabled={saving} className="flex-1 rounded-lg bg-red-500 py-2 text-sm font-bold text-white disabled:opacity-50">{saving ? '削除中...' : '削除する'}</button>
                </div>
              </div>
            )}
          </div>
        ))}
        {values.length === 0 && <p className="py-8 text-center text-sm text-gray-400">登録がありません</p>}
      </div>
    </section>
  )
}

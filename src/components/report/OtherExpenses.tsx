'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { withTax, withoutTax, yen } from '@/lib/tax'

type Store = { id: number; name: string }
type Category = { id: number; name: string; sort_order: number }
type Expense = { id: string; store_id: number; spent_on: string; category_id: number; amount: number; note: string | null }
type Sales = { store_id: number; treatment_sales: number | null; retail_sales: number | null }

function rate(numerator: number, denominator: number | null) {
  if (!denominator) return '−'
  return `${((numerator / denominator) * 100).toFixed(1)}%`
}

// 月次レポート：材料費以外の経費（修繕費など）。店舗ごとに1件ずつ記録し、費目×店舗で集計する。
// 経費合計 ＝ 材料費 ＋ その他の経費。割合は売上合計（施術＋店販）に対して
export default function OtherExpenses({ stores, from, to, taxIncluded, sales, materialByStore }: {
  stores: Store[]
  from: string
  to: string
  taxIncluded: boolean
  sales: Sales[]
  materialByStore: Map<number, number>
}) {
  const [categories, setCategories] = useState<Category[]>([])
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [date, setDate] = useState(from)
  const [storeId, setStoreId] = useState<number | null>(stores[0]?.id ?? null)
  const [categoryId, setCategoryId] = useState<number | null>(null)
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [newCategory, setNewCategory] = useState('')
  const [showCategories, setShowCategories] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editAmount, setEditAmount] = useState('')
  const [editNote, setEditNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const money = (value: number) => yen(taxIncluded ? withTax(value) : value)
  const toStored = (raw: string) => {
    const value = Number(raw.normalize('NFKC').replace(/[,，¥円\s]/g, ''))
    if (!raw.trim() || !Number.isFinite(value) || value < 0) return null
    return taxIncluded ? withoutTax(value) : Math.round(value)
  }

  const load = useCallback(async () => {
    const [categoryResult, expenseResult] = await Promise.all([
      supabase.from('expense_categories').select('id, name, sort_order').order('sort_order').order('id'),
      supabase.from('monthly_expenses').select('id, store_id, spent_on, category_id, amount, note').gte('spent_on', from).lte('spent_on', to).order('spent_on').order('created_at'),
    ])
    if (categoryResult.error || expenseResult.error) { setError('経費を読み込めませんでした。'); return }
    const list = (categoryResult.data ?? []) as Category[]
    setCategories(list)
    setCategoryId((current) => current ?? list[0]?.id ?? null)
    setExpenses((expenseResult.data ?? []) as Expense[])
  }, [from, to])

  useEffect(() => { void load() }, [load])
  useEffect(() => { setDate(from) }, [from])

  const categoryName = useMemo(() => new Map(categories.map((category) => [category.id, category.name])), [categories])
  const storeName = useMemo(() => new Map(stores.map((store) => [store.id, store.name])), [stores])

  async function addExpense() {
    setError('')
    setMessage('')
    const stored = toStored(amount)
    if (!storeId || !categoryId) { setError('店舗と費目を選んでください。'); return }
    if (stored === null) { setError('金額を入力してください。'); return }
    if (date < from || date > to) { setError('この月の日付を入れてください。'); return }
    setSaving(true)
    const { error: insertError } = await supabase.from('monthly_expenses').insert({ store_id: storeId, spent_on: date, category_id: categoryId, amount: stored, note: note.trim() || null })
    setSaving(false)
    if (insertError) { setError(`登録できませんでした：${insertError.message}`); return }
    setMessage(`${storeName.get(storeId)}：${categoryName.get(categoryId)} ${money(stored)} を登録しました。`)
    setAmount('')
    setNote('')
    await load()
  }

  async function saveEdit(expense: Expense) {
    const stored = toStored(editAmount)
    if (stored === null) { setError('金額を入力してください。'); return }
    const { error: updateError } = await supabase.from('monthly_expenses').update({ amount: stored, note: editNote.trim() || null }).eq('id', expense.id)
    if (updateError) { setError(`保存できませんでした：${updateError.message}`); return }
    setEditingId(null)
    await load()
  }

  async function removeExpense(expense: Expense) {
    if (!confirm(`${expense.spent_on.replaceAll('-', '/')} ${storeName.get(expense.store_id)}：${categoryName.get(expense.category_id)} ${money(expense.amount)} を削除します。よろしいですか？`)) return
    const { error: deleteError } = await supabase.from('monthly_expenses').delete().eq('id', expense.id)
    if (deleteError) { setError(`削除できませんでした：${deleteError.message}`); return }
    await load()
  }

  async function addCategory() {
    const name = newCategory.trim()
    if (!name) return
    setError('')
    const nextSort = Math.max(0, ...categories.map((category) => category.sort_order)) + 1
    const { data, error: insertError } = await supabase.from('expense_categories').insert({ name, sort_order: nextSort }).select('id').single()
    if (insertError) { setError(insertError.message.includes('duplicate') ? `「${name}」はすでにあります。` : `追加できませんでした：${insertError.message}`); return }
    setNewCategory('')
    setCategoryId(data.id as number)
    await load()
  }

  async function renameCategory(category: Category) {
    const name = prompt('新しい費目の名前', category.name)?.trim()
    if (!name || name === category.name) return
    const { error: updateError } = await supabase.from('expense_categories').update({ name }).eq('id', category.id)
    if (updateError) { setError(`変更できませんでした：${updateError.message}`); return }
    await load()
  }

  async function removeCategory(category: Category) {
    const { count } = await supabase.from('monthly_expenses').select('id', { count: 'exact', head: true }).eq('category_id', category.id)
    if ((count ?? 0) > 0) { setError(`「${category.name}」は${count}件の記録で使われているので削除できません。名前の変更はできます。`); return }
    if (!confirm(`費目「${category.name}」を削除します。よろしいですか？`)) return
    const { error: deleteError } = await supabase.from('expense_categories').delete().eq('id', category.id)
    if (deleteError) { setError(`削除できませんでした：${deleteError.message}`); return }
    if (categoryId === category.id) setCategoryId(null)
    await load()
  }

  // 費目×店舗の合計
  const usedCategories = categories.filter((category) => expenses.some((expense) => expense.category_id === category.id))
  const sumOf = (filter: (expense: Expense) => boolean) => expenses.filter(filter).reduce((sum, expense) => sum + expense.amount, 0)
  const salesOf = (id: number) => {
    const row = sales.find((item) => item.store_id === id)
    if (!row || (row.treatment_sales === null && row.retail_sales === null)) return null
    return (row.treatment_sales ?? 0) + (row.retail_sales ?? 0)
  }
  const totalSales = stores.reduce<number | null>((sum, store) => {
    const value = salesOf(store.id)
    return value === null ? sum : (sum ?? 0) + value
  }, null)
  const totalMaterial = stores.reduce((sum, store) => sum + (materialByStore.get(store.id) ?? 0), 0)
  const totalOther = sumOf(() => true)

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <h2 className="font-bold text-gray-800">その他の経費（修繕費など）</h2>
      <p className="text-xs text-gray-400">材料費とは別に、店舗ごとに1件ずつ記録します。金額は{taxIncluded ? '税込' : '税抜'}で入力・表示しています（上の切り替えに合わせます）。</p>
      {message && <p className="mt-2 rounded-xl bg-green-50 px-3 py-2 text-sm text-green-700">{message}</p>}
      {error && <p className="mt-2 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

      <div className="mt-3 grid gap-2 sm:grid-cols-5">
        <label className="text-xs text-gray-500">日付
          <input type="date" value={date} min={from} max={to} onChange={(event) => setDate(event.target.value)} className="mt-1 block w-full rounded-lg border border-gray-200 px-2 py-2 text-base" />
        </label>
        <label className="text-xs text-gray-500">店舗
          <select value={storeId ?? ''} onChange={(event) => setStoreId(Number(event.target.value))} className="mt-1 block w-full rounded-lg border border-gray-200 px-2 py-2 text-base">
            {stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}
          </select>
        </label>
        <label className="text-xs text-gray-500">費目
          <select value={categoryId ?? ''} onChange={(event) => setCategoryId(Number(event.target.value))} className="mt-1 block w-full rounded-lg border border-gray-200 px-2 py-2 text-base">
            {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
          </select>
        </label>
        <label className="text-xs text-gray-500">金額（{taxIncluded ? '税込' : '税抜'}）
          <input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="numeric" className="mt-1 block w-full rounded-lg border border-gray-200 px-2 py-2 text-right text-base" />
        </label>
        <label className="text-xs text-gray-500">メモ
          <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="例：シャンプー台の水漏れ" className="mt-1 block w-full rounded-lg border border-gray-200 px-2 py-2 text-base" />
        </label>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button onClick={() => void addExpense()} disabled={saving} className="rounded-xl bg-blue-600 px-5 py-2 text-sm font-bold text-white disabled:bg-gray-300">{saving ? '登録しています...' : '登録する'}</button>
        <button onClick={() => setShowCategories((value) => !value)} className="text-xs text-blue-600 underline">{showCategories ? '費目の編集を閉じる' : '費目を追加・編集する'}</button>
      </div>

      {showCategories && (
        <div className="mt-2 rounded-xl bg-gray-50 p-3">
          <ul className="flex flex-wrap gap-1.5">
            {categories.map((category) => (
              <li key={category.id} className="flex items-center gap-1 rounded-full border border-gray-200 bg-white px-3 py-1 text-sm">
                {category.name}
                <button onClick={() => void renameCategory(category)} className="ml-1 text-xs text-blue-600">名前変更</button>
                <button onClick={() => void removeCategory(category)} className="text-xs text-red-500">削除</button>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex gap-2">
            <input value={newCategory} onChange={(event) => setNewCategory(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void addCategory() }}
              placeholder="新しい費目（例：備品）" className="min-w-0 flex-1 rounded-lg border border-gray-200 px-3 py-1.5 text-base" />
            <button onClick={() => void addCategory()} className="shrink-0 rounded-lg bg-gray-800 px-3 py-1.5 text-sm font-bold text-white">追加</button>
          </div>
        </div>
      )}

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-max border-collapse text-sm">
          <thead>
            <tr className="bg-gray-100 text-xs text-gray-500">
              <th className="border border-gray-200 px-2 py-1.5 text-left">費目</th>
              {stores.map((store) => <th key={store.id} className="border border-gray-200 px-2 py-1.5 text-right">{store.name}</th>)}
              <th className="border border-gray-200 bg-gray-200 px-2 py-1.5 text-right">全店</th>
            </tr>
          </thead>
          <tbody>
            {usedCategories.map((category) => (
              <tr key={category.id}>
                <td className="border border-gray-200 px-2 py-1.5">{category.name}</td>
                {stores.map((store) => {
                  const value = sumOf((expense) => expense.category_id === category.id && expense.store_id === store.id)
                  return <td key={store.id} className={`border border-gray-200 px-2 py-1.5 text-right ${value ? '' : 'text-gray-300'}`}>{value ? money(value) : '−'}</td>
                })}
                <td className="border border-gray-200 bg-gray-50 px-2 py-1.5 text-right font-medium">{money(sumOf((expense) => expense.category_id === category.id))}</td>
              </tr>
            ))}
            <tr className="font-bold">
              <td className="border border-gray-200 bg-gray-50 px-2 py-1.5">その他の経費 計</td>
              {stores.map((store) => <td key={store.id} className="border border-gray-200 bg-gray-50 px-2 py-1.5 text-right">{money(sumOf((expense) => expense.store_id === store.id))}</td>)}
              <td className="border border-gray-200 bg-gray-100 px-2 py-1.5 text-right">{money(totalOther)}</td>
            </tr>
            <tr>
              <td className="border border-gray-200 px-2 py-1.5 text-gray-600">材料費</td>
              {stores.map((store) => <td key={store.id} className="border border-gray-200 px-2 py-1.5 text-right text-gray-600">{money(materialByStore.get(store.id) ?? 0)}</td>)}
              <td className="border border-gray-200 bg-gray-50 px-2 py-1.5 text-right text-gray-600">{money(totalMaterial)}</td>
            </tr>
            <tr className="font-bold text-blue-900">
              <td className="border border-gray-200 bg-blue-50 px-2 py-1.5">経費合計（材料費＋その他）</td>
              {stores.map((store) => <td key={store.id} className="border border-gray-200 bg-blue-50 px-2 py-1.5 text-right">{money((materialByStore.get(store.id) ?? 0) + sumOf((expense) => expense.store_id === store.id))}</td>)}
              <td className="border border-gray-200 bg-blue-100 px-2 py-1.5 text-right">{money(totalMaterial + totalOther)}</td>
            </tr>
            <tr className="text-blue-800">
              <td className="border border-gray-200 bg-blue-50/50 px-2 py-1.5 text-xs">売上合計（施術＋店販）に対して</td>
              {stores.map((store) => (
                <td key={store.id} className="border border-gray-200 bg-blue-50/50 px-2 py-1.5 text-right font-bold">
                  {rate((materialByStore.get(store.id) ?? 0) + sumOf((expense) => expense.store_id === store.id), salesOf(store.id))}
                </td>
              ))}
              <td className="border border-gray-200 bg-blue-50 px-2 py-1.5 text-right font-bold">{rate(totalMaterial + totalOther, totalSales)}</td>
            </tr>
          </tbody>
        </table>
        <p className="mt-1 text-[11px] text-gray-400">売上が未入力の店舗は割合が「−」になります。</p>
      </div>

      <div className="mt-4">
        <p className="text-sm font-bold text-gray-700">この月の記録（{expenses.length}件）</p>
        <ul className="mt-1 divide-y divide-gray-100">
          {expenses.map((expense) => (
            <li key={expense.id} className="flex flex-wrap items-center gap-2 py-1.5 text-sm">
              <span className="w-12 text-xs text-gray-500">{expense.spent_on.slice(5).replace('-', '/')}</span>
              <span className="w-12 text-xs text-gray-500">{storeName.get(expense.store_id)}</span>
              <span className="rounded bg-gray-100 px-1.5 text-xs text-gray-700">{categoryName.get(expense.category_id)}</span>
              {editingId === expense.id ? (
                <>
                  <input value={editAmount} onChange={(event) => setEditAmount(event.target.value)} inputMode="numeric" className="w-28 rounded border border-gray-200 px-2 py-1 text-right text-base" />
                  <input value={editNote} onChange={(event) => setEditNote(event.target.value)} placeholder="メモ" className="min-w-0 flex-1 rounded border border-gray-200 px-2 py-1 text-base" />
                  <button onClick={() => void saveEdit(expense)} className="rounded bg-blue-600 px-2 py-1 text-xs text-white">保存</button>
                  <button onClick={() => setEditingId(null)} className="rounded bg-gray-100 px-2 py-1 text-xs text-gray-600">やめる</button>
                </>
              ) : (
                <>
                  <span className="w-24 text-right font-medium">{money(expense.amount)}</span>
                  <span className="min-w-0 flex-1 break-words text-xs text-gray-500">{expense.note}</span>
                  <button onClick={() => { setEditingId(expense.id); setEditAmount(String(taxIncluded ? withTax(expense.amount) : expense.amount)); setEditNote(expense.note ?? '') }} className="rounded bg-gray-100 px-2 py-1 text-xs text-gray-600">修正</button>
                  <button onClick={() => void removeExpense(expense)} className="rounded bg-red-50 px-2 py-1 text-xs text-red-600">削除</button>
                </>
              )}
            </li>
          ))}
        </ul>
        {expenses.length === 0 && <p className="py-3 text-center text-xs text-gray-400">まだありません</p>}
      </div>
    </section>
  )
}

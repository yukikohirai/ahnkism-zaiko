// Supabase の API は1回で最大1000行までしか返さない（.limit で大きくしても1000で切れる）。
// 件数が増えても取りこぼさないよう、1000行ずつ続けて取得する。
// 途中で並びがずれないよう、呼び出し側で一意に決まる order を付けること。
type PageResult = { data: unknown[] | null; error: { message: string } | null }

// 型を付けていない Supabase クライアントの戻り値に合わせ、既定は any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function fetchAll<T = any>(page: (from: number, to: number) => PromiseLike<PageResult>, pageSize = 1000) {
  const rows: T[] = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await page(from, from + pageSize - 1)
    if (error) return { data: null as T[] | null, error }
    rows.push(...((data ?? []) as T[]))
    if (!data || data.length < pageSize) break
  }
  return { data: rows as T[] | null, error: null as { message: string } | null }
}

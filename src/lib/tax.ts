// 価格は税抜で保存し、税込は表示・入力時に換算する
export const TAX_RATE = 0.1

export function withTax(amount: number) {
  return Math.round(amount * (1 + TAX_RATE))
}

export function withoutTax(amount: number) {
  return Math.round(amount / (1 + TAX_RATE))
}

export function yen(amount: number | null | undefined) {
  if (amount === null || amount === undefined) return '−'
  return `¥${Math.round(amount).toLocaleString('ja-JP')}`
}

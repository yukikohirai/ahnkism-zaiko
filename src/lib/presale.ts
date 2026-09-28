import { withTax } from '@/lib/tax'

export type DiscountType = 'percent' | 'yen'

export type PresaleCampaign = {
  id: number
  name: string
  reception_start: string | null
  reception_end: string | null
  delivery_month: string | null
  is_active: boolean
  is_test?: boolean
}

export type PresaleItem = {
  campaign_id: number
  product_id: number
  discount_type: DiscountType
  discount_value: number
  bulk_excluded: boolean
}

export type PresaleItemWithProduct = PresaleItem & { brand: string | null; name: string; sale_price: number | null }

export type BulkTier = { campaign_id: number; min_qty: number; percent: number }

export type Staff = { id: number; store_id: number; name: string; sort_order: number; is_active: boolean }

export type StaffGoal = { campaign_id: number; staff_id: number; goal_amount: number }

export type OrderLine = {
  id?: string
  product_id: number
  quantity: number
  regular_price: number | null
  unit_price: number | null
  line_discount_type?: DiscountType | null
  line_discount_value?: number | null
}

export type PresaleOrder = {
  id: string
  campaign_id: number
  store_id: number
  reserved_on: string
  customer_name: string
  stylist_id: number | null
  staff_id: number | null
  total_qty: number
  applied_percent: number | null
  total_amount: number
  delivered_at: string | null
  cancelled_at: string | null
  created_at: string
  lines: OrderLine[]
}

// 店舗の予約ページの合言葉と暗証番号（本部画面では null）
export type PortalAccess = { token: string; pin: string } | null

// 販売価格（税抜で保存）から税込の通常価格を出す
export function regularPriceWithTax(salePrice: number | null) {
  return salePrice === null ? null : withTax(salePrice)
}

// 割引は税込価格に対して行い、1円未満は四捨五入
export function discountedPrice(regular: number | null, type: DiscountType, value: number) {
  if (regular === null) return null
  if (type === 'percent') return Math.round(regular * (1 - value / 100))
  return Math.max(0, Math.round(regular - value))
}

export function discountLabel(type: DiscountType, value: number) {
  if (!value) return '割引なし'
  return type === 'percent' ? `${value}%オフ` : `${Math.round(value).toLocaleString('ja-JP')}円引き`
}

// 予約1件の金額（画面の見積もり用。保存時はデータベース側で同じ計算をして確定する）
// まとめ買い対象の合計個数で段階を決め、到達していれば対象商品は全部その％に置き換える
// 優先順：その行だけの割引 → まとめ買い（対象外の商品は除く） → 商品ごとの割引
export function priceOrder(
  lines: { product_id: number; quantity: number; discount_type?: DiscountType | null; discount_value?: number | null }[],
  items: Map<number, PresaleItemWithProduct>,
  tiers: BulkTier[],
) {
  const count = lines.reduce((sum, line) => sum + (items.get(line.product_id)?.bulk_excluded ? 0 : line.quantity), 0)
  const tier = [...tiers].sort((a, b) => b.min_qty - a.min_qty).find((item) => count >= item.min_qty)
  const priced = lines.map((line) => {
    const item = items.get(line.product_id)
    const regular = item ? regularPriceWithTax(item.sale_price) : null
    const unit = !item || regular === null ? null
      : line.discount_type ? discountedPrice(regular, line.discount_type, Number(line.discount_value ?? 0))
        : tier && !item.bulk_excluded ? Math.round(regular * (1 - Number(tier.percent) / 100))
          : discountedPrice(regular, item.discount_type, Number(item.discount_value))
    return { ...line, regular_price: regular, unit_price: unit }
  })
  return {
    count,
    percent: tier ? Number(tier.percent) : null,
    lines: priced,
    total: priced.reduce((sum, line) => sum + (line.unit_price ?? 0) * line.quantity, 0),
    missingPrice: priced.some((line) => line.unit_price === null),
  }
}

export function todayInTokyo() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' })
}

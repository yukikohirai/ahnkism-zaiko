import { withTax } from '@/lib/tax'

export type DiscountType = 'percent' | 'yen'

export type PresaleCampaign = {
  id: number
  name: string
  reception_start: string | null
  reception_end: string | null
  delivery_month: string | null
  is_active: boolean
}

export type PresaleItem = {
  campaign_id: number
  product_id: number
  discount_type: DiscountType
  discount_value: number
}

export type Staff = { id: number; store_id: number; name: string; sort_order: number; is_active: boolean }

export type Reservation = {
  id: string
  campaign_id: number
  store_id: number
  reserved_on: string
  customer_name: string
  stylist_id: number | null
  staff_id: number | null
  product_id: number
  quantity: number
  regular_price: number | null
  unit_price: number | null
  delivered_at: string | null
  cancelled_at: string | null
  created_at: string
}

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

export function todayInTokyo() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' })
}

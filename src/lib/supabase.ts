import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

export const supabase = createClient(url, key)

export type Store = { id: number; name: string; sort_order: number }
export type Category = { id: number; name: string; sort_order: number }
export type Product = {
  id: number
  category_id: number
  brand: string | null
  name: string
  required_qty: number
  sort_order: number
}
export type UsageLog = {
  id: number
  store_id: number
  product_id: number
  date: string
  quantity: number
}

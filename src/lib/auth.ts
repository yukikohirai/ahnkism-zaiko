import { supabase } from '@/lib/supabase'

export type UserProfile = {
  user_id: string
  login_id: string
  role: 'hq' | 'store'
  store_id: number | null
  display_name: string
}

const LOGIN_EMAILS: Record<string, string> = {
  honbu: 'honbu@ahnkism-zaiko.jp',
  labo: 'labo@ahnkism-zaiko.jp',
  nit: 'nit@ahnkism-zaiko.jp',
  elu: 'elu@ahnkism-zaiko.jp',
}

export function emailForLoginId(loginId: string) {
  return LOGIN_EMAILS[loginId.trim().toLocaleLowerCase()] ?? null
}

export async function getCurrentProfile() {
  const { data: userData } = await supabase.auth.getUser()
  if (!userData.user) return null

  const { data } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('user_id', userData.user.id)
    .single()

  return (data as UserProfile | null) ?? null
}

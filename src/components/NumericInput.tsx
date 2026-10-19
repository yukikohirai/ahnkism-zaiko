'use client'

import { useRef } from 'react'

// 数字だけを入れる欄。
// 日本語キーボード（スマホのフリック入力など）は確定するまで「変換中」になる。変換中に中身を書き換えると
// 確定した文字がもう一度入って桁が増えることがあるので、変換中はそのままにして、確定したあとで数字だけに整える。
// selectOnFocus：欄を押すと中身を全部選ぶ（そのまま打てば置き換わる）
export function cleanDigits(value: string) {
  return value.normalize('NFKC').replace(/[^0-9]/g, '')
}

export default function NumericInput({ value, onChange, selectOnFocus = false, className, placeholder, ariaLabel }: {
  value: string
  onChange: (value: string) => void
  selectOnFocus?: boolean
  className?: string
  placeholder?: string
  ariaLabel?: string
}) {
  const composing = useRef(false)
  return (
    <input
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      autoComplete="off"
      value={value}
      placeholder={placeholder}
      aria-label={ariaLabel}
      className={className}
      onFocus={(event) => {
        if (!selectOnFocus) return
        const input = event.currentTarget
        window.setTimeout(() => { if (document.activeElement === input) input.select() }, 0)
      }}
      onCompositionStart={() => { composing.current = true }}
      onCompositionEnd={(event) => {
        composing.current = false
        onChange(cleanDigits(event.currentTarget.value))
      }}
      onChange={(event) => {
        const raw = event.target.value
        onChange(composing.current ? raw : cleanDigits(raw))
      }}
      onBlur={(event) => {
        composing.current = false
        const cleaned = cleanDigits(event.currentTarget.value)
        if (cleaned !== event.currentTarget.value) onChange(cleaned)
      }}
    />
  )
}

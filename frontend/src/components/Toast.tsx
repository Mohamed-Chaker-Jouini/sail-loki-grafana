import { useEffect, useRef } from 'react'

// global singleton so any page can call showToast()
let _show: ((msg: string) => void) | null = null
export function showToast(msg: string) { _show?.(msg) }

export default function Toast() {
  const ref   = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    _show = (msg: string) => {
      if (!ref.current) return
      ref.current.textContent = msg
      ref.current.classList.add('show')
      clearTimeout(timer.current)
      timer.current = setTimeout(() => ref.current?.classList.remove('show'), 3000)
    }
    return () => { _show = null }
  }, [])

  return <div id="toast" ref={ref} />
}
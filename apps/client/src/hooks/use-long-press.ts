import { useRef, useCallback } from 'react'

interface UseLongPressOptions {
  ms?: number
  onLongPress: () => void
}

export function useLongPress({ onLongPress, ms = 500 }: UseLongPressOptions) {
  const timerRef = useRef<number | null>(null)

  const onTouchStart = useCallback(() => {
    timerRef.current = window.setTimeout(onLongPress, ms)
  }, [onLongPress, ms])

  const onTouchEnd = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  return {
    onTouchStart,
    onTouchEnd,
    onTouchMove: onTouchEnd,
  }
}

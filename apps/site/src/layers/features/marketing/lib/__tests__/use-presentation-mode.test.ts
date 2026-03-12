/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { usePresentationMode } from '../use-presentation-mode'

vi.mock('next/navigation', () => ({
  useSearchParams: vi.fn(),
}))

import { useSearchParams } from 'next/navigation'

describe('usePresentationMode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns false when ?present param is absent', () => {
    vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams() as ReturnType<typeof useSearchParams>)
    const { result } = renderHook(() => usePresentationMode())
    expect(result.current).toBe(false)
  })

  it('returns true when ?present=true', () => {
    vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams('present=true') as ReturnType<typeof useSearchParams>)
    const { result } = renderHook(() => usePresentationMode())
    expect(result.current).toBe(true)
  })

  it('returns false when ?present=false', () => {
    vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams('present=false') as ReturnType<typeof useSearchParams>)
    const { result } = renderHook(() => usePresentationMode())
    expect(result.current).toBe(false)
  })

  it('returns false when ?present has an unexpected value', () => {
    vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams('present=1') as ReturnType<typeof useSearchParams>)
    const { result } = renderHook(() => usePresentationMode())
    expect(result.current).toBe(false)
  })
})

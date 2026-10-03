import { useEffect, useRef, type DependencyList } from 'react'

export type Draw = (ctx: CanvasRenderingContext2D, w: number, h: number, dpr: number) => void

// a canvas redrawn every frame at its on-screen size (device pixels)
export function useCanvasLoop(draw: Draw, deps: DependencyList) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current!
    const ctx = canvas.getContext('2d')!
    let raf = 0
    const loop = () => {
      raf = requestAnimationFrame(loop)
      const dpr = window.devicePixelRatio || 1
      const w = Math.round(canvas.clientWidth * dpr)
      const h = Math.round(canvas.clientHeight * dpr)
      if (!w || !h) return
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
      draw(ctx, w, h, dpr)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, deps)
  return ref
}

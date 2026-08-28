import { useState, useEffect, useRef } from 'react';

/** F: setState after a ref-guarded early return */
export function useF(x: number): number {
  const first = useRef(true);
  const [v, setV] = useState(0);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setV(Date.now() + x);
  }, [x]);
  return v;
}

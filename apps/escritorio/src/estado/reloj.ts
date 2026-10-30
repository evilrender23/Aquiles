import { useEffect, useState } from "react";

/** Date.now() que se actualiza cada `cadaMs` (para fechas relativas). */
export function useReloj(cadaMs: number): number {
  const [ahora, setAhora] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setAhora(Date.now()), cadaMs);
    return () => clearInterval(t);
  }, [cadaMs]);
  return ahora;
}

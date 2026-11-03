// The one port the core talks to the outside world through. `hooks/register.ts`
// implements it with `$`; tests implement it with Node or in memory.

export const iso = (ms: number): string => new Date(ms).toISOString()

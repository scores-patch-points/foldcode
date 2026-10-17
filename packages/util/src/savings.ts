// How a fold saving reads at a glance. One definition, so every surface that shows what the
// fold kept out of the frontier — the corner tally, the Sent panel, the door's own /fold
// readout — can never disagree on the shape of the same number.

// Money reads in whole cents, rounded up: 5.5830 -> "$5.59". A saving is an estimate (the
// door's own note: "estimate, not an invoice"), so rounding up never understates what was
// kept out of the frontier.
export const money = (usd: number) => `$${(Math.ceil(usd * 100) / 100).toFixed(2)}`

// Tokens read in the compact form a person scans at a glance: 3130000 -> "3.13M". Two
// decimals from K up, a plain integer below.
export const compact = (n: number) => {
  const abs = Math.abs(n)

  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`

  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`

  if (abs >= 1e3) return `${(n / 1e3).toFixed(2)}K`

  return String(Math.round(n))
}

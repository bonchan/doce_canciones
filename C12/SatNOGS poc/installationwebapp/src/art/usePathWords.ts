import { useMemo } from 'react'
import { useStrings } from '../i18n.ts'
import { link, useLink } from '../link.ts'
import type { Slot } from '../shared/protocol.ts'
import { geometryFor } from '../timeline.ts'
import { pathWords, type PathWord } from './field.ts'
import { phraseSeed } from './phrases.ts'

// the phrase words of a slot, the same on every display; null while phrases are off
export function usePathWords(slot: Slot | null): PathWord[] | null {
  const config = useLink().state?.config
  const vocabulary = useStrings().phrases
  const seed = slot ? phraseSeed(slot.id, slot.pass.id) : 0
  const passId = slot?.pass.id
  const on = !!config?.phrases
  const location = config?.location
  return useMemo(() => {
    const c = link.state?.config
    if (!slot || !c || !on) return null
    return pathWords(seed, vocabulary, geometryFor(slot.pass, c))
  }, [seed, passId, on, location, vocabulary])
}

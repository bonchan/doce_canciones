// The phrase of a pass: the words placed on the satellite's path (src/art/field.ts), in the
// order it meets them. As it flies over each one, the word starts arriving in the image.
//
// The rest of the code only knows the PhraseGenerator interface, so a smarter generator (words
// that connect, grammar, words that relate to the pass...) can replace RandomWords later.
// Generators get the whole "phrases" section of the display language, so new word lists
// (nouns, verbs...) can be added to the language files for them.
import type { Strings } from '../i18n.ts'

export type Vocabulary = Strings['phrases'] // { words: [...] } in src/lang/*.json

export interface PhraseGenerator {
  // the words on the path, in order; the same seed and vocabulary always give the same ones,
  // so every display agrees
  phrase(seed: number, vocabulary: Vocabulary): string[]
}

// seeded random numbers in [0, 1) (mulberry32)
export function random(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// a few different words, picked at random
export class RandomWords implements PhraseGenerator {
  constructor(
    readonly minWords = 3,
    readonly maxWords = 6,
  ) {}

  phrase(seed: number, vocabulary: Vocabulary): string[] {
    const rand = random(seed)
    const pool = [...new Set(vocabulary.words)]
    const count = Math.min(pool.length, this.minWords + Math.floor(rand() * (this.maxWords - this.minWords + 1)))
    const picked: string[] = []
    for (let i = 0; i < count; i++) picked.push(pool.splice(Math.floor(rand() * pool.length), 1)[0])
    return picked
  }
}

export const phrases: PhraseGenerator = new RandomWords()

// one seed per pass on the timeline: unchanged when it's re-timed (speed, restart)
export const phraseSeed = (slotId: number, passId: number) => (Math.imul(slotId, 2654435761) ^ passId) >>> 0

// a seed from a word, for things that should look the same for it on every display
export const textSeed = (text: string) =>
  [...text].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619), 2166136261) >>> 0

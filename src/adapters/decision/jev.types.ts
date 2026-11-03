// The System One API's shapes (docs.typesafe.ai/api/system-one), as OpenRouter
// serves them at POST https://openrouter.ai/api/v1/systemone.

export type NoulQuestion = { type: 'noul'; instructions: string }

/** `criteria`: option name -> a distinct description of it. */
export type ChoiceQuestion = { type: 'choice'; instructions: string; criteria: Record<string, string> }

/** `criteria`: the ordered levels, lowest first; the answer is 0-based. */
export type ScoreQuestion = { type: 'score'; instructions: string; criteria: readonly string[] }

export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion

export type NoulAnswer = { type: 'noul'; noul: number }

export type ChoiceAnswer = { type: 'choice'; choice: string; confidence: number | null; probabilities?: Record<string, number> }

/** `score`: the mean level over the probabilities, 0-based and fractional. */
export type ScoreAnswer = { type: 'score'; score: number; confidence: number | null; probabilities?: Record<string, number> }

export type JevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer

export interface JevUsage {
  input_tokens: number
  output_tokens: number
  /** OpenRouter adds what the call cost, in US$. */
  cost?: number
}

export interface JevRequest {
  model: string
  state: unknown
  questions: Record<string, JevQuestion>
}

export interface JevResponse {
  /** The model that answered (`typesafe/jev-1.14-20261014`): logged with every decision. */
  model: string
  answers: Record<string, JevAnswer>
  usage?: JevUsage
}

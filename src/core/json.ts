// Typed reads of JSON whose shape is not trusted: each returns the value when it has
// the expected type, undefined otherwise. Parsers for external input are built on these.
import type { JsonObject } from './json.types.ts'

export const isJsonObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v)

/** JSON.parse that answers undefined for text that is not JSON. */
export function tryParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export const objectAt = (o: JsonObject, key: string): JsonObject | undefined => (isJsonObject(o[key]) ? (o[key] as JsonObject) : undefined)
export const stringAt = (o: JsonObject, key: string): string | undefined => (typeof o[key] === 'string' ? (o[key] as string) : undefined)
export const numberAt = (o: JsonObject, key: string): number | undefined => (typeof o[key] === 'number' && Number.isFinite(o[key]) ? (o[key] as number) : undefined)
export const booleanAt = (o: JsonObject, key: string): boolean | undefined => (typeof o[key] === 'boolean' ? (o[key] as boolean) : undefined)
export const arrayAt = (o: JsonObject, key: string): readonly unknown[] => (Array.isArray(o[key]) ? (o[key] as unknown[]) : [])
export const objectsAt = (o: JsonObject, key: string): JsonObject[] => arrayAt(o, key).filter(isJsonObject)

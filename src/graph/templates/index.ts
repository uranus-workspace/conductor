import type { GraphTemplate, TemplateId } from '../graph.types.ts'
import { bugfix } from './bugfix.ts'
import { feature } from './feature.ts'
import { refactor } from './refactor.ts'
import { secure } from './secure.ts'
import { solo } from './solo.ts'
import { spike } from './spike.ts'

export const TEMPLATES: Readonly<Record<TemplateId, GraphTemplate>> = { solo, feature, bugfix, refactor, secure, spike }

export const TEMPLATE_IDS: readonly TemplateId[] = ['solo', 'feature', 'bugfix', 'refactor', 'secure', 'spike']

export const isTemplateId = (v: string): v is TemplateId => (TEMPLATE_IDS as readonly string[]).includes(v)

/** A task's template; unknown or missing → solo, the default. */
export const templateOf = (id: string | undefined): GraphTemplate => (id !== undefined && isTemplateId(id) ? TEMPLATES[id] : solo)

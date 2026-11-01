import { describe, expect, it } from 'vitest'
import { EMPTY_IDENTITY, identityCommand, identityDraftFor, identityDraftIssue } from './member-identity-draft'

describe('professional responsibilities draft', () => {
  it.each(['中'.repeat(20_000), '😀'.repeat(20_000), 'e\u0301'.repeat(10_000), '"\n\0中😀'.repeat(4_000)])(
    'accepts 20,000 scalars after trimming and preserves the overlong draft',
    (text) => {
      const draft = { ...EMPTY_IDENTITY, displayName: '队员', professionalResponsibilities: ` \uFEFF${text}\n ` }
      expect(identityDraftIssue(draft, null, [])).toBeNull()
      expect(identityCommand(draft, null).professionalResponsibilities).toBe(text)
      draft.professionalResponsibilities = `${text}界`
      const original = { ...draft }
      expect(identityDraftIssue(draft, null, [])?.field).toBe('professionalResponsibilities')
      expect(draft).toEqual(original)
    }
  )

  it.each(['workingPrinciples', 'growthTopic'] as const)(
    'accepts 3,000 scalars of %s after trimming and rejects one more',
    (field) => {
      for (const text of ['中'.repeat(3_000), '😀'.repeat(3_000), 'e\u0301'.repeat(1_500), '"\n\0中😀'.repeat(600)]) {
        const draft = { ...EMPTY_IDENTITY, displayName: '队员', [field]: ` \uFEFF${text}\n ` }
        expect(identityDraftIssue(draft, null, [])).toBeNull()
        expect(identityCommand(draft, null)[field]).toBe(text)
        draft[field] = `${text}界`
        const original = { ...draft }
        const issue = identityDraftIssue(draft, null, [])
        expect(issue?.field).toBe(field)
        expect(issue?.message).toContain('3,000')
        expect(draft).toEqual(original)
      }
    }
  )

  it('preserves internal formatting, counts combining marks, and keeps the other limits', () => {
    const draft = { ...identityDraftFor(null), displayName: '队员' }
    draft.professionalResponsibilities = '\u0085a\n  b\u0085'
    expect(identityCommand(draft, null).professionalResponsibilities).toBe(draft.professionalResponsibilities)
    draft.professionalResponsibilities = ' \uFEFF\n'
    expect(identityCommand(draft, null).professionalResponsibilities).toBe('')
    for (const [field, length] of [['displayName', 81], ['teamRole', 121], ['workingPrinciples', 3_001], ['growthTopic', 3_001]] as const) {
      expect(identityDraftIssue({ ...draft, [field]: '中'.repeat(length) }, null, [])?.field).toBe(field)
    }
    expect(identityDraftIssue({ ...draft, displayName: '中'.repeat(80), teamRole: '中'.repeat(120) }, null, [])).toBeNull()
    expect(identityDraftIssue({ ...draft, personalityTraits: ['中'.repeat(16)] }, null, [])).toBeNull()
    expect(identityDraftIssue({ ...draft, personalityTraits: ['中'.repeat(17)] }, null, [])?.field).toBe('personalityTraits')
    expect(identityDraftIssue({ ...draft, personalityTraits: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }, null, [])?.field).toBe('personalityTraits')
  })
})

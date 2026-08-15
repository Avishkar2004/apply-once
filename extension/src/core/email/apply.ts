import type { DocumentRef, Profile } from '@autofill/core';
import type { DraftEmailRequest, DraftEmailResponse } from '@/shared/messages';
import { createLogger } from '@/shared/logger';
import { canDraft } from '@/llm/answer-draft';
import { describeLlmError, LlmDisabledError } from '@/llm/client';
import { draftApplicationEmail, plainApplicationEmail } from '@/llm/email-draft';
import { recordEmailApplication, markEmailSent } from '@/storage/audit-log';
import { readProfile } from '@/storage/profile-store';

const log = createLogger('email/apply');

/**
 * Email Apply, worker-side (ARCHITECTURE.md §3.7).
 *
 * The same shape as `core/answers`: the worker holds the DEK, so it is the only
 * place that can put the profile in front of a model, and the content script
 * asks for a draft rather than for the profile.
 *
 * Two rules live here rather than in the caller:
 *
 *  - the draft is recorded the moment it exists, as `drafted`. An application
 *    the user composed and never sent is exactly what the history is for;
 *  - a model that is off, unconfigured, or failing never costs the user the
 *    address. Detection is local and free; the fallback is a subject line and an
 *    empty body, opened in their own mail client (§6.3).
 *
 * Nothing here sends anything. There is no code path from this module to a
 * network call that delivers mail — the same architectural guarantee as §6.7.
 */

/** Documents the user has to attach by hand — see `core/email/send.ts`. */
const ATTACHABLE = ['resume', 'coverLetter', 'portfolio', 'transcript'] as const;

export async function requestEmailDraft(request: DraftEmailRequest): Promise<DraftEmailResponse> {
  // Throws VaultLockedError when locked — the overlay turns that into an unlock
  // prompt, exactly as a fill does.
  const profile = await readProfile();
  const attachments = attachmentsFor(profile);

  const drafted = await compose(request, profile, attachments.map((file) => file.filename));

  const entryId = await recordEmailApplication({
    hostname: request.hostname,
    url: request.url,
    ...(request.page.jobTitle ? { jobTitle: request.page.jobTitle } : {}),
    ...(request.page.company ? { company: request.page.company } : {}),
    to: request.to,
  });

  log.info(`email draft ready for ${request.to} (${drafted.source})`);
  return { ...drafted, attachments, entryId };
}

/**
 * Compose, or fall back.
 *
 * Every failure lands on the plain path with the reason attached rather than
 * throwing: a provider outage should cost the *wording*, not the ability to
 * apply. The panel shows the notice, so nothing is silently degraded.
 */
async function compose(
  request: DraftEmailRequest,
  profile: Profile,
  filenames: string[],
): Promise<Pick<DraftEmailResponse, 'subject' | 'body' | 'source' | 'notice'>> {
  const plain = () => plainApplicationEmail(profile, request.page);

  if (!canDraft(profile)) {
    return {
      ...plain(),
      source: 'plain',
      notice: 'Add your work history to the profile and AutoFill can write this email for you.',
    };
  }

  try {
    const draft = await draftApplicationEmail({
      to: request.to,
      page: request.page,
      profile,
      ...(filenames.length ? { attachments: filenames } : {}),
    });
    return { subject: draft.subject, body: draft.body, source: 'llm' };
  } catch (error) {
    if (!(error instanceof LlmDisabledError)) log.warn('could not draft the email', error);
    return { ...plain(), source: 'plain', notice: describeLlmError(error) };
  }
}

/** The stored documents, résumé first — the order the panel lists them in. */
function attachmentsFor(profile: Profile): DraftEmailResponse['attachments'] {
  const out: DraftEmailResponse['attachments'] = [];
  for (const slot of ATTACHABLE) {
    const ref: DocumentRef | undefined = profile.documents[slot];
    if (ref?.blobId) out.push({ slot, filename: ref.filename, blobId: ref.blobId });
  }
  return out;
}

/**
 * The user clicked a send action.
 *
 * "Sent" means a compose window opened holding this draft — AutoFill cannot see
 * what happens in the mail client, and recording anything stronger would put a
 * claim in the history that nothing verified.
 */
export async function confirmEmailSent(entryId: number, to?: string): Promise<void> {
  await markEmailSent(entryId, to);
  log.info('email application marked as sent');
}

/**
 * Handing a composed email to something that can actually send it
 * (ARCHITECTURE.md §3.7).
 *
 * AutoFill does not send mail. It cannot: an extension has no SMTP credentials
 * and should not want any, and "we quietly emailed someone on your behalf" is
 * the same class of promise as "we quietly submitted your application", which
 * §6.7 rules out on purpose. Every route here ends in a compose window the user
 * looks at before pressing send.
 *
 * None of the three can carry an attachment. `mailto:` has no attachment
 * parameter by design (RFC 6068 forbids it — it would let any web page make you
 * mail a local file), Gmail's compose URL has no such parameter either, and the
 * clipboard holds text. So the panel states which file to attach and offers the
 * résumé as a download; the user attaches it in their mail client. Pretending
 * otherwise would produce applications sent without the CV they promise.
 */

export interface ComposedEmail {
  to: string;
  subject: string;
  body: string;
}

export type SendMethod = 'mailto' | 'gmail' | 'clipboard';

/**
 * `mailto:` for the default mail client.
 *
 * `encodeURIComponent` rather than `URLSearchParams`, because the latter encodes
 * spaces as `+` and mail clients render that literally — a body full of plus
 * signs is the classic symptom.
 */
export function mailtoUrl(email: ComposedEmail): string {
  const query = [
    `subject=${encodeURIComponent(email.subject)}`,
    `body=${encodeURIComponent(email.body)}`,
  ].join('&');
  return `mailto:${encodeURIComponent(email.to)}?${query}`;
}

/** Gmail's compose window, prefilled. Opens in a new tab. */
export function gmailComposeUrl(email: ComposedEmail): string {
  const query = [
    'view=cm',
    'fs=1',
    `to=${encodeURIComponent(email.to)}`,
    `su=${encodeURIComponent(email.subject)}`,
    `body=${encodeURIComponent(email.body)}`,
  ].join('&');
  return `https://mail.google.com/mail/?${query}`;
}

/** What lands on the clipboard: headers first, so it can be pasted anywhere. */
export function plainTextEmail(email: ComposedEmail): string {
  return `To: ${email.to}\nSubject: ${email.subject}\n\n${email.body}`;
}

import { useMemo, useState } from 'react';
import {
  EEO_OPTIONS,
  profileCompleteness,
  profileDrift,
  toBase64,
  type EducationEntry,
  type Profile,
  type WorkEntry,
} from '@autofill/core';
import { sendToBackground } from '@/shared/messaging';
import { extractDocumentText } from '@/documents/pdf-text';
import {
  Banner,
  Button,
  CheckboxField,
  ListEditor,
  Section,
  SelectField,
  TextArea,
  TextField,
} from '@/ui/components';

/**
 * The profile editor — milestone M0's acceptance test ("you can enter and
 * persist a full profile").
 *
 * The editor is deliberately permissive: it saves partial profiles, because
 * people fill this in over several sittings. What is missing is surfaced as
 * advice at the top, never as a blocked save.
 */

const str = (value: string | undefined): string => value ?? '';

export function ProfileEditor({
  profile,
  onChange,
  onSaved,
}: {
  profile: Profile;
  onChange: (next: Profile) => void;
  onSaved: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | undefined>();

  const completeness = useMemo(() => profileCompleteness(profile), [profile]);
  // §11 — "prompt for a review after 90 days without an edit".
  const drift = useMemo(() => profileDrift(profile), [profile]);

  const save = async () => {
    setSaving(true);
    setMessage(undefined);
    try {
      await sendToBackground('profile:save', { profile });
      setMessage({ tone: 'success', text: 'Profile saved.' });
      onSaved();
    } catch (cause) {
      setMessage({ tone: 'error', text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Your profile</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Stored encrypted on this device. Nothing is uploaded.
          </p>
        </div>
        <Button variant="primary" onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : 'Save profile'}
        </Button>
      </div>

      {message && <Banner tone={message.tone}>{message.text}</Banner>}

      {drift.stale && (
        <Banner tone="warn">
          You last updated this {drift.daysSinceUpdate} days ago. Applications are filling from it
          as-is — worth a look before your next one.
        </Banner>
      )}

      {!completeness.ready && (
        <Banner tone="warn">
          Still missing: {completeness.missing.map((item) => item.label).join(', ')}. You can save now and
          finish later — applications will just skip those fields.
        </Banner>
      )}

      <Section title="Personal">
        <TextField
          label="First name"
          value={profile.personal.firstName}
          onChange={(firstName) => onChange({ ...profile, personal: { ...profile.personal, firstName } })}
        />
        <TextField
          label="Last name"
          value={profile.personal.lastName}
          onChange={(lastName) => onChange({ ...profile, personal: { ...profile.personal, lastName } })}
        />
        <TextField
          label="Middle name"
          value={str(profile.personal.middleName)}
          onChange={(middleName) => onChange({ ...profile, personal: { ...profile.personal, middleName } })}
        />
        <TextField
          label="Preferred name"
          value={str(profile.personal.preferredName)}
          onChange={(preferredName) =>
            onChange({ ...profile, personal: { ...profile.personal, preferredName } })
          }
        />
        <TextField
          label="Pronouns"
          value={str(profile.personal.pronouns)}
          placeholder="they/them"
          onChange={(pronouns) => onChange({ ...profile, personal: { ...profile.personal, pronouns } })}
        />
        <TextField
          label="Date of birth"
          hint="YYYY-MM-DD"
          value={str(profile.personal.dateOfBirth)}
          onChange={(dateOfBirth) => onChange({ ...profile, personal: { ...profile.personal, dateOfBirth } })}
        />
      </Section>

      <Section title="Contact">
        <TextField
          label="Email"
          type="email"
          value={str(profile.contact.email)}
          onChange={(email) => onChange({ ...profile, contact: { ...profile.contact, email } })}
        />
        <TextField
          label="Phone"
          value={profile.contact.phone}
          onChange={(phone) => onChange({ ...profile, contact: { ...profile.contact, phone } })}
        />
        <TextField
          label="Phone country code"
          hint="+1"
          value={str(profile.contact.phoneCountryCode)}
          onChange={(phoneCountryCode) =>
            onChange({ ...profile, contact: { ...profile.contact, phoneCountryCode } })
          }
        />
        <div />
        <TextField
          label="Address line 1"
          span
          value={profile.contact.address.line1}
          onChange={(line1) =>
            onChange({ ...profile, contact: { ...profile.contact, address: { ...profile.contact.address, line1 } } })
          }
        />
        <TextField
          label="Address line 2"
          span
          value={str(profile.contact.address.line2)}
          onChange={(line2) =>
            onChange({ ...profile, contact: { ...profile.contact, address: { ...profile.contact.address, line2 } } })
          }
        />
        <TextField
          label="City"
          value={profile.contact.address.city}
          onChange={(city) =>
            onChange({ ...profile, contact: { ...profile.contact, address: { ...profile.contact.address, city } } })
          }
        />
        <TextField
          label="State / province"
          value={profile.contact.address.state}
          onChange={(state) =>
            onChange({ ...profile, contact: { ...profile.contact, address: { ...profile.contact.address, state } } })
          }
        />
        <TextField
          label="Postal code"
          value={profile.contact.address.postalCode}
          onChange={(postalCode) =>
            onChange({
              ...profile,
              contact: { ...profile.contact, address: { ...profile.contact.address, postalCode } },
            })
          }
        />
        <TextField
          label="Country"
          value={profile.contact.address.country}
          onChange={(country) =>
            onChange({ ...profile, contact: { ...profile.contact, address: { ...profile.contact.address, country } } })
          }
        />
      </Section>

      <Section title="Links">
        <TextField
          label="LinkedIn"
          value={str(profile.links.linkedin)}
          onChange={(linkedin) => onChange({ ...profile, links: { ...profile.links, linkedin } })}
        />
        <TextField
          label="GitHub"
          value={str(profile.links.github)}
          onChange={(github) => onChange({ ...profile, links: { ...profile.links, github } })}
        />
        <TextField
          label="Portfolio"
          value={str(profile.links.portfolio)}
          onChange={(portfolio) => onChange({ ...profile, links: { ...profile.links, portfolio } })}
        />
        <TextField
          label="Website"
          value={str(profile.links.website)}
          onChange={(website) => onChange({ ...profile, links: { ...profile.links, website } })}
        />
      </Section>

      <Section
        title="Work history"
        description="Order matters — repeating sections on an application form are filled top to bottom."
      >
        <ListEditor<WorkEntry>
          items={profile.work}
          onChange={(work) => onChange({ ...profile, work })}
          create={() => ({ company: '', title: '', current: false })}
          addLabel="Add a role"
          emptyLabel="No roles yet."
          render={(entry, update) => (
            <>
              <TextField label="Company" value={entry.company} onChange={(company) => update({ company })} />
              <TextField label="Title" value={entry.title} onChange={(title) => update({ title })} />
              <TextField
                label="Start date"
                hint="YYYY-MM"
                value={str(entry.startDate)}
                onChange={(startDate) => update({ startDate })}
              />
              <TextField
                label="End date"
                hint="YYYY-MM"
                value={str(entry.endDate)}
                onChange={(endDate) => update({ endDate })}
              />
              <TextField
                label="Location"
                value={str(entry.location)}
                onChange={(location) => update({ location })}
              />
              <SelectField
                label="Employment type"
                value={entry.employmentType ?? ''}
                options={[
                  { value: 'full-time', label: 'Full-time' },
                  { value: 'part-time', label: 'Part-time' },
                  { value: 'contract', label: 'Contract' },
                  { value: 'internship', label: 'Internship' },
                  { value: 'freelance', label: 'Freelance' },
                  { value: 'temporary', label: 'Temporary' },
                ] as const}
                onChange={(employmentType) => update({ employmentType })}
              />
              <CheckboxField
                label="I currently work here"
                checked={entry.current}
                onChange={(current) => update({ current })}
              />
              <TextArea
                label="Description"
                value={str(entry.description)}
                onChange={(description) => update({ description })}
              />
            </>
          )}
        />
      </Section>

      <Section title="Education">
        <ListEditor<EducationEntry>
          items={profile.education}
          onChange={(education) => onChange({ ...profile, education })}
          create={() => ({ school: '', degree: '', fieldOfStudy: '' })}
          addLabel="Add a school"
          emptyLabel="No schools yet."
          render={(entry, update) => (
            <>
              <TextField label="School" value={entry.school} onChange={(school) => update({ school })} />
              <TextField label="Degree" value={entry.degree} onChange={(degree) => update({ degree })} />
              <TextField
                label="Field of study"
                value={entry.fieldOfStudy}
                onChange={(fieldOfStudy) => update({ fieldOfStudy })}
              />
              <TextField label="GPA" value={str(entry.gpa)} onChange={(gpa) => update({ gpa })} />
              <TextField
                label="Start date"
                hint="YYYY-MM"
                value={str(entry.startDate)}
                onChange={(startDate) => update({ startDate })}
              />
              <TextField
                label="End date"
                hint="YYYY-MM"
                value={str(entry.endDate)}
                onChange={(endDate) => update({ endDate })}
              />
            </>
          )}
        />
      </Section>

      <Section title="Skills">
        <TextArea
          label="Skills"
          hint="comma separated"
          value={profile.skills.join(', ')}
          onChange={(value) =>
            onChange({
              ...profile,
              skills: value
                .split(',')
                .map((skill) => skill.trim())
                .filter(Boolean),
            })
          }
        />
      </Section>

      <Section title="Work authorisation">
        <TextField
          label="Authorised to work in"
          hint="ISO codes, comma separated"
          value={profile.workAuth.authorizedIn.join(', ')}
          onChange={(value) =>
            onChange({
              ...profile,
              workAuth: {
                ...profile.workAuth,
                authorizedIn: value
                  .split(',')
                  .map((code) => code.trim().toUpperCase())
                  .filter(Boolean),
              },
            })
          }
        />
        <TextField
          label="Visa status"
          value={str(profile.workAuth.visaStatus)}
          onChange={(visaStatus) => onChange({ ...profile, workAuth: { ...profile.workAuth, visaStatus } })}
        />
        <CheckboxField
          label="I require visa sponsorship"
          checked={profile.workAuth.requiresSponsorship}
          onChange={(requiresSponsorship) =>
            onChange({ ...profile, workAuth: { ...profile.workAuth, requiresSponsorship } })
          }
        />
      </Section>

      <Section title="Preferences">
        <TextField
          label="Desired salary"
          type="number"
          value={profile.preferences.desiredSalary ? String(profile.preferences.desiredSalary.amount) : ''}
          onChange={(value) => {
            const amount = Number(value);
            onChange({
              ...profile,
              preferences: {
                ...profile.preferences,
                desiredSalary: Number.isFinite(amount) && value !== ''
                  ? {
                      amount,
                      currency: profile.preferences.desiredSalary?.currency ?? 'USD',
                      period: profile.preferences.desiredSalary?.period ?? 'year',
                    }
                  : undefined,
              },
            });
          }}
        />
        <TextField
          label="Currency"
          value={profile.preferences.desiredSalary?.currency ?? ''}
          onChange={(currency) =>
            onChange({
              ...profile,
              preferences: {
                ...profile.preferences,
                desiredSalary: profile.preferences.desiredSalary
                  ? { ...profile.preferences.desiredSalary, currency }
                  : undefined,
              },
            })
          }
        />
        {/* Asked beside the expected figure on most applications outside the US. */}
        <TextField
          label="Current salary / CTC"
          type="number"
          value={
            profile.preferences.currentSalary ? String(profile.preferences.currentSalary.amount) : ''
          }
          onChange={(value) => {
            const amount = Number(value);
            onChange({
              ...profile,
              preferences: {
                ...profile.preferences,
                currentSalary:
                  Number.isFinite(amount) && value !== ''
                    ? { amount, currency: profile.preferences.currentSalary?.currency ?? 'USD' }
                    : undefined,
              },
            });
          }}
        />
        <TextField
          label="Current salary currency"
          value={profile.preferences.currentSalary?.currency ?? ''}
          onChange={(currency) =>
            onChange({
              ...profile,
              preferences: {
                ...profile.preferences,
                currentSalary: profile.preferences.currentSalary
                  ? { ...profile.preferences.currentSalary, currency }
                  : undefined,
              },
            })
          }
        />
        <TextField
          label="Notice period"
          hint="in your own words, e.g. “2 months” or “Immediate”"
          value={str(profile.preferences.noticePeriod)}
          onChange={(noticePeriod) =>
            onChange({ ...profile, preferences: { ...profile.preferences, noticePeriod } })
          }
        />
        {/* Forms that ask "Available to join (in days)" need a number, not prose.
            Fill either box — whichever is missing is worked out from the other. */}
        <TextField
          label="Available to join (days)"
          type="number"
          hint="fills “Available To Join (in days)”; leave blank to derive it from the line above"
          value={
            profile.preferences.noticePeriodDays === undefined
              ? ''
              : String(profile.preferences.noticePeriodDays)
          }
          onChange={(value) => {
            const days = Number(value);
            onChange({
              ...profile,
              preferences: {
                ...profile.preferences,
                noticePeriodDays:
                  value !== '' && Number.isFinite(days) && days >= 0 ? days : undefined,
              },
            });
          }}
        />
        <TextArea
          label="Preferred work locations"
          hint="comma separated — the cities you want to work in, not where you live"
          value={profile.preferences.preferredLocations.join(', ')}
          onChange={(value) =>
            onChange({
              ...profile,
              preferences: {
                ...profile.preferences,
                preferredLocations: value
                  .split(',')
                  .map((city) => city.trim())
                  .filter(Boolean),
              },
            })
          }
        />
        <TextField
          label="Earliest start date"
          hint="YYYY-MM-DD"
          value={str(profile.preferences.earliestStartDate)}
          onChange={(earliestStartDate) =>
            onChange({ ...profile, preferences: { ...profile.preferences, earliestStartDate } })
          }
        />
        <SelectField
          label="Remote preference"
          value={profile.preferences.remotePreference ?? ''}
          options={[
            { value: 'remote', label: 'Remote' },
            { value: 'hybrid', label: 'Hybrid' },
            { value: 'onsite', label: 'On-site' },
            { value: 'flexible', label: 'Flexible' },
          ] as const}
          onChange={(remotePreference) =>
            onChange({ ...profile, preferences: { ...profile.preferences, remotePreference } })
          }
        />
        <CheckboxField
          label="Willing to relocate"
          checked={profile.preferences.willingToRelocate ?? false}
          onChange={(willingToRelocate) =>
            onChange({ ...profile, preferences: { ...profile.preferences, willingToRelocate } })
          }
        />
      </Section>

      <DocumentsSection profile={profile} onChange={onChange} onSaved={onSaved} />
      <EeoSection profile={profile} onChange={onChange} />
    </div>
  );
}

/**
 * Voluntary self-identification (ARCHITECTURE.md §4).
 *
 * Every field defaults to declining, "decline" is stated as a legally valid
 * answer, and nothing here is ever inferred from a name or anything else.
 */
function EeoSection({ profile, onChange }: { profile: Profile; onChange: (next: Profile) => void }) {
  const eeo = profile.eeo ?? {
    gender: 'decline' as const,
    race: 'decline' as const,
    ethnicity: 'decline' as const,
    veteranStatus: 'decline' as const,
    disabilityStatus: 'decline' as const,
  };

  const label = (value: string) =>
    value === 'decline'
      ? 'Decline to self-identify'
      : value.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());

  const set = <K extends keyof typeof eeo>(key: K, value: (typeof eeo)[K]) =>
    onChange({ ...profile, eeo: { ...eeo, [key]: value } });

  return (
    <Section
      title="Voluntary self-identification"
      description="US employers must offer these questions and must accept a declined answer. Every option here, including declining, is legally valid. AutoFill never guesses these — they stay as you set them, and they are only filled if you turn the setting on."
    >
      {(Object.keys(EEO_OPTIONS) as Array<keyof typeof EEO_OPTIONS>).map((field) => (
        <SelectField
          key={field}
          label={label(field.replace(/([A-Z])/g, ' $1'))}
          value={eeo[field]}
          options={EEO_OPTIONS[field].map((option) => ({ value: option, label: label(option) }))}
          onChange={(value) => set(field, value as never)}
        />
      ))}
    </Section>
  );
}

function DocumentsSection({
  profile,
  onChange,
  onSaved,
}: {
  profile: Profile;
  onChange: (next: Profile) => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [note, setNote] = useState<string | undefined>();

  const upload = async (slot: 'resume' | 'coverLetter', file: File) => {
    setBusy('Uploading…');
    setError(undefined);
    setNote(undefined);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());

      // Text extraction runs here, not in the worker: pdf.js needs a Worker,
      // which an MV3 service worker cannot spawn (§7, documents/pdf-text.ts).
      let parsedText: string | undefined;
      if (slot === 'resume') {
        setBusy('Reading the document…');
        const extracted = await extractDocumentText(
          bytes,
          file.type || '',
          file.name,
        ).catch(() => undefined);
        parsedText = extracted?.text;
      }

      await sendToBackground('documents:put', {
        slot,
        filename: file.name,
        mimeType: file.type || 'application/octet-stream',
        base64: toBase64(bytes),
        ...(parsedText ? { parsedText } : {}),
      });

      if (slot === 'resume') {
        setNote(
          parsedText
            ? `Read ${parsedText.length.toLocaleString()} characters — you can build your profile from it below.`
            : 'Uploaded. Text could not be extracted from this file type, so answer drafts will not be able to quote it.',
        );
      }
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(undefined);
    }
  };

  /** M6 — "Upload a PDF, get a populated profile" (§9). */
  const bootstrapFromResume = async () => {
    const resumeText = profile.documents.resume?.parsedText;
    if (!resumeText) return;

    setBusy('Reading your résumé…');
    setError(undefined);
    setNote(undefined);
    try {
      const { profile: proposed, added } = await sendToBackground('profile:from-resume', {
        resumeText,
      });
      onChange(proposed);
      setNote(
        `Added ${added.work} role(s), ${added.education} school(s) and ${added.skills} skill(s). ` +
          'Nothing you had already entered was changed. Review it, then press Save profile.',
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(undefined);
    }
  };

  const slots: Array<{ slot: 'resume' | 'coverLetter'; label: string }> = [
    { slot: 'resume', label: 'Résumé / CV' },
    { slot: 'coverLetter', label: 'Cover letter' },
  ];

  return (
    <Section title="Documents" description="Stored encrypted on this device, attached at fill time.">
      {slots.map(({ slot, label }) => (
        <label key={slot}>
          <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">{label}</span>
          <input
            type="file"
            disabled={!!busy}
            accept={slot === 'resume' ? '.pdf,.txt,.md,application/pdf,text/plain' : undefined}
            className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border file:border-slate-300 file:bg-white file:px-3 file:py-1.5 file:text-sm"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(slot, file);
            }}
          />
          <span className="mt-1 block text-xs text-slate-500">
            {profile.documents[slot]?.filename ?? 'Nothing uploaded yet'}
          </span>
        </label>
      ))}

      {profile.documents.resume?.parsedText && (
        <div className="sm:col-span-2">
          <Button variant="secondary" disabled={!!busy} onClick={() => void bootstrapFromResume()}>
            {busy ?? 'Build my profile from this résumé'}
          </Button>
          <p className="mt-2 text-xs text-slate-500">
            Sends your résumé text to Anthropic with your own API key, and fills in only the fields
            you have left blank. Requires AI assistance to be set up.
          </p>
        </div>
      )}

      {busy && !profile.documents.resume?.parsedText && (
        <p className="sm:col-span-2 text-sm text-slate-500">{busy}</p>
      )}
      {note && (
        <div className="sm:col-span-2">
          <Banner tone="success">{note}</Banner>
        </div>
      )}
      {error && (
        <div className="sm:col-span-2">
          <Banner tone="error">{error}</Banner>
        </div>
      )}
    </Section>
  );
}

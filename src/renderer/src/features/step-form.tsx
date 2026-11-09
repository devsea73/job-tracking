import { useEffect, useMemo, useState } from 'react';
import { CalendarPlus } from 'lucide-react';
import type { Stage, StepStage } from '@shared/constants';
import { isOutcomeStage, STEP_STAGES } from '@shared/constants';
import type { Step } from '@shared/api';
import { interviewsEndedBy } from '@shared/pipeline';
import { IconLabel, STAGE_ICONS } from '@/components/symbols';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/field';
import { Notice, Tooltip } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { errorMessage, useSaveStep } from '@/lib/api';
import { formatDateTime, localTimeZone, toLocalInputValue } from '@/lib/utils';

/** What usually comes next: another round of the same interview, or the one after the screen. */
function nextStage(current: Stage): StepStage {
  if (current === 'Recruiter Screen' || current === 'Technical Interview') return 'Technical Interview';
  if (current === 'Final Interview') return 'Final Interview';
  return 'Recruiter Screen';
}

const pad = (value: number) => String(value).padStart(2, '0');
const today = () => toLocalInputValue(new Date().toISOString()).split('T')[0];
const nowClock = () => {
  const now = new Date();
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
};

/**
 * A step on an application's timeline: its stage, and when it takes place, typed in this
 * computer's local time and kept as a UTC instant with the zone it was entered in. An interview is
 * a step at an interview stage, so a third technical round is a third Technical Interview step. An
 * offer or a rejection ends the process: the interviews after it come off, and the form says which.
 */
export function StepFormDialog({
  open,
  onOpenChange,
  applicationId,
  step,
  current = 'Applied',
  steps
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  applicationId: number;
  /** The step being changed; none to add one. */
  step?: Step | null;
  /** The application's stage now, which picks the stage offered first. */
  current?: Stage;
  /** The whole timeline, when known, to say beforehand what an offer or rejection takes off it. */
  steps?: Step[];
}) {
  const [stage, setStage] = useState<StepStage>('Recruiter Screen');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [note, setNote] = useState('');
  const save = useSaveStep();
  const toast = useToast();

  useEffect(() => {
    if (!open) return;
    save.reset();
    if (step) {
      const [day, clock] = toLocalInputValue(step.at).split('T');
      setStage(step.stage);
      setDate(day);
      setTime(clock);
      setNote(step.note ?? '');
    } else {
      setStage(nextStage(current));
      setDate('');
      setTime('10:00');
      setNote('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, step]);

  const outcome = isOutcomeStage(stage);
  const at = date && time ? new Date(`${date}T${time}`) : null;
  const ending = useMemo(() => (at && steps ? interviewsEndedBy(steps, { stage, at: at.toISOString(), id: step?.id }) : []), [at?.getTime(), steps, stage, step?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (value: StepStage) => {
    setStage(value);
    // An offer or a rejection is usually written down the day it comes.
    if (!step && isOutcomeStage(value) && !date) {
      setDate(today());
      setTime(nowClock());
    }
  };

  const submit = () => {
    if (!at) return;
    save.mutate(
      { applicationId, stepId: step?.id, input: { stage, at: at.toISOString(), timezone: localTimeZone(), note: note.trim() || null } },
      {
        onSuccess: (saved) => {
          onOpenChange(false);
          if (saved.removed.length > 0) toast.show(`${saved.removed.length === 1 ? 'The interview' : `${saved.removed.length} interviews`} after it came off the timeline.`);
        }
      }
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      className="max-w-md"
      title={step ? 'Change this step' : 'Add a step'}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={!at || Number.isNaN(at.getTime())} onClick={submit}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Stage">
          <Select
            className="w-full"
            ariaLabel="Stage"
            value={stage}
            onChange={(value) => pick(value as StepStage)}
            options={STEP_STAGES.map((value) => ({ value, label: <IconLabel icon={STAGE_ICONS[value]}>{value}</IconLabel> }))}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={outcome ? 'Date it came' : 'Date'} htmlFor="step-date">
            <Input id="step-date" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </Field>
          <Field label="Time" htmlFor="step-time" hint={localTimeZone()}>
            <Input id="step-time" type="time" value={time} onChange={(event) => setTime(event.target.value)} />
          </Field>
        </div>
        <Field label="Note (optional)" htmlFor="step-note">
          <Textarea
            id="step-note"
            rows={3}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder={outcome ? 'Salary, start date, the reason given' : "Who you're meeting, video link, what to prepare"}
          />
        </Field>
        {ending.length > 0 ? (
          <Notice kind="warning" title={`${stage === 'Offer' ? 'An offer' : 'A rejection'} ends the process`}>
            {ending.length === 1 ? 'This interview comes after it, so it comes off the timeline: ' : `These ${ending.length} interviews come after it, so they come off the timeline: `}
            {ending.map((later) => `${later.stage}, ${formatDateTime(later.at)}`).join('; ')}.
          </Notice>
        ) : null}
        {save.isError ? <Notice kind="error">{errorMessage(save.error)}</Notice> : null}
      </div>
    </Dialog>
  );
}

/** A small button that opens the step form for one of your applications. */
export function AddStepButton({ applicationId, current, steps, size = 'icon-sm' }: { applicationId: number; current: Stage; steps?: Step[]; size?: 'icon-sm' | 'icon' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tooltip content="Add a step: an interview, an offer or a rejection">
        <Button
          size={size}
          variant="ghost"
          aria-label="Add a step"
          onClick={(event) => {
            event.stopPropagation();
            setOpen(true);
          }}
        >
          <CalendarPlus />
        </Button>
      </Tooltip>
      <StepFormDialog open={open} onOpenChange={setOpen} applicationId={applicationId} current={current} steps={steps} />
    </>
  );
}

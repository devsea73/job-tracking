import { useEffect, useState } from 'react';
import type { Interview } from '@shared/api';
import { INTERVIEW_STAGES, type InterviewStage } from '@shared/constants';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/field';
import { Notice } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { errorMessage, useSaveInterview } from '@/lib/api';
import { localTimeZone, toLocalInputValue } from '@/lib/utils';

/**
 * Times are typed in this computer's local time and sent as UTC instants, along with the
 * timezone they were entered in. Anyone viewing later sees them in their own local time.
 */
export function InterviewFormDialog({
  open,
  onOpenChange,
  applicationId,
  interview
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  applicationId: number;
  interview?: Interview | null;
}) {
  const [stage, setStage] = useState<InterviewStage>('Recruiter Screen');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [note, setNote] = useState('');
  const save = useSaveInterview();

  useEffect(() => {
    if (!open) return;
    save.reset();
    if (interview) {
      const [day, clock] = toLocalInputValue(interview.scheduledAt).split('T');
      setStage(interview.stage);
      setDate(day);
      setTime(clock);
      setNote(interview.note ?? '');
    } else {
      setStage('Recruiter Screen');
      setDate('');
      setTime('10:00');
      setNote('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, interview]);

  const submit = () => {
    const scheduled = new Date(`${date}T${time}`);
    save.mutate(
      {
        applicationId,
        interviewId: interview?.id,
        input: { stage, scheduledAt: scheduled.toISOString(), timezone: localTimeZone(), note: note.trim() || null }
      },
      { onSuccess: () => onOpenChange(false) }
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      className="max-w-md"
      title={interview ? 'Edit interview' : 'Schedule interview'}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={!date || !time} onClick={submit}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Interview stage">
          <Select className="w-full" ariaLabel="Interview stage" value={stage} onChange={(value) => setStage(value as InterviewStage)} options={INTERVIEW_STAGES.map((value) => ({ value, label: value }))} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date" htmlFor="interview-date">
            <Input id="interview-date" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </Field>
          <Field label="Time" htmlFor="interview-time" hint={localTimeZone()}>
            <Input id="interview-time" type="time" value={time} onChange={(event) => setTime(event.target.value)} />
          </Field>
        </div>
        <Field label="Note (optional)" htmlFor="interview-note">
          <Textarea id="interview-note" rows={3} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Who you're meeting, video link, what to prepare" />
        </Field>
        {save.isError ? <Notice kind="error">{errorMessage(save.error)}</Notice> : null}
      </div>
    </Dialog>
  );
}

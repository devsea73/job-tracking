import { useCallback } from 'react';
import { useToast } from '@/components/ui/toast';

/** Links in the app are copied, never opened: the person pastes them where they like. */
export function useCopyLink(): (url: string) => void {
  const toast = useToast();
  return useCallback(
    (url: string) => {
      void window.jobTracker.copyLink(url).then((copied) => toast.show(copied ? 'Link copied' : 'That link cannot be copied.', copied ? 'success' : 'error'));
    },
    [toast]
  );
}

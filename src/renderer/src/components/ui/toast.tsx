import { AlertTriangle, CheckCircle2, X } from 'lucide-react';
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface Toast {
  id: number;
  kind: 'success' | 'error';
  message: string;
}

const ToastContext = createContext<{ show: (message: string, kind?: Toast['kind']) => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);
  const show = useCallback(
    (message: string, kind: Toast['kind'] = 'success') => {
      const id = nextId.current;
      nextId.current += 1;
      setToasts((current) => [...current.slice(-3), { id, kind, message }]);
      setTimeout(() => dismiss(id), kind === 'error' ? 7_000 : 3_500);
    },
    [dismiss]
  );
  const value = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[70] flex w-80 flex-col gap-2" aria-live="polite">
        {toasts.map((toast) => {
          const Icon = toast.kind === 'error' ? AlertTriangle : CheckCircle2;
          return (
            <div key={toast.id} className={cn('pointer-events-auto flex items-start gap-2 rounded-lg border border-border bg-surface px-3 py-2.5 shadow-panel')}>
              <Icon className={cn('mt-0.5 size-4 shrink-0', toast.kind === 'error' ? 'text-danger' : 'text-success-ink')} aria-hidden />
              <p className="selectable min-w-0 flex-1 text-ink">{toast.message}</p>
              <button type="button" aria-label="Dismiss" className="text-ink-3 hover:text-ink" onClick={() => dismiss(toast.id)}>
                <X className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): { show: (message: string, kind?: 'success' | 'error') => void } {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside ToastProvider');
  return context;
}

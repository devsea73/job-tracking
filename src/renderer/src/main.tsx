import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ToastProvider } from './components/ui/toast';
import { ApiRequestError } from './lib/api';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Live events from the host refresh the data; this just covers anything missed while offline.
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      retry: (failures, error) => {
        // "Not found" or "not allowed" will not change by asking again.
        if (error instanceof ApiRequestError && error.status >= 400 && error.status < 500) return false;
        return failures < 2;
      }
    }
  }
});

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <App />
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>
);

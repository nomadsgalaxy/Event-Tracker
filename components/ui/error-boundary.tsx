'use client';

import * as React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

// ErrorBoundary — a reusable React error boundary (DESIGN_ALIGNMENT: the source's EitErrorBoundary,
// index.html ~L28606). A render throw inside `children` degrades to an inline message + Retry instead
// of white-screening the surface. React requires a CLASS for getDerivedStateFromError/componentDidCatch.
// Reset by remounting (pass a changing `resetKey`, e.g. the active tab id) OR via the Retry button.

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** A label for the message ("this tab"). */
  label?: string;
  /** When this value changes, the boundary resets (clears the caught error). */
  resetKey?: string | number;
}

interface ErrorBoundaryState {
  err: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { err: null };
  }

  static getDerivedStateFromError(err: Error): ErrorBoundaryState {
    return { err };
  }

  componentDidUpdate(prev: ErrorBoundaryProps) {
    // Reset when the resetKey changes (e.g. switching tabs remounts the boundary's scope).
    if (this.state.err && prev.resetKey !== this.props.resetKey) {
      this.setState({ err: null });
    }
  }

  componentDidCatch(err: Error, info: React.ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error('[EIT] UI error boundary caught:', err, info?.componentStack);
  }

  render() {
    if (this.state.err) {
      return (
        <div
          className="flex flex-col gap-3 rounded-lg border border-dashed p-4"
          style={{ borderColor: 'var(--destructive)' }}
          role="alert"
        >
          <div className="flex items-center gap-2">
            <AlertTriangle size={18} aria-hidden style={{ color: 'var(--destructive)' }} />
            <p className="text-sm font-semibold text-foreground">
              Something went wrong rendering {this.props.label || 'this view'}.
            </p>
          </div>
          <p className="text-xs text-muted-foreground">
            The rest of the app is unaffected — details are in the browser console.
          </p>
          <div>
            <Button variant="outline" size="sm" onClick={() => this.setState({ err: null })}>
              Retry
            </Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;

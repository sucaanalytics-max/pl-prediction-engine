"use client";

import { Component, type ReactNode, type ErrorInfo } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Optional fallback component */
  fallback?: ReactNode;
  /** Page name for error context */
  pageName?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[ErrorBoundary${this.props.pageName ? ` — ${this.props.pageName}` : ""}]`, error, info);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
    // Also trigger a page-level refetch if available
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      return (
        <div className="card p-8 text-center space-y-4">
          <div className="text-[var(--error)] font-display font-bold text-lg">
            Something went wrong
          </div>
          <p className="text-sm text-[var(--text-3)] max-w-md mx-auto">
            {this.state.error?.message ?? "An unexpected error occurred."}
          </p>
          {this.props.pageName && (
            <p className="text-[10px] text-slate-600">Page: {this.props.pageName}</p>
          )}
          <button
            onClick={this.handleRetry}
            className="inline-flex items-center gap-2 px-4 py-2 text-[var(--bg)] rounded-none text-sm font-medium transition-colors"
            style={{ background: "var(--accent)" }}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Retry
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

/** Loading skeleton for pages waiting on data */
export function PageSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-4">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="card p-6 animate-pulse">
          <div className="skeleton h-4 w-1/3 mb-3" />
          <div className="skeleton h-3 w-full mb-2" />
          <div className="skeleton h-3 w-2/3" />
        </div>
      ))}
    </div>
  );
}

function classifyError(message: string): { type: string; hint: string } {
  const msg = message.toLowerCase();
  if (msg.includes("fetch") || msg.includes("network") || msg.includes("failed to load") || msg.includes("aborterror")) {
    return { type: "Network Error", hint: "Check your internet connection and try again." };
  }
  if (msg.includes("json") || msg.includes("parse") || msg.includes("unexpected token")) {
    return { type: "Data Error", hint: "The server returned invalid data. The pipeline may need to re-run." };
  }
  if (msg.includes("404") || msg.includes("not found")) {
    return { type: "Not Found", hint: "The requested data file was not found. Run the prediction pipeline first." };
  }
  return { type: "Error", hint: "An unexpected error occurred." };
}

/** Error message component (non-boundary, for inline use) */
export function ErrorMessage({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  const { type, hint } = classifyError(message);
  return (
    <div className="card p-8 text-center">
      <p className="text-[var(--error)] font-display font-bold text-lg">{type}</p>
      <p className="text-sm text-[var(--text-3)] mt-1">{hint}</p>
      <p className="text-[10px] text-slate-600 mt-2 font-mono">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-4 px-4 py-2 text-[var(--bg)] rounded-none text-sm font-medium transition-colors"
            style={{ background: "var(--accent)" }}
        >
          Retry
        </button>
      )}
    </div>
  );
}

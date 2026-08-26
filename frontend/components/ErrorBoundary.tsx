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
            <p className="text-[11px] text-slate-600">Page: {this.props.pageName}</p>
          )}
          <button
            onClick={this.handleRetry}
            className="inline-flex items-center gap-2 px-4 py-2 text-[var(--bg)] rounded-none text-sm font-medium transition-colors"
            style={{ background: "var(--brand)" }}
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

// `PageSkeleton` was here — a shimmering row placeholder for a loading state this
// app does not have. Every screen renders from an `Artifact<T>` whose `absent` and
// `unreadable` states say WHAT is missing and why; a generic skeleton is the one
// thing that says nothing, which is why nothing ever imported it.
